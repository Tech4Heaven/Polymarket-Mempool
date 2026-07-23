import { JsonRpcProvider } from "ethers";
import type { AppConfig } from "./env.js";
import {
  allowedUserIds,
  answerCallback,
  editTelegramKeyboard,
  editTelegramMessage,
  sendTelegramKeyboard,
  sendTelegramTo,
  telegramConfig,
  type InlineKeyboard,
} from "./telegram.js";
import { buildTargetPnlReport, discoverBots, type BotRef } from "./targetPnl.js";
import { fetchAllBalances, formatBalancesMessage, loadWalletList } from "./walletBalances.js";

const CHECKED = "✅";
const UNCHECKED = "⬜️";

/** Checkbox keyboard for /pnl: one toggle row per bot, then All/None, then Show. */
function pnlKeyboard(bots: BotRef[], selected: Set<number>): InlineKeyboard {
  const rows: InlineKeyboard = bots.map((b, i) => [
    { text: `${selected.has(i) ? CHECKED : UNCHECKED} ${b.name}`, callback_data: `pnl:t:${i}` },
  ]);
  rows.push([
    { text: "All", callback_data: "pnl:all" },
    { text: "None", callback_data: "pnl:none" },
  ]);
  rows.push([{ text: "📊 Show P&L", callback_data: "pnl:go" }]);
  return rows;
}

/**
 * Telegram command listener (long-poll getUpdates). Handles `/balance` by reporting every deployment
 * wallet — addresses read live from each sibling folder's .env (cash + open-positions value + total).
 *
 * ACCESS CONTROL: a bot username is publicly discoverable, so ANY stranger can message it. Every
 * update is therefore checked against an allowlist of Telegram user ids (see allowedUserIds) and
 * anything else is dropped with no reply at all — a silent drop leaks nothing, not even that the
 * command exists. If the allowlist cannot be determined the listener does not start.
 *
 * SINGLE LISTENER: only ONE process may poll getUpdates for a given bot token — a second poller gets
 * HTTP 409 Conflict. All deployments share one token, so set
 *
 *     TELEGRAM_COMMAND_LISTENER=<the BOT_NAME that should listen>   e.g. "Main"
 *
 * That exact line is safe to copy into EVERY deployment's .env: each bot listens only when the value
 * matches its own BOT_NAME, so the identical config yields exactly one listener. ("true" is also
 * accepted, but then the flag must appear in one .env only — copying it around causes 409 storms.)
 * Every bot still SENDS resolution cards; this only governs who RECEIVES commands.
 */
