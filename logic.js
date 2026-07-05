const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
const { sendRich, escapeHtml, normalizeMd } = require('../utils/rich');
const chatHistory = {};
const analysisBuffers = {};
const chatAnalysisBuffers = {};
const BUFFER_SIZE = 20;
const CHAT_BUFFER_SIZE = 50;
const recentActiveUsers = [];

// === ответы на ошибки в стиле лёни ===
function getLenyaErrorReply(errText) {
    const error = errText.toLowerCase();

    if (error.includes('prohibited') || error.includes('safety') || error.includes('blocked') || error.includes('policy')) {
        const phrases = [
            "цензура, бля. там что-то запретное оказалось. давай по-нормальному.",
            "не, это бан. там слишком жесть для их алгоритмов. переформулируй.",
            "тема закрыта. не буду я это генерить, извиняй."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    if (error.includes('503') || error.includes('overloaded') || error.includes('unavailable') || error.includes('timeout')) {
        const phrases = [
            "сервера грузятся, подожди чутка.",
            "тупят там все, дай им отдышаться.",
            "перегруз, бля. попробуй через минуту."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    if (error.includes('429') || error.includes('quota') || error.includes('exhausted') || error.includes('лимит')) {
        const phrases = [
            "лимит кончился на сегодня, братишка.",
            "всё, мы много болтали, пора передохнуть.",
            "квота вышла, завтра продолжим."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    if (error.includes('400') || error.includes('too large') || error.includes('invalid argument')) {
        const phrases = [
            "слишком жирный запрос, сократи.",
            "много буков, я не переварю столько.",
            "ай, тяжело, давай проще что-нибудь."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    const phrases = [
        "у меня баг, админ, просыпайся.",
        "я упал, чё-то сломалось.",
        "ошибка, бля. чини меня."
    ];
    return phrases[Math.floor(Math.random() * phrases.length)];
}

function addToHistory(chatId, sender, text) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  const entry = { role: sender, text: text };
  chatHistory[chatId].push(entry);
  if (chatHistory[chatId].length > config.contextSize) {
    chatHistory[chatId].shift();
  }
  return entry;
}

function replyOpts(msg, threadId) {
    return { replyTo: msg.message_id, threadId: threadId || null, businessId: msg.business_connection_id || null };
}

function baseOpts(msg, threadId) {
    return { threadId: threadId || null, businessId: (msg && msg.business_connection_id) || null };
}

function getActionOptions(threadId) {
    if (!threadId) return undefined;
    return { message_thread_id: threadId };
}

async function processBuffer(chatId) {
    const buffer = analysisBuffers[chatId];
    if (!buffer || buffer.length === 0) return;

    const userIds = [...new Set(buffer.map(m => m.userId))];
    const currentProfiles = storage.getProfilesForUsers(chatId, userIds);
    const updates = await ai.analyzeBatch(buffer, currentProfiles);

    if (updates) {
        storage.bulkUpdateProfiles(chatId, updates);
        console.log(`[OBSERVER] обновлено профилей: ${Object.keys(updates).length}`);
    }
    analysisBuffers[chatId] = [];
}

async function processChatBuffer(chatId) {
    const buffer = chatAnalysisBuffers[chatId];
    if (!buffer || buffer.length === 0) return;

    const currentProfile = storage.getChatProfile(chatId);
    const updates = await ai.analyzeChatProfile(buffer, currentProfile);

    if (updates) {
        storage.updateChatProfile(chatId, updates);
        console.log(`[CHAT PROFILE] обновлён профиль чата ${chatId}`);
    }
    chatAnalysisBuffers[chatId] = [];
}

async function initChatProfile(bot, chatId) {
    try {
        const history = chatHistory[chatId] || [];

        if (history.length >= 10) {
            const messages = history.slice(-50).map(m => ({ name: m.role, text: m.text }));
            const currentProfile = storage.getChatProfile(chatId);
            const updates = await ai.analyzeChatProfile(messages, currentProfile);

            if (updates) {
                storage.updateChatProfile(chatId, updates);
                console.log(`[CHAT PROFILE INIT] профиль чата ${chatId} инициализирован`);
            }
        } else {
            console.log(`[CHAT PROFILE INIT] ждём сообщений для ${chatId}`);
        }
    } catch (e) {
        console.error(`[CHAT PROFILE INIT ERROR] ${e.message}`);
    }
}

async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    const isBusinessMessage = Boolean(msg.business_connection_id);

    if (storage.isBanned(userId) && userId !== config.adminId) {
        return;
    }
    
    let threadId = msg.is_topic_message ? msg.message_thread_id : (msg.message_thread_id || (msg.reply_to_message ? msg.reply_to_message.message_thread_id : null));
    if (typeof threadId !== 'number') threadId = null;
    
    let text = msg.text || msg.caption || "";

    const cleanText = text.toLowerCase();
    const replyUserId = msg.reply_to_message?.from?.id;
    const isReplyToBot = replyUserId && String(replyUserId) === String(config.botId);
    const hasTriggerWord = config.triggerRegex.test(cleanText); 
    const isDirectlyCalled = hasTriggerWord || isReplyToBot; 

    let typingTimer = null;
    let safetyTimeout = null;

    const stopTyping = () => {
        if (typingTimer) {
            clearInterval(typingTimer);
            typingTimer = null;
        }
        if (safetyTimeout) {
            clearTimeout(safetyTimeout);
            safetyTimeout = null;
        }
    };

    const startTyping = () => {
        if (typingTimer) return;

        const sendAction = () => {
            if (threadId) {
                bot.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
            } else {
                bot.sendChatAction(chatId, 'typing').catch(() => {});
            }
        };

        sendAction();
        typingTimer = setInterval(sendAction, 4000);
        safetyTimeout = setTimeout(() => {
            console.log(`[TYPING SAFETY] принудительная остановка тайпинга в ${chatId}`);
            stopTyping();
        }, 20000);
    };

    const command = text.trim().split(/[\s@]+/)[0].toLowerCase(); 
  
    const chatTitle = msg.chat.title || msg.chat.username || msg.chat.first_name || "unknown";
    if (userId !== config.adminId) {
        const senderInfo = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        const existingIndex = recentActiveUsers.findIndex(u => u.id === userId);
        if (existingIndex !== -1) recentActiveUsers.splice(existingIndex, 1);
        
        recentActiveUsers.unshift({
            id: userId,
            name: senderInfo,
            text: text.slice(0, 30),
            chat: chatTitle
        });
        if (recentActiveUsers.length > 10) recentActiveUsers.pop();
    }
  
    if (!storage.hasChat(chatId) && chatId !== config.adminId) {
        let alertText = `<h4>🔔 новый контакт</h4><p>📂 чат: <b>${escapeHtml(chatTitle)}</b><br/>🆔 <code>${chatId}</code></p>`;
        
        const inviter = `@${escapeHtml(msg.from.username || "нет")} (${escapeHtml(msg.from.first_name || "")})`;

        if (msg.chat.type === 'private') {
            alertText += `<p>👤 написал: ${inviter}</p><blockquote>${escapeHtml(text)}</blockquote>`;
        } else {
            if (msg.new_chat_members && msg.new_chat_members.some(u => u.id === config.botId)) {
               alertText += `<p>👋 меня добавил: ${inviter}<br/>👥 тип: группа/канал</p>`;
            } else {
               alertText += `<p>👤 активация: ${inviter}</p><blockquote>${escapeHtml(text)}</blockquote>`;
            }
        }
        
        sendRich(bot, config.adminId, { html: alertText }).catch(() => {});
    }

    storage.updateChatName(chatId, chatTitle);

    if (!isBusinessMessage && msg.chat.type === 'private' && userId !== config.adminId) {
        const senderInfo = `@${escapeHtml(msg.from.username || "нет")} (${escapeHtml(msg.from.first_name || "")})`;
        let contentReport = text ? `<blockquote>${escapeHtml(text)}</blockquote>` : "<p>📎 [файл или стикер]</p>";
        sendRich(bot, config.adminId, { html: `<p>📩 <b>лс от ${senderInfo}</b></p>${contentReport}` }).catch(e => console.error("ошибка пересылки лс:", e.message));

        if (command !== '/start') {
            bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)).catch(() => {});
            await new Promise(r => setTimeout(r, 1500));

            const infoText = `<p>в личке я только с админом общаюсь.</p>
<b>почему так?</b>
<p>у меня тут свои заморочки, я не на всех отвечаю.</p>
<b>где меня потестить?</b>
<p>залетай в группу, там я отвечаю всем.</p>
<b>хочешь себе такого же бота?</b>
<p>код открыт: <a href="https://github.com/Veta-one/sych-bot">github</a></p>`;

            await sendRich(bot, chatId, { html: infoText }, baseOpts(msg, threadId));
            return;
        }
    }

  
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    await sendRich(bot, chatId, { markdown: "админ ушёл, и я сваливаю." });
    await bot.leaveChat(chatId);
    return;
  }

   if (msg.voice || msg.audio) {
    startTyping(); 

    try {
        const media = msg.voice || msg.audio;
        const fileId = media.file_id;
        const mimeType = msg.voice ? 'audio/ogg' : (media.mime_type || 'audio/mpeg');
        const link = await bot.getFileLink(fileId);
        const resp = await axios.get(link, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(resp.data);
        const userName = msg.from.first_name || "анон";

        const transcription = await ai.transcribeAudio(buffer, userName, mimeType);
        
        stopTyping();

        if (transcription) {
            let replyText = "";
            const fullLen = transcription.text.length;
            const tldrLen = transcription.summary.length;
            const isTldrUseful = tldrLen < (fullLen * 0.65);
            const durSec = media.duration;
            const durStr = (typeof durSec === 'number' && durSec > 0)
                ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}`
                : '';
            const durTag = durStr ? ` · <code>${durStr}</code>` : '';
            const safeName = escapeHtml(userName);

            if (isTldrUseful) {
                replyText = `<p>🎙 <b>голосовое</b> · ${safeName}${durTag}</p>`
                    + `<p><b>суть:</b> ${escapeHtml(transcription.summary)}</p>`
                    + `<details><summary>расшифровка</summary><blockquote>${escapeHtml(transcription.text)}</blockquote></details>`;
            } else {
                replyText = `<p>🎙 <b>${safeName}</b>${durTag}</p><blockquote>${escapeHtml(transcription.text)}</blockquote>`;
            }

            try { await sendRich(bot, chatId, { html: replyText }, replyOpts(msg, threadId)); } catch(e) {}
            
            if (storage.isTopicMuted(chatId, threadId)) return;

            text = transcription.text; 
            msg.text = transcription.text;
        }
    } catch (e) {
        console.error("ошибка голосового:", e.message);
    }
}

  
    if (!text && !msg.photo && !msg.sticker && !msg.voice && !msg.audio) return;

  if (msg.chat.type === 'private' && !isBusinessMessage) {
    if (userId !== config.adminId) return;
  } else {
    storage.trackUser(chatId, msg.from);
  }

  if (!analysisBuffers[chatId]) analysisBuffers[chatId] = [];
  
  const senderName = msg.from.first_name || "user";
  const senderUsername = msg.from.username ? `@${msg.from.username}` : "";
  const displayName = senderUsername ? `${senderName} (${senderUsername})` : senderName;

  if (!text.startsWith('/')) {
      analysisBuffers[chatId].push({ userId, name: displayName, text });
      if (!chatAnalysisBuffers[chatId]) chatAnalysisBuffers[chatId] = [];
      chatAnalysisBuffers[chatId].push({ name: displayName, text });
  }
  if (analysisBuffers[chatId].length >= BUFFER_SIZE) {
      processBuffer(chatId);
  }
  if (chatAnalysisBuffers[chatId] && chatAnalysisBuffers[chatId].length >= CHAT_BUFFER_SIZE) {
      processChatBuffer(chatId);
  }

  const isMuted = storage.isTopicMuted(chatId, threadId);

  if (command === '/version') {
    return sendRich(bot, chatId, { html: `<h4>лёня бот</h4><p>версия: <code>v${config.version}</code></p>` }, baseOpts(msg, threadId));
}

  if (userId === config.adminId) {
      
    if (command === '/banlist') {
        const banned = storage.getBannedList();
        const items = Object.entries(banned).map(([uid, name]) => `<li><code>${uid}</code> — ${escapeHtml(String(name))}</li>`).join('');
        const html = items.length ? `<h4>⛔ чёрный список</h4><ul>${items}</ul>` : "<p>список пуст.</p>";
        return sendRich(bot, chatId, { html }, baseOpts(msg, threadId));
    }

    if (command === '/unban') {
        const targetId = text.split(' ')[1];
        if (!targetId) return sendRich(bot, chatId, { html: "⚠️ введи id: <code>/unban 123456</code>" }, baseOpts(msg, threadId));
        
        storage.unbanUser(targetId);
        return sendRich(bot, chatId, { html: `✅ юзер <code>${escapeHtml(targetId)}</code> разбанен.` }, baseOpts(msg, threadId));
    }

    if (command === '/ban') {
        const args = text.split(/\s+/);
        const target = args[1];

        if (!target) {
            if (recentActiveUsers.length === 0) return sendRich(bot, chatId, { markdown: "список активности пуст." }, baseOpts(msg, threadId));

            const list = recentActiveUsers.map((u) => {
                return `<li><b>${escapeHtml(u.name)}</b> — <code>${u.id}</code><br/>💬 "${escapeHtml(u.text)}..."<br/>📂 ${escapeHtml(String(u.chat))}</li>`;
            }).join('');

            return sendRich(bot, chatId, { html: `<h4>последние активные</h4><ol>${list}</ol><p>забанить: <code>/ban id</code></p>` }, baseOpts(msg, threadId));
        }

        let targetId = target;
        let targetName = target;

        if (isNaN(target)) {
           const foundId = storage.findUserIdByUsername(target);
           if (!foundId) return sendRich(bot, chatId, { html: `❌ не нашёл юзера с ником ${escapeHtml(target)} в базе.` }, baseOpts(msg, threadId));
           targetId = foundId;
        }

        if (parseInt(targetId) === config.adminId) return sendRich(bot, chatId, { markdown: "себя банить не буду." }, baseOpts(msg, threadId));

        storage.banUser(targetId, targetName);
        return sendRich(bot, chatId, { html: `<h4>🚫 бан</h4><p>пользователь: <b>${escapeHtml(String(targetName))}</b><br/>id: <code>${escapeHtml(String(targetId))}</code></p><p>теперь игнорю его.</p>` }, baseOpts(msg, threadId));
    }
}

  if (command === '/help' || command === '/start') {
    const helpText = `<h3>что я умею</h3>
<b>вижу и слышу</b>
<ul>
<li>кидай <b>войс</b> — расшифрую</li>
<li>кидай <b>фото/видео</b> — пойму что там</li>
<li>кидай <b>pdf/txt</b> — прочитаю</li>
<li>гуглю актуальное: курсы, новости, погода</li>
<li>«лёня напомни завтра в 10» — напоминание</li>
</ul>
<details><summary>🎲 развлекуха</summary>
<ul>
<li>«лёня монетку» — орёл/решка</li>
<li>«лёня число 1-100» — рандом</li>
<li>«лёня кто из нас [вопрос]» — выберу случайного</li>
</ul>
</details>
<details><summary>🕵️ досье</summary>
<ul>
<li>«лёня кто я?» — моё мнение о тебе</li>
<li>«лёня расскажи про @юзера» — досье</li>
</ul>
</details>
<blockquote>ver: ${config.version}</blockquote>`;
    try { return await sendRich(bot, chatId, { html: helpText }, baseOpts(msg, threadId)); } catch (e) {}
}

  if (command === '/mute') {
    const nowMuted = storage.toggleMute(chatId, threadId);
    return sendRich(bot, chatId, { markdown: nowMuted ? "ок, молчу" : "я тут" }, baseOpts(msg, threadId));
  }
  if (command === '/reset') {
    chatHistory[chatId] = [];
    analysisBuffers[chatId] = [];
    return sendRich(bot, chatId, { markdown: "ок, всё забыл" }, baseOpts(msg, threadId));
  }

  if (command === '/restart' && userId === config.adminId) {
    await sendRich(bot, chatId, { markdown: "перезагружаюсь..." }, baseOpts(msg, threadId));
    exec('pm2 restart sych-bot', (err) => {
        if (err) sendRich(bot, config.adminId, { html: `❌ ошибка рестарта: <code>${escapeHtml(err.message)}</code>` });
    });
    return;
  }

  if (storage.isTopicMuted(chatId, threadId)) {
    return;
  }

  if (isDirectlyCalled) {
    startTyping(); 
  }

  const currentMsgEntry = addToHistory(chatId, senderName, text);

  if (cleanText === 'лёня стата' || cleanText === 'лёня статистика') {
    const report = ai.getStatsReport();
    return sendRich(bot, chatId, { markdown: report }, replyOpts(msg, threadId));
  }

  if (isDirectlyCalled && (cleanText.includes("напомни") || cleanText.includes("напоминай"))) {
      
    bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)).catch(() => {});
    console.log(`[LOGIC] запрос на напоминание: ${text}`);

    const replyContent = msg.reply_to_message 
        ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") 
        : "";

    const parsed = await ai.parseReminder(text, replyContent);
    
    if (parsed && parsed.targetTime) {
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        
        storage.addReminder(chatId, userId, username, parsed.targetTime, parsed.reminderText);
        
        console.log(`[REMINDER SET] установлено на: ${parsed.targetTime}`);
        return sendRich(bot, chatId, { markdown: parsed.confirmation }, replyOpts(msg, threadId));
    } else {
        console.log(`[REMINDER ERROR] ai не распарсил время.`);
    }
}


  if (hasTriggerWord) {
      const chatTopicMatch = text.match(/(?:этот чат про|чат про|мы тут|здесь мы)\s+([\s\S]+)/i);
      if (chatTopicMatch) {
          const description = chatTopicMatch[1].trim();
          if (description.length > 10) {
              startTyping();
              const currentProfile = storage.getChatProfile(chatId);
              const updates = await ai.processManualChatDescription(description, currentProfile);
              stopTyping();

              if (updates && updates.topic) {
                  storage.updateChatProfile(chatId, updates);
                  const factsInfo = updates.facts ? `<br/>📝 факты: ${escapeHtml(updates.facts.substring(0, 100))}${updates.facts.length > 100 ? '...' : ''}` : '';
                  try { return await sendRich(bot, chatId, { html: `<p>понял, запомнил.<br/>🎯 <b>тема:</b> ${escapeHtml(updates.topic)}${factsInfo}</p>` }, replyOpts(msg, threadId)); } catch(e){}
              } else {
                  storage.setChatTopic(chatId, description.substring(0, 200));
                  try { return await sendRich(bot, chatId, { html: `<p>понял, запомнил. тема: "${escapeHtml(description.substring(0, 100))}..."</p>` }, replyOpts(msg, threadId)); } catch(e){}
              }
          }
      }

      const aboutMatch = cleanText.match(/(?:расскажи про|кто так(?:ой|ая)|мнение о|поясни за)\s+(.+)/);
      if (aboutMatch) {
        const targetName = aboutMatch[1].replace('?', '').trim();
        const targetProfile = storage.findProfileByQuery(chatId, targetName);
        if (targetProfile) {
            startTyping();
            const description = await ai.generateProfileDescription(targetProfile, targetName);
            stopTyping();
            try { return await sendRich(bot, chatId, { markdown: normalizeMd(description) }, replyOpts(msg, threadId)); } catch(e){}
        }
    }
      
      if (cleanText.match(/(монетк|кинь|брось|подбрось|подкинь)/)) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const result = Math.random() > 0.5 ? "орёл" : "решка";
          const flavor = await ai.generateFlavorText("подбросить монетку", result);
          try { return await sendRich(bot, chatId, { markdown: flavor }, replyOpts(msg, threadId)); } catch(e){}
      }

      const rangeMatch = cleanText.match(/(\d+)-(\d+)/);
      if ((cleanText.includes("число") || cleanText.includes("рандом")) && rangeMatch) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const min = parseInt(rangeMatch[1]);
          const max = parseInt(rangeMatch[2]);
          const rand = Math.floor(Math.random() * (max - min + 1)) + min;
          const flavor = await ai.generateFlavorText(`выбрать число ${min}-${max}`, String(rand));
          try { return await sendRich(bot, chatId, { markdown: flavor }, replyOpts(msg, threadId)); } catch(e){}
      }
      
      const isWhoGame = cleanText.match(/(?:кто|кого)\s+(?:из нас|тут|здесь|в чате|сегодня)/) || cleanText.match(/лёня\W+кто\??$/) || cleanText.trim() === "лёня кто";
      if (isWhoGame) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const randomUser = storage.getRandomUser(chatId);
          if (!randomUser) return sendRich(bot, chatId, { markdown: "никого не знаю пока." }, baseOpts(msg, threadId));
          const flavor = await ai.generateFlavorText(`выбрать случайного человека из чата на вопрос "${text}"`, randomUser);
          try { return await sendRich(bot, chatId, { markdown: flavor }, replyOpts(msg, threadId)); } catch(e){}
      }
  }

  const shouldAnswer = isDirectlyCalled;

  if (!shouldAnswer && text.length > 10 && !isReplyToBot && Math.random() < 0.015) {
      
    const historyBlock = chatHistory[chatId].slice(-15).map(m => `${m.role}: ${m.text}`).join('\n');
    
    ai.determineReaction(historyBlock + `\nсообщение для реакции: ${text}`).then(async (emoji) => {
        if (emoji) {
            try { await bot.setMessageReaction(chatId, msg.message_id, { reaction: [{ type: 'emoji', emoji: emoji }] }); } catch (e) {}
        }
    });
}

  if (shouldAnswer) {
    startTyping();

    let imageBuffer = null;
    let mimeType = "image/jpeg";

    if (msg.sticker) {
        const stickerEmoji = msg.sticker.emoji || "";
        if (stickerEmoji) text += ` [стикер: ${stickerEmoji}]`;

        if (!msg.sticker.is_animated && !msg.sticker.is_video) {
            try {
                const link = await bot.getFileLink(msg.sticker.file_id);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                mimeType = "image/webp";
            } catch (e) { console.error("ошибка стикера:", e.message); }
        }
    }

    else if (msg.photo || (msg.reply_to_message && msg.reply_to_message.photo)) {
       try {
         const photoObj = msg.photo ? msg.photo[msg.photo.length-1] : msg.reply_to_message.photo[msg.reply_to_message.photo.length-1];
         const link = await bot.getFileLink(photoObj.file_id);
         const resp = await axios.get(link, { responseType: 'arraybuffer' });
         imageBuffer = Buffer.from(resp.data);
         mimeType = "image/jpeg";
         console.log(`[MEDIA] фото скачано`);
       } catch(e) { console.error("ошибка фото:", e.message); }
    }

    else if (msg.video || (msg.reply_to_message && msg.reply_to_message.video)) {
        const vid = msg.video || msg.reply_to_message.video;
        if (vid.file_size > 20 * 1024 * 1024) {
            return sendRich(bot, chatId, { markdown: "видос жирный, больше 20мб. сожми." }, replyOpts(msg, threadId));
        }
        try {
            await bot.sendChatAction(chatId, 'upload_video', getActionOptions(threadId));
            const link = await bot.getFileLink(vid.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = vid.mime_type || "video/mp4";
            console.log(`[MEDIA] видео скачано (${mimeType})`);
        } catch(e) { console.error("ошибка видео:", e.message); }
    }

    else if (msg.document || (msg.reply_to_message && msg.reply_to_message.document)) {
        const doc = msg.document || msg.reply_to_message.document;
        
        const allowedMimes = [
            'application/pdf', 'application/x-javascript', 'text/javascript', 
            'application/x-python', 'text/x-python', 'text/plain', 'text/html', 
            'text/css', 'text/md', 'text/csv', 'text/xml', 'text/rtf'
        ];

        if (doc.file_size > 20 * 1024 * 1024) {
            return sendRich(bot, chatId, { markdown: "файл больше 20мб, не могу." }, replyOpts(msg, threadId));
        }

        if (!allowedMimes.includes(doc.mime_type) && !doc.mime_type.startsWith('image/')) {
             return sendRich(bot, chatId, { markdown: "такой формат не читаю. давай pdf или текст." }, replyOpts(msg, threadId));
        }

        try {
            await bot.sendChatAction(chatId, 'upload_document', getActionOptions(threadId));
            const link = await bot.getFileLink(doc.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = doc.mime_type;
            console.log(`[MEDIA] док скачан (${mimeType})`);
        } catch(e) { console.error("ошибка дока:", e.message); }
    }

    else if (!imageBuffer) {
        let urlMatch = text.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif|bmp)/i);
        
        if (!urlMatch && msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) {
             const replyText = msg.reply_to_message.text || msg.reply_to_message.caption;
             urlMatch = replyText.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif|bmp)/i);
        }

        if (urlMatch) {
            try {
                const resp = await axios.get(urlMatch[0], { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                if (urlMatch[0].endsWith('.webp')) mimeType = "image/webp";
                else mimeType = "image/jpeg"; 
                console.log(`[MEDIA] картинка по ссылке скачана`);
            } catch(e) {}
        }
    }
    const instruction = msg.from.username ? storage.getUserInstruction(msg.from.username) : "";
    const userProfile = storage.getProfile(chatId, userId);

    let targetLink = null;
    
    const linkRegex = /https?:\/\/[^\s]+/;
    const linkInText = text.match(linkRegex);
    
    if (linkInText) {
        targetLink = linkInText[0];
    } else if (msg.reply_to_message) {
        if (msg.reply_to_message.text) {
             const linkInReply = msg.reply_to_message.text.match(linkRegex);
             if (linkInReply) targetLink = linkInReply[0];
        } else if (msg.reply_to_message.caption) {
             const linkInCaption = msg.reply_to_message.caption.match(linkRegex);
             if (linkInCaption) targetLink = linkInCaption[0];
        }
    }

    let aiResponse = "";

    let chatProfile = storage.getChatProfile(chatId);

    if (!chatProfile.topic && chatHistory[chatId] && chatHistory[chatId].length >= 10) {
        console.log(`[CHAT PROFILE] профиль пуст, инициализация для ${chatId}`);
        initChatProfile(bot, chatId);
    }

    try {
    const replyText = msg.reply_to_message ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") : "";

    aiResponse = await ai.getResponse(
        chatHistory[chatId],
        { sender: senderName, text: text, replyText: replyText },
        imageBuffer,
        mimeType,
        instruction,
        userProfile,
        !isDirectlyCalled,
        chatProfile
    );

    console.log(`[DEBUG] ответ от ai получен! длина: ${aiResponse ? aiResponse.length : "пусто"}`);
    
    if (!aiResponse) {
        console.log(`[DEBUG] 🚨 ошибка: ai вернул пустоту!`);
        sendRich(bot, config.adminId, { html: `<p>⚠️ <b>alarm:</b> ai вернул пустую строку!</p><p>📂 чат: <b>${escapeHtml(chatTitle)}</b></p>` }).catch(() => {});
        aiResponse = getLenyaErrorReply("503 overloaded");

    }
    
    } catch (err) {
        console.error("[CRITICAL AI ERROR]:", err.message);
        
        sendRich(bot, config.adminId, { html: `<h4>🔥 ошибка</h4><p>чат: <b>${escapeHtml(chatTitle)}</b></p><pre><code>${escapeHtml(err.message)}</code></pre>` }).catch(() => {});

        aiResponse = getLenyaErrorReply(err.message);
    }

    
    let formattedResponse = aiResponse;

    try {
        if (formattedResponse.length > 30000) {
            formattedResponse = formattedResponse.substring(0, 30000) + "\n\n...[длинно, бля]...";
        }

        await sendRich(bot, chatId, { markdown: normalizeMd(formattedResponse) }, replyOpts(msg, threadId));

        stopTyping();
        addToHistory(chatId, "лёня", aiResponse);

    } catch (error) {
        stopTyping();
        console.error(`[SEND ERROR]: ${error.message}`);

        if (isBusinessMessage && /BUSINESS[_ ]?PEER[_ ]?INVALID|BUSINESSPEERINVALID/i.test(error.message)) {
            console.log(`[BUSINESS SEND] телеграм отклонил отправку в chat=${chatId}.`);
            sendRich(bot, config.adminId, { html: `<p>⚠️ <b>business отправка отклонена</b></p><p>чат: <b>${escapeHtml(chatTitle)}</b><br/>id: <code>${chatId}</code></p><pre><code>${escapeHtml(error.message)}</code></pre>` }).catch(() => {});
            return;
        }

        sendRich(bot, config.adminId, { html: `<p>⚠️ <b>ошибка отправки:</b></p><pre><code>${escapeHtml(error.message)}</code></pre><p>📂 чат: <b>${escapeHtml(chatTitle)}</b> · 🆔 <code>${chatId}</code></p>` }).catch(() => {});

        try { 
             const rawChunks = aiResponse.match(/[\s\S]{1,4000}/g) || [aiResponse];
             for (const chunk of rawChunks) {
                await bot.sendMessage(chatId, chunk, { reply_to_message_id: msg.message_id });
             }
             addToHistory(chatId, "лёня", aiResponse);
        } catch (e2) { console.error("fatal send error:", e2.message); }
    }

    if (imageBuffer && typeof mimeType === 'string' && mimeType.startsWith('image/') && currentMsgEntry) {
        ai.describeImage(imageBuffer, mimeType).then(desc => {
            if (desc) {
                currentMsgEntry.text = `${currentMsgEntry.text ? currentMsgEntry.text + ' ' : ''}[🖼 на картинке: ${desc}]`;
                const preview = desc.slice(0, 200).replace(/\s+/g, ' ').trim();
                console.log(`[IMG MEMORY] описание сохранено (${desc.length} симв.)`);
            }
        }).catch(e => console.error(`[IMG MEMORY] ${e.message}`));
    }

    const contextForAnalysis = chatHistory[chatId].slice(-5).map(m => `${m.role}: ${m.text}`).join('\n');
    
    ai.analyzeUserImmediate(contextForAnalysis, userProfile).then(updated => {
        if (updated) {
            if (updated.relationship) {
                console.log(`[RELATIONSHIP] ${senderName}: новая репутация = ${updated.relationship}/100`);
            }
            
            const updates = {}; updates[userId] = updated;
            storage.bulkUpdateProfiles(chatId, updates);
        } else {
            console.log(`[RELATIONSHIP] не удалось обновить профиль`);
        }
    }).catch(err => console.error("[RELATIONSHIP ERROR]", err));
  }
}

module.exports = { processMessage };
