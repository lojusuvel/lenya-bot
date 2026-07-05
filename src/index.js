const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const storage = require('./services/storage');
const axios = require('axios');
const { sendRich, escapeHtml } = require('./utils/rich');


const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = String(now.getFullYear()).slice(-2);
  const t = now.toLocaleTimeString('ru-RU', { hour12: false });
  return `${d}.${m}.${y}-${t}`;
}

console.log = (...args) => originalLog(getTimestamp(), ...args);
console.error = (...args) => originalError(getTimestamp(), ...args);


// Создаем бота
const allowedUpdates = [
  'message',
  'edited_message',
  'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
];

const bot = new TelegramBot(config.telegramToken, {
  polling: {
    params: {
      allowed_updates: allowedUpdates,
    },
  },
});

const businessConnections = new Map();

function withBusinessConnection(baseBot, msg) {
  const businessConnectionId = msg.business_connection_id;
  if (!businessConnectionId) return baseBot;

  const businessChatId = String(msg.chat.id);
  const addBusinessOption = (chatId, options = {}) => {
    if (String(chatId) !== businessChatId) return options;
    return { ...options, business_connection_id: businessConnectionId };
  };

  return new Proxy(baseBot, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (chatId, text, options = {}) => target.sendMessage(chatId, text, addBusinessOption(chatId, options));
      }
      if (prop === 'sendChatAction') {
        return (chatId, action, options = {}) => target.sendChatAction(chatId, action, addBusinessOption(chatId, options));
      }
      if (prop === 'setMessageReaction') {
        return (chatId, messageId, options = {}) => target.setMessageReaction(chatId, messageId, addBusinessOption(chatId, options));
      }

      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function isFreshMessage(msg) {
  const now = Math.floor(Date.now() / 1000);
  return !msg.date || msg.date >= now - 120;
}

async function getBusinessConnection(connectionId) {
  if (businessConnections.has(connectionId)) {
    return businessConnections.get(connectionId);
  }

  let connection;
  if (typeof bot.getBusinessConnection === 'function') {
    connection = await bot.getBusinessConnection(connectionId);
  } else {
    const url = `https://api.telegram.org/bot${config.telegramToken}/getBusinessConnection`;
    const response = await axios.post(url, { business_connection_id: connectionId });
    connection = response.data?.result;
  }

  if (connection?.id) {
    businessConnections.set(connection.id, connection);
  }
  return connection;
}

async function shouldProcessBusinessMessage(msg) {
  const connectionId = msg.business_connection_id;
  const chatTitle = msg.chat?.title || msg.chat?.username || msg.chat?.first_name || msg.chat?.id;
  const sender = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || msg.from?.id;
  const text = msg.text || msg.caption || '';
  const hasTrigger = config.triggerRegex.test(text.toLowerCase());
  const debugPrefix = `[BUSINESS DEBUG]\nchat=${chatTitle}\nfrom=${sender}\ntext="${text.slice(0, 120)}"\nconnection=${connectionId}`;

  let connection;
  try {
    connection = await getBusinessConnection(connectionId);
  } catch (error) {
    console.error(`[BUSINESS] не получил connection ${connectionId}: ${error.message}`);
    if (hasTrigger) {
      bot.sendMessage(config.adminId, `${debugPrefix}\nstatus=connection_error\nerror=${error.message}`).catch(() => {});
    }
    return false;
  }

  const ownerId = connection?.user?.id;
  const rights = connection?.rights || {};
  const canReply = Boolean(rights.can_reply || connection?.can_reply);

  if (!connection || connection.is_enabled === false) {
    console.log(`[BUSINESS] выкл chat=${chatTitle} owner=${ownerId || 'unknown'} trigger=${hasTrigger}`);
    if (hasTrigger) {
      bot.sendMessage(config.adminId, `${debugPrefix}\nstatus=disabled\nowner=${ownerId || 'unknown'}\ncan_reply=${canReply}`).catch(() => {});
    }
    return false;
  }
  if (ownerId && Number(ownerId) !== Number(config.adminId)) {
    console.log(`[BUSINESS] игнор connection ${connectionId}: владелец ${ownerId} не админ ${config.adminId}`);
    if (hasTrigger) {
      bot.sendMessage(config.adminId, `${debugPrefix}\nstatus=wrong_owner\nowner=${ownerId}\nadmin=${config.adminId}`).catch(() => {});
    }
    return false;
  }
  if ((connection.rights || Object.prototype.hasOwnProperty.call(connection, 'can_reply')) && !canReply) {
    console.log(`[BUSINESS] нет can_reply chat=${chatTitle} owner=${ownerId || 'unknown'} trigger=${hasTrigger}`);
    if (hasTrigger) {
      bot.sendMessage(config.adminId, `${debugPrefix}\nstatus=no_can_reply\nowner=${ownerId || 'unknown'}`).catch(() => {});
    }
    return false;
  }

  return true;
}

async function handleBusinessMessage(msg) {
  if (!isFreshMessage(msg)) return;
  if (!(await shouldProcessBusinessMessage(msg))) return;

  const scopedBot = withBusinessConnection(bot, msg);
  await logic.processMessage(scopedBot, msg);
}

// Передаем бота в AI-сервис для уведомлений
const ai = require('./services/ai');
ai.setBot(bot);

console.log("лёнЯ запущен и готов пояснять за жизнь.");
console.log(`Admin ID: ${config.adminId}`);

bot.getMe().then((me) => {
  console.log(`[BOT] @${me.username || 'unknown'} business=${Boolean(me.can_connect_to_business)}`);
}).catch((err) => {
  console.error(`[BOT] не вышло получить getMe: ${err.message}`);
});

// === ТИКЕР НАПОМИНАЛОК (Проверка каждую минуту) ===
setInterval(() => {
  const pending = storage.getPendingReminders();
  
  if (pending.length > 0) {
      console.log(`[REMINDER] сработало напоминаний: ${pending.length}`);
      
      const idsToRemove = [];

      pending.forEach(task => {
          const message = task.text
              ? `⏰ <b>${escapeHtml(task.username)}</b>, напоминаю!<blockquote>${escapeHtml(task.text)}</blockquote>`
              : `⏰ <b>${escapeHtml(task.username)}</b>, напоминаю!`;
          
          sendRich(bot, task.chatId, { html: message }).then(() => {
              console.log(`[REMINDER] отправлено: ${task.text}`);
          }).catch(err => {
              console.error(`[REMINDER ERROR] не смог отправить в ${task.chatId}: ${err.message}`);
          });

          idsToRemove.push(task.id);
      });

      storage.removeReminders(idsToRemove);
  }
}, 60 * 1000);

// Обработка ошибок поллинга
bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
  });

