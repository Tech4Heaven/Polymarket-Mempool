/**
 * Minimal Telegram sender. Configured via env:
 *   TELEGRAM_BOT_TOKEN         bot token from @BotFather
 *   TELEGRAM_CHAT_ID           chat id to post to (your private chat)
 *   TELEGRAM_ALLOWED_USER_IDS  optional extra user ids allowed to receive/command
 * If token or chat id is missing the feature is off and sends are no-ops. Plain-text messages (no
 * parse_mode) so the P&L cards with $, +/−, emojis need no escaping. Never throws into the caller.
 *
 * CONFIDENTIALITY: everything this module sends — realized P&L per market and per target, wallet
 * balances — is private financial information. Delivery is therefore allowlisted at the transport:
 * sends go ONLY to TELEGRAM_CHAT_ID or an id in TELEGRAM_ALLOWED_USER_IDS, and any other recipient is
 * refused here rather than trusted to callers. That way no future/handler bug can leak a card to a
 * chat id supplied by a stranger.
 */

function tgConfig(): { token: string; chatId: string } | null {
  const token = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const chatId = process.env["TELEGRAM_CHAT_ID"]?.trim();
  return token && chatId ? { token, chatId } : null;
}

/** Per-deployment label (set BOT_NAME in each bot's .env) so one chat can tell the bots apart. */
function botLabel(): string {
  return process.env["BOT_NAME"]?.trim() || "";
}

export function isTelegramEnabled(): boolean {
  return tgConfig() !== null;
}

/** Token + default chat id, or null if unconfigured. Used by the command listener. */
export function telegramConfig(): { token: string; chatId: string } | null {
  return tgConfig();
}

/**
 * Ids allowed to issue commands AND receive messages. Explicit TELEGRAM_ALLOWED_USER_IDS wins;
 * otherwise defaults to TELEGRAM_CHAT_ID when that is a private chat (its id == the owner's user id).
 * An empty set means "nobody" — callers must fail closed, never open up.
 */
export function allowedUserIds(chatId: string): Set<string> {
  const ids = new Set<string>();
  for (const p of (process.env["TELEGRAM_ALLOWED_USER_IDS"] ?? "").split(",")) {
    const t = p.trim();
    if (t) {
      ids.add(t);
    }
  }
  if (ids.size === 0 && chatId && !chatId.startsWith("-")) {
    ids.add(chatId); // private chat id == owner's user id
  }
  return ids;
}

/** True if `chatId` may receive private data: the configured chat, or an allowlisted user id. */
export function isAuthorizedRecipient(chatId: string): boolean {
  const c = tgConfig();
  if (!c) {
    return false;
  }
  return chatId === c.chatId || allowedUserIds(c.chatId).has(chatId);
}

/**
 * Escape text for Telegram HTML parse mode. Only &, <, > are special in HTML mode — $, +, −, ·,
 * emoji all pass through untouched. Apply to every dynamic value interpolated into a message.
 */
export function tgEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wrap a value in a monospace <code> span. On Telegram mobile a single tap on <code> text copies it
 * to the clipboard — use this for full addresses / ids so they can be pasted straight into an explorer.
 */
export function tgCode(s: string): string {
  return `<code>${tgEsc(s)}</code>`;
}

async function post(token: string, chatId: string, text: string): Promise<void> {
  const label = botLabel();
  // Messages are HTML (for tap-to-copy <code>). The label is dynamic, so escape it; `text` is already
  // built HTML-safe by the caller.
  const body = label ? `🤖 ${tgEsc(label)}\n\n${text}` : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.warn(`[telegram] sendMessage HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[telegram] send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Send to a specific chat (e.g. reply to whoever issued a command). Refuses any recipient that is not
 * the configured chat or an allowlisted user — private data never leaves the allowlist.
 */
export async function sendTelegramTo(chatId: string, text: string): Promise<void> {
  const c = tgConfig();
  if (!c) {
    return;
  }
  if (!isAuthorizedRecipient(chatId)) {
    console.warn(`[telegram] refused send to unauthorized chat id=${chatId}`);
    return;
  }
  await post(c.token, chatId, text);
}

/** Send to the configured chat (resolution cards, alerts). */
export async function sendTelegram(text: string): Promise<void> {
  const c = tgConfig();
  if (!c) {
    return;
  }
  await post(c.token, c.chatId, text);
}

/**
 * Warn once at startup if P&L would land somewhere other than a private chat. A negative id is a
 * group/channel, so every member there would see realized P&L and balances.
 */
export function warnIfChatNotPrivate(): void {
  const c = tgConfig();
  if (c && c.chatId.startsWith("-")) {
    console.warn(
      `[telegram] TELEGRAM_CHAT_ID=${c.chatId} is a group/channel — P&L cards and balances will be ` +
        `visible to everyone in it. Use your private chat id to keep them secret.`
    );
  }
}
