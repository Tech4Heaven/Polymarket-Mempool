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

export function isTelegramEnabled(): boolean {
  return tgConfig() !== null;
}

export async function sendTelegram(text: string): Promise<void> {
  const c = tgConfig();
  if (!c) {
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.warn(`[telegram] sendMessage HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[telegram] send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
