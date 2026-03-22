const TELEGRAM_API_BASE = "https://api.telegram.org";

function getTelegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return null;
  }

  return { token, chatId };
}

export function isTelegramEnabled() {
  return Boolean(getTelegramConfig());
}

export async function sendTelegramMessage(text) {
  const config = getTelegramConfig();
  if (!config) {
    return { ok: false, skipped: true, reason: "missing_config" };
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      disable_web_page_preview: true
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Telegram request failed: ${response.status}`);
  }

  return { ok: true };
}