export function startTelegramCommandListener(config: AppConfig): { stop: () => void } {
  const tg = telegramConfig();
  if (!tg) {
    return { stop: () => undefined };
  }
  const flag = process.env["TELEGRAM_COMMAND_LISTENER"]?.trim() ?? "";
  const me = process.env["BOT_NAME"]?.trim() ?? "";
  // Listen when explicitly "true", or when the flag names THIS bot — the latter lets one identical
  // .env line be copied everywhere while still electing a single listener.
  const shouldListen = flag === "true" || (flag !== "" && flag === me);
  if (!shouldListen) {
    console.info(
      `telegram commands: listener disabled here (TELEGRAM_COMMAND_LISTENER=${flag || "unset"}, BOT_NAME=${me || "unset"})`
    );
    return { stop: () => undefined };
  }

  const allowed = allowedUserIds(tg.chatId);
  if (allowed.size === 0) {
    console.warn(
      "telegram commands: no authorized users (set TELEGRAM_ALLOWED_USER_IDS) — listener NOT started"
    );
    return { stop: () => undefined };
  }

  const provider = new JsonRpcProvider(config.polygonMempoolHttpUrl);
  const warnedStrangers = new Set<string>(); // log each unauthorized id once, not on every poke
  // /pnl checkbox state: `${chatId}:${messageId}` → selected bot indices (into discoverBots() order).
  const pnlSel = new Map<string, Set<number>>();
  let warnedConflict = false;
  let offset = 0;
  let stopped = false;

  const handleText = async (chatId: string, text: string): Promise<void> => {
    const cmd = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, "") ?? "";
    if (cmd === "/balance" || cmd === "/balances") {
      const refs = await loadWalletList(config);
      if (refs.length === 0) {
        await sendTelegramTo(chatId, "No wallets found (no deployment .env with FUNDER_ADDRESS).");
        return;
      }
      const rows = await fetchAllBalances(provider, refs);
      await sendTelegramTo(chatId, formatBalancesMessage(rows));
    } else if (cmd === "/pnl") {
      const bots = await discoverBots();
      if (bots.length === 0) {
        await sendTelegramTo(chatId, "No bots found.");
        return;
      }
      const selected = new Set(bots.map((_, i) => i)); // default: all selected
      const msgId = await sendTelegramKeyboard(chatId, "Select bots, then tap Show P&L:", pnlKeyboard(bots, selected));
      if (msgId !== null) {
        pnlSel.set(`${chatId}:${msgId}`, selected);
      }
    } else if (cmd === "/start" || cmd === "/help") {
      await sendTelegramTo(
        chatId,
        "Commands:\n/balance — cash + open positions for every wallet\n/pnl — realized P&L per active target (pick bots)"
      );
    }
    // unknown commands: ignore silently
  };

  const handleCallback = async (cbId: string, chatId: string, messageId: number, data: string): Promise<void> => {
    const bots = await discoverBots();
    const key = `${chatId}:${messageId}`;
    let sel = pnlSel.get(key) ?? new Set(bots.map((_, i) => i));
    if (data === "pnl:all") {
      sel = new Set(bots.map((_, i) => i));
    } else if (data === "pnl:none") {
      sel = new Set();
    } else if (data.startsWith("pnl:t:")) {
      const i = Number(data.slice("pnl:t:".length));
      if (Number.isInteger(i)) {
        if (sel.has(i)) {
          sel.delete(i);
        } else {
          sel.add(i);
        }
      }
    } else if (data === "pnl:go") {
      const chosen = bots.filter((_, i) => sel.has(i));
      if (chosen.length === 0) {
        await answerCallback(cbId, "Select at least one bot");
        return;
      }
      await answerCallback(cbId, "Computing…");
      const report = await buildTargetPnlReport(chosen);
      await editTelegramMessage(chatId, messageId, report); // replaces the picker with the report
      pnlSel.delete(key);
      return;
    } else {
      await answerCallback(cbId);
      return;
    }
    pnlSel.set(key, sel);
    await editTelegramKeyboard(chatId, messageId, pnlKeyboard(bots, sel));
    await answerCallback(cbId);
  };

  const poll = async (): Promise<void> => {
    while (!stopped) {
      try {
        const url = new URL(`https://api.telegram.org/bot${tg.token}/getUpdates`);
        url.searchParams.set("timeout", "30");
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
        // Abort a bit after the server-side long-poll window so a dead socket can't wedge the loop.
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 40_000);
        let json: { ok?: boolean; result?: unknown[] };
        try {
          const res = await fetch(url, { signal: ac.signal });
          if (!res.ok) {
            if (res.status === 409) {
              // Another process owns the feed. Log once and back off hard — a misconfigured fleet
              // would otherwise spam the error log every few seconds forever.
              if (!warnedConflict) {
                warnedConflict = true;
                console.warn(
                  "[telegram] getUpdates 409 Conflict — another process is polling this token. " +
                    "Set TELEGRAM_COMMAND_LISTENER to a single BOT_NAME across deployments. Backing off."
                );
              }
              await sleep(60_000);
              continue;
            }
            await sleep(5_000);
            continue;
          }
          warnedConflict = false;
          json = (await res.json()) as { ok?: boolean; result?: unknown[] };
        } finally {
          clearTimeout(t);
        }
        for (const u of json.result ?? []) {
          const upd = u as {
            update_id?: number;
            message?: { text?: string; chat?: { id?: number }; from?: { id?: number; username?: string } };
            callback_query?: {
              id?: string;
              data?: string;
              from?: { id?: number; username?: string };
              message?: { message_id?: number; chat?: { id?: number } };
            };
          };
          if (typeof upd.update_id === "number") {
            offset = upd.update_id + 1; // ack (also ack'd for strangers, so they can't wedge the loop)
          }

          // Inline-keyboard button tap (/pnl checkboxes).
          if (upd.callback_query) {
            const cq = upd.callback_query;
            const cbId = cq.id;
            const cbFrom = cq.from?.id;
            const cbChat = cq.message?.chat?.id;
            const cbMsg = cq.message?.message_id;
            if (typeof cbId !== "string") {
              continue;
            }
            // Same allowlist as messages. Unauthorized: don't even answer (reveal nothing).
            if (typeof cbFrom !== "number" || !allowed.has(String(cbFrom))) {
              if (!warnedStrangers.has(String(cbFrom))) {
                warnedStrangers.add(String(cbFrom));
                console.warn(`[telegram] ignored callback from unauthorized user id=${String(cbFrom)}`);
              }
              continue;
            }
            if (typeof cbChat === "number" && typeof cbMsg === "number" && typeof cq.data === "string") {
              try {
                await handleCallback(cbId, String(cbChat), cbMsg, cq.data);
              } catch (e) {
                console.warn(`[telegram] callback failed: ${e instanceof Error ? e.message : String(e)}`);
                await answerCallback(cbId);
              }
            } else {
              await answerCallback(cbId);
            }
            continue;
          }

          const text = upd.message?.text;
          const chatId = upd.message?.chat?.id;
          const fromId = upd.message?.from?.id;
          if (typeof text !== "string" || typeof chatId !== "number") {
            continue;
          }
          // Access control: drop anything not from an allowlisted user, with NO reply.
          if (typeof fromId !== "number" || !allowed.has(String(fromId))) {
            if (!warnedStrangers.has(String(fromId))) {
              warnedStrangers.add(String(fromId));
              console.warn(
                `[telegram] ignored command from unauthorized user id=${String(fromId)}` +
                  `${upd.message?.from?.username ? ` (@${upd.message.from.username})` : ""}`
              );
            }
            continue;
          }
          try {
            await handleText(String(chatId), text);
          } catch (e) {
            console.warn(`[telegram] command failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/aborted/i.test(msg)) {
          console.warn(`[telegram] getUpdates failed: ${msg}`);
        }
        await sleep(3_000);
      }
    }
  };

  console.info("telegram commands: listening for /balance, /pnl");
  void poll();
  return { stop: () => {
    stopped = true;
  } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms).unref();
  });
}
