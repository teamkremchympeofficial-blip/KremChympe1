// lib/telegram.js
//
// Thin wrapper around the Telegram Bot API. The bot token is read once from
// the environment and is NEVER sent to, or accepted from, the frontend.
// Every call in this file runs on the server only.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = 'https://api.telegram.org';

if (!BOT_TOKEN) {
  // Fail loudly at startup rather than silently dropping notifications later.
  console.error(
    '[telegram] TELEGRAM_BOT_TOKEN is not set. Set it in your environment ' +
    '(see .env.example). The server will start, but no Telegram messages ' +
    'can be sent until this is fixed.'
  );
}

function apiUrl(method) {
  return `${API_BASE}/bot${BOT_TOKEN}/${method}`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generic retry wrapper for transient failures (network blips, Telegram
// rate limiting / 5xx). Does not retry on 4xx errors caused by bad input
// (e.g. invalid chat id) since retrying won't help those.
async function withRetry(fn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.telegramStatus;
      const retriable = !status || status >= 500 || status === 429;
      if (!retriable || attempt === retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[telegram] attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  console.error('[telegram] giving up after retries:', lastErr && lastErr.message);
  throw lastErr;
}

async function parseTelegramError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    // ignore, body wasn't JSON
  }
  const desc = (body && body.description) || res.statusText || 'Unknown Telegram API error';
  const err = new Error(`Telegram API error (${res.status}): ${desc}`);
  err.telegramStatus = res.status;
  err.telegramBody = body;
  return err;
}

/**
 * Send a plain text message to a chat.
 */
async function sendMessage(chatId, text) {
  if (!chatId) {
    throw new Error('No Telegram chat id configured for this tour.');
  }
  return withRetry(async () => {
    const res = await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw await parseTelegramError(res);
    return res.json();
  });
}

/**
 * Send an image (Buffer) as a Telegram photo with a caption, optionally
 * with an inline keyboard (e.g. Confirm/Cancel buttons under the message).
 */
async function sendPhoto(chatId, buffer, filename, caption, replyMarkup) {
  if (!chatId) {
    throw new Error('No Telegram chat id configured for this tour.');
  }
  return withRetry(async () => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([buffer]), filename);

    const res = await fetch(apiUrl('sendPhoto'), { method: 'POST', body: form });
    if (!res.ok) throw await parseTelegramError(res);
    return res.json();
  });
}

/**
 * Send a file (Buffer) as a Telegram document (used for PDF receipts) with
 * a caption.
 */
async function sendDocument(chatId, buffer, filename, caption) {
  if (!chatId) {
    throw new Error('No Telegram chat id configured for this tour.');
  }
  return withRetry(async () => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([buffer]), filename);

    const res = await fetch(apiUrl('sendDocument'), { method: 'POST', body: form });
    if (!res.ok) throw await parseTelegramError(res);
    return res.json();
  });
}

/**
 * Edit the caption of a previously-sent photo message — used to remove the
 * Confirm/Cancel buttons and show the guide's decision once they've acted.
 * replyMarkup may be `{ inline_keyboard: [] }` (or omitted) to clear buttons.
 */
async function editMessageCaption(chatId, messageId, caption, replyMarkup) {
  if (!chatId || !messageId) return null;
  return withRetry(async () => {
    const res = await fetch(apiUrl('editMessageCaption'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption,
        reply_markup: replyMarkup || { inline_keyboard: [] },
      }),
    });
    if (!res.ok) throw await parseTelegramError(res);
    return res.json();
  }, { retries: 1 });
}

/**
 * Acknowledge a button tap so Telegram stops showing the loading spinner on
 * it, with an optional small toast shown to the guide.
 */
async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await fetch(apiUrl('answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined }),
    });
  } catch (err) {
    console.warn('[telegram] answerCallbackQuery failed:', err.message);
  }
}

/**
 * Registers (or re-registers) the webhook Telegram calls when the guide taps
 * a Confirm/Cancel button. Safe to call repeatedly — Telegram just updates
 * the registration. Called once at server startup when PUBLIC_URL is set.
 */
async function setWebhook(publicUrl, secretToken) {
  const url = `${publicUrl.replace(/\/$/, '')}/api/telegram/webhook`;
  const res = await fetch(apiUrl('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      allowed_updates: ['callback_query'],
    }),
  });
  if (!res.ok) throw await parseTelegramError(res);
  return res.json();
}

module.exports = { sendMessage, sendPhoto, sendDocument, editMessageCaption, answerCallbackQuery, setWebhook };