bot.on('business_connection', (connection) => {
  businessConnections.set(connection.id, connection);
  const rights = connection.rights || {};
  const user = connection.user?.username ? `@${connection.user.username}` : connection.user?.first_name || connection.user?.id;
  console.log(`[BUSINESS] ${connection.is_enabled ? 'подключен' : 'отключен'}: ${user}, can_reply=${Boolean(rights.can_reply)}, id=${connection.id}`);
});

bot.on('deleted_business_messages', (update) => {
  console.log(`[BUSINESS] удалены сообщения: chat=${update.chat?.id}, ids=${update.message_ids?.join(',')}`);
});

bot.on('business_message', async (msg) => {
  await handleBusinessMessage(msg);
});

bot.on('edited_business_message', async (msg) => {
  await handleBusinessMessage(msg);
});

// Единый вход для всех сообщений
bot.on('message', async (msg) => {
  if (!isFreshMessage(msg)) return;

  const chatId = msg.chat.id;
  const chatTitle = msg.chat.title || "личка";

  // === СЕКЬЮРИТИ: проверка админа ===
  if (msg.chat.type !== 'private') {
      try {
          const adminMember = await bot.getChatMember(chatId, config.adminId);
          const allowedStatuses = ['creator', 'administrator', 'member'];

          if (!allowedStatuses.includes(adminMember.status)) {
            console.log(`[SECURITY] чат без админа...`);
            
            const phrases = [
                "так, стопэ. админа не вижу. благотворительности не будет, я уёбываю.",
                "опа, куда это меня занесло? моего хорошего рядом нет, так что я уёбываю.",
                "вы че думали, украли бота? я не работаю в беспризорных приютах. я уёбываю.",
                "⚠️ error: admin not found. включаю протокол самоуважения. я уёбываю.",
                "не, ну вы видели? затащили без спроса. ну вас нахер, я уёбываю."
            ];
            const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

            await sendRich(bot, chatId, { markdown: randomPhrase }).catch(() => {});
            await bot.leaveChat(chatId).catch(() => {});
            return; 
        }
      } catch (e) {
        console.error(`[SECURITY ERROR] ошибка проверки прав в "${chatTitle}": ${e.message}`);
        
        if (e.message.includes('chat not found') || e.message.includes('kicked') || e.message.includes('Forbidden')) {
           bot.leaveChat(chatId).catch(() => {});
        } 
    }
  }

  // === ВЫХОД ВСЛЕД ЗА АДМИНОМ ===
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    console.log(`[SECURITY] админ вышел из чата "${chatTitle}". ухожу следом.`);
    await sendRich(bot, chatId, { markdown: "админ ушёл, и я сваливаю." });
    await bot.leaveChat(chatId);
    return;
  }

  // Дальше идет обычная логика...
  await logic.processMessage(bot, msg);
});

// Сохраняем базу при выходе
process.on('SIGINT', () => {
  console.log("сохранение данных перед выходом...");
  storage.forceSave(); 
  process.exit();
});

process.on('SIGTERM', () => {
  console.log("получен SIGTERM, сохраняю данные...");
  storage.forceSave();
  process.exit(0);
});

// === ВЕБ-СЕРВЕР ДЛЯ RENDER (чтобы не ругался на отсутствие порта) ===
const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Лёня работает! Бот активен.');
});

app.listen(port, () => {
    console.log(`[WEB] веб-сервер запущен на порту ${port}`);
});
