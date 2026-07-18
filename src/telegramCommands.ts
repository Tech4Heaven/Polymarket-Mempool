import { JsonRpcProvider } from "ethers";
import type { AppConfig } from "./env.js";
import { sendTelegramTo, telegramConfig } from "./telegram.js";
import { fetchAllBalances, formatBalancesMessage, loadWalletList } from "./walletBalances.js";

/**
 * Telegram command listener (long-poll getUpdates). Handles `/balance` by reporting every deployment
 * wallet — addresses read live from each sibling folder's .env (cash + open-positions value + total).
 *
 * IMPORTANT: only ONE process may poll getUpdates for a given bot token — a second poller gets HTTP
 * 409 Conflict. Since all deployments share one token, this listener runs ONLY where
 * TELEGRAM_COMMAND_LISTENER=true (set it in Main's .env only). Every bot still SENDS resolution cards;
 * this only governs who RECEIVES commands.
 */
export function startTelegramCommandListener(config: AppConfig): { stop: () => void } {
  const tg = telegramConfig();
  if (!tg) {
    return { stop: () => undefined };
  }
  if (process.env["TELEGRAM_COMMAND_LISTENER"]?.trim() !== "true") {
    console.info("telegram commands: TELEGRAM_COMMAND_LISTENER not 'true' — listener not started");
    return { stop: () => undefined };
  }

  const provider = new JsonRpcProvider(config.polygonMempoolHttpUrl);
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
    } else if (cmd === "/start" || cmd === "/help") {
      await sendTelegramTo(chatId, "Commands:\n/balance — cash + open positions for every wallet");
    }
    // unknown commands: ignore silently
  };

  const poll = async (): Promise<void> => {
    while (!stopped) {
      try {
        const url = new URL(`https://api.telegram.org/bot${tg.token}/getUpdates`);
        url.searchParams.set("timeout", "30");
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
        // Abort a bit after the server-side long-poll window so a dead socket can't wedge the loop.
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 40_000);
        let json: { ok?: boolean; result?: unknown[] };
        try {
          const res = await fetch(url, { signal: ac.signal });
          if (!res.ok) {
            if (res.status === 409) {
              console.warn("[telegram] getUpdates 409 Conflict — another process is polling this token");
            }
            await sleep(5_000);
            continue;
          }
          json = (await res.json()) as { ok?: boolean; result?: unknown[] };
        } finally {
          clearTimeout(t);
        }
        for (const u of json.result ?? []) {
          const upd = u as { update_id?: number; message?: { text?: string; chat?: { id?: number } } };
          if (typeof upd.update_id === "number") {
            offset = upd.update_id + 1; // ack
          }
          const text = upd.message?.text;
          const chatId = upd.message?.chat?.id;
          if (typeof text === "string" && typeof chatId === "number") {
            try {
              await handleText(String(chatId), text);
            } catch (e) {
              console.warn(`[telegram] command failed: ${e instanceof Error ? e.message : String(e)}`);
            }
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

  console.info("telegram commands: listening for /balance");
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
