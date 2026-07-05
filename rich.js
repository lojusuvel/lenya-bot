// === богатые сообщения (telegram bot api 10.1, sendRichMessage) ===
// теперь лёня умеет кидать красиво оформленные сообщения: заголовки, таблицы,
// списки, цитаты, спойлеры, код с подсветкой — всё как люди делают.
// если у кого-то старый телеграм или что-то сломалось — автоматом переключится на обычный текст.

const axios = require('axios');
const config = require('../config');

const API = `https://api.telegram.org/bot${config.telegramToken}`;

// чистим текст для html, чтобы не сломал разметку
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// из html в простой текст — на случай, если богатое сообщение не пройдёт
function htmlToPlain(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n──────────\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<summary[^>]*>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|details|summary|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// чиним markdown перед отправкой — телеграм любит, когда перед таблицей есть пустая строка
function normalizeMd(md = '') {
  const lines = String(md).split('\n');
  const out = [];
  const isRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const isSep = (s) => s.includes('|') && s.includes('-') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = out.length ? out[out.length - 1] : '';
    if (isRow(line) && isSep(lines[i + 1] || '') && prev.trim() !== '' && !isRow(prev)) {
      out.push(''); // вставляем пустую строку перед таблицей
    }
    out.push(line);
  }
  return out.join('\n');
}

// режем длинные сообщения, чтобы телеграм не ругался
function splitChunks(text, size = 4000) {
  return String(text).match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [String(text)];
}

/**
 * отправляет богатое сообщение с авто-подстраховкой
 * @param {object} bot — инстанс node-telegram-bot-api (для фоллбэка)
 * @param {number|string} chatId
 * @param {{html?:string, markdown?:string, fallback?:string}} content — ровно одно из html / markdown
 * @param {{replyTo?:number, threadId?:number, businessId?:string, replyMarkup?:object, silent?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, mode:'rich'|'fallback', error?:string}>}
 */
async function sendRich(bot, chatId, content, opts = {}) {
  const rich = {};
  if (content.html != null) rich.html = content.html;
  else if (content.markdown != null) rich.markdown = content.markdown;
  else throw new Error('sendRich: нужен html или markdown');

  // параметры для нового метода (reply_parameters вместо reply_to_message_id)
  const extra = {};
  if (opts.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  if (opts.threadId) extra.message_thread_id = opts.threadId;
  if (opts.businessId) extra.business_connection_id = opts.businessId;
  if (opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
  if (opts.silent) extra.disable_notification = true;

  // 1) пробуем отправить богато
  try {
    await axios.post(`${API}/sendRichMessage`, { chat_id: chatId, rich_message: rich, ...extra }, { proxy: false });
    return { ok: true, mode: 'rich' };
  } catch (e) {
    const desc = e.response?.data?.description || e.message;

    // если богатое упало из-за картинок — пробуем без них, чтобы сохранить форматирование
    const hasImg = /!\[|<tg-(collage|slideshow)/i.test(content.markdown || '') || /<img|<tg-(collage|slideshow)/i.test(content.html || '');
    if (hasImg && /media|no_media|RICH_MESSAGE/i.test(desc)) {
      const noImg = {};
      if (content.markdown != null) noImg.markdown = content.markdown.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (content.html != null) noImg.html = content.html.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/<img[^>]*>/gi, '');
      try {
        await axios.post(`${API}/sendRichMessage`, { chat_id: chatId, rich_message: noImg, ...extra }, { proxy: false });
        console.error(`[RICH] картинки не пролезли, отправил без них: ${desc}`);
        return { ok: true, mode: 'rich-noimg' };
      } catch (_) { /* падаем в общий фоллбэк */ }
    }

    console.error(`[RICH] sendRichMessage упал, фоллбэк в текст: ${desc}`);

    // 2) фоллбэк — обычный sendMessage
    const legacy = { disable_web_page_preview: true };
    if (opts.replyTo) legacy.reply_to_message_id = opts.replyTo;
    if (opts.threadId) legacy.message_thread_id = opts.threadId;
    if (opts.businessId) legacy.business_connection_id = opts.businessId;
    if (opts.replyMarkup) legacy.reply_markup = opts.replyMarkup;
    if (opts.silent) legacy.disable_notification = true;

    // для markdown пробуем сохранить разметку, если не выйдет — шлём как есть
    if (content.markdown != null && content.fallback == null) {
      for (const chunk of splitChunks(content.markdown)) {
        try {
          await bot.sendMessage(chatId, chunk, { ...legacy, parse_mode: 'Markdown' });
        } catch (_) {
          await bot.sendMessage(chatId, chunk, legacy);
        }
      }
      return { ok: true, mode: 'fallback', error: desc };
    }

    const plain = content.fallback != null ? content.fallback
      : content.html != null ? htmlToPlain(content.html)
      : String(content.markdown || '');
    for (const chunk of splitChunks(plain)) {
      await bot.sendMessage(chatId, chunk, legacy);
    }
    return { ok: true, mode: 'fallback', error: desc };
  }
}

module.exports = { sendRich, htmlToPlain, escapeHtml, normalizeMd };
