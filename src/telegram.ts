/**
 * Minimal Telegram sender. Configured via env:
 *   TELEGRAM_BOT_TOKEN   bot token from @BotFather
 *   TELEGRAM_CHAT_ID     chat/channel id to post to
 * If either is missing the feature is off and sends are no-ops. Plain-text messages (no parse_mode)
 * so the P&L cards with $, +/−, emojis need no escaping. Never throws into the caller.
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

/** Send to a specific chat (e.g. reply to whoever issued a command). Best-effort; never throws. */
export async function sendTelegramTo(chatId: string, text: string): Promise<void> {
  const c = tgConfig();
  if (!c) {
    return;
  }
  const label = botLabel();
  const body = label ? `🤖 ${label}\n\n${text}` : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.warn(`[telegram] sendMessage HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[telegram] send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function sendTelegram(text: string): Promise<void> {
  const c = tgConfig();
  if (!c) {
    return;
  }
  const label = botLabel();
  const body = label ? `🤖 ${label}\n\n${text}` : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.chatId, text: body, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.warn(`[telegram] sendMessage HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[telegram] send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
