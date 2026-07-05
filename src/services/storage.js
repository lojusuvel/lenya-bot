const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/db.json');
const INSTRUCTIONS_PATH = path.join(__dirname, '../../data/instructions.json');
const PROFILES_PATH = path.join(__dirname, '../../data/profiles.json');
const CHAT_PROFILES_PATH = path.join(__dirname, '../../data/chatProfiles.json');
const STATS_PATH = path.join(__dirname, '../../data/stats.json');
const debounce = require('lodash.debounce');

class StorageService {
  constructor() {
    // ждём 5 секунд тишины перед записью, чтобы не грузить диск
    this.saveDebounced = debounce(this._saveToFile.bind(this), 5000);
    this.saveProfilesDebounced = debounce(this._saveProfilesToFile.bind(this), 5000);
    this.saveChatProfilesDebounced = debounce(this._saveChatProfilesToFile.bind(this), 5000);
    this.saveStatsDebounced = debounce(this._saveStatsToFile.bind(this), 3000);
    this.data = { chats: {} };
    this.profiles = {};
    this.chatProfiles = {};
    this.stats = this._getDefaultStats();
    this.profileUpdateQueue = Promise.resolve();

    // создаём файлы, если их нет
    this.ensureFile(DB_PATH, '{"chats": {}}');
    this.ensureFile(INSTRUCTIONS_PATH, '{}');
    this.ensureFile(PROFILES_PATH, '{}');
    this.ensureFile(CHAT_PROFILES_PATH, '{}');
    this.ensureFile(STATS_PATH, JSON.stringify(this._getDefaultStats()));

    // загружаем всё в память
    this.load();
  }

  _getDefaultStats() {
    return {
      today: {
        date: this._getTodayDate(),
        smart: 0,
        logic: 0,
        search: 0,
        google: []
      },
      history: [],
      allTime: {
        smart: 0,
        logic: 0,
        search: 0,
        google: 0
      }
    };
  }

  _getTodayDate() {
    return new Date().toISOString().split('T')[0];
  }

  ensureFile(filePath, defaultContent) {
    if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent);
  }


  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      if (!this.data.bannedUsers) this.data.bannedUsers = {};
    } catch (e) { 
      console.error("ошибка чтения бд, сброс."); 
      this.data = { chats: {}, reminders: [] };
    }
    try {
      this.profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8'));
    } catch (e) {
      console.error("ошибка чтения профилей, сброс.");
      this.profiles = {};
    }
    try {
      this.chatProfiles = JSON.parse(fs.readFileSync(CHAT_PROFILES_PATH, 'utf-8'));
    } catch (e) {
      console.error("ошибка чтения профилей чатов, сброс.");
      this.chatProfiles = {};
    }
    try {
      const loaded = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
      if (loaded.lastResetDate !== undefined && !loaded.today) {
        console.log("[stats] миграция со старого формата...");
        this.stats = this._getDefaultStats();
      } else {
        this.stats = loaded;
        if (!this.stats.today) this.stats.today = this._getDefaultStats().today;
        if (!this.stats.history) this.stats.history = [];
        if (!this.stats.allTime) this.stats.allTime = { smart: 0, logic: 0, search: 0, google: 0 };
      }
    } catch (e) {
      console.error("ошибка чтения статистики, сброс.");
      this.stats = this._getDefaultStats();
    }
  }

  // === НАПОМИНАЛКИ ===

  addReminder(chatId, userId, username, timeIso, text) {
    if (!this.data.reminders) this.data.reminders = [];
    
    this.data.reminders.push({
        id: Date.now() + Math.random(),
        chatId,
        userId,
        username,
        time: timeIso,
        text: text
    });
    this.save();
  }

  getPendingReminders() {
    if (!this.data.reminders) return [];
    const now = Date.now();
    return this.data.reminders.filter(r => {
        const taskTime = new Date(r.time).getTime();
        return taskTime <= now;
    });
  }

  removeReminders(ids) {
    if (!this.data.reminders) return;
    this.data.reminders = this.data.reminders.filter(r => !ids.includes(r.id));
    this.save();
  }

  save() {
    this.saveDebounced();
  }

  saveProfiles() {
    this.saveProfilesDebounced();
  }

  _saveToFile() {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error("ошибка записи бд:", e); }
  }

  _saveProfilesToFile() {
    try {
      fs.writeFileSync(PROFILES_PATH, JSON.stringify(this.profiles, null, 2));
    } catch (e) { console.error("ошибка записи профилей:", e); }
  }

  _saveChatProfilesToFile() {
    try {
      fs.writeFileSync(CHAT_PROFILES_PATH, JSON.stringify(this.chatProfiles, null, 2));
    } catch (e) { console.error("ошибка записи профилей чатов:", e); }
  }

  _saveStatsToFile() {
    try {
      fs.writeFileSync(STATS_PATH, JSON.stringify(this.stats, null, 2));
    } catch (e) { console.error("ошибка записи статистики:", e); }
  }

  saveChatProfiles() {
    this.saveChatProfilesDebounced();
  }

  saveStats() {
    this.saveStatsDebounced();
  }

  forceSave() {
    this.saveDebounced.flush();
    this.saveProfilesDebounced.flush();
    this.saveChatProfilesDebounced.flush();
    this.saveStatsDebounced.flush();
  }

  // === СТАТИСТИКА ===

  getStats() {
    this.resetStatsIfNeeded();
    return this.stats.today;
  }

  getFullStats() {
    this.resetStatsIfNeeded();
    return {
      today: this.stats.today,
      week: this._calcPeriodStats(7),
      month: this._calcPeriodStats(30),
      allTime: this.stats.allTime
    };
  }

  _calcPeriodStats(days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const result = { smart: 0, logic: 0, search: 0, google: 0 };

    result.smart += this.stats.today.smart;
    result.logic += this.stats.today.logic;
    result.search += this.stats.today.search;
    result.google += (this.stats.today.google || []).reduce((sum, g) => sum + g.count, 0);

    for (const day of this.stats.history) {
      if (day.date >= cutoffStr) {
        result.smart += day.smart || 0;
        result.logic += day.logic || 0;
        result.search += day.search || 0;
        result.google += day.google || 0;
      }
    }

    return result;
  }

  initGoogleStats(keyCount) {
    this.resetStatsIfNeeded();
    if (!this.stats.today.google || this.stats.today.google.length !== keyCount) {
      this.stats.today.google = Array(keyCount).fill(null).map(() => ({ count: 0, status: true }));
      this.saveStats();
    }
  }

  incrementStat(type) {
    this.resetStatsIfNeeded();
    if (this.stats.today[type] !== undefined) {
      this.stats.today[type]++;
      this.stats.allTime[type]++;
      this.saveStats();
    }
  }

  incrementGoogleStat(keyIndex) {
    this.resetStatsIfNeeded();
    if (this.stats.today.google[keyIndex]) {
      this.stats.today.google[keyIndex].count++;
      this.stats.allTime.google++;
      this.saveStats();
    }
  }

  markGoogleKeyExhausted(keyIndex) {
    if (this.stats.today.google[keyIndex]) {
      this.stats.today.google[keyIndex].status = false;
      this.saveStats();
    }
  }

  resetStatsIfNeeded() {
    const todayDate = this._getTodayDate();
    if (this.stats.today.date !== todayDate) {
      const yesterday = this.stats.today;
      const googleTotal = (yesterday.google || []).reduce((sum, g) => sum + g.count, 0);

      this.stats.history.unshift({
        date: yesterday.date,
        smart: yesterday.smart,
        logic: yesterday.logic,
        search: yesterday.search,
        google: googleTotal
      });

      if (this.stats.history.length > 90) {
        this.stats.history = this.stats.history.slice(0, 90);
      }

      const keyCount = (yesterday.google || []).length;
      this.stats.today = {
        date: todayDate,
        smart: 0,
        logic: 0,
        search: 0,
        google: Array(keyCount).fill(null).map(() => ({ count: 0, status: true }))
      };

      this.saveStats();
      console.log("[stats] новый день — статистика сброшена.");
      return true;
    }
    return false;
  }

  hasChat(chatId) {
    return !!this.data.chats[chatId];
  }

  // === РАБОТА С ЧАТАМИ ===

  getChat(chatId) {
    if (!this.data.chats[chatId]) {
      this.data.chats[chatId] = { mutedTopics: [], users: {} };
      this.save();
    }
    return this.data.chats[chatId];
  }

  updateChatName(chatId, name) {
    if (!name) return;

    const chat = this.getChat(chatId);
    if (chat.chatName !== name) {
        chat.chatName = name;
        this.save();
    }

    if (!this.profiles[chatId]) this.profiles[chatId] = {};
    if (this.profiles[chatId]["_chatName"] !== name) {
        this.profiles[chatId]["_chatName"] = name;
        this.saveProfiles();
    }
  }

  trackUser(chatId, user) {
    if (user.is_bot) return;
    const chat = this.getChat(chatId);
    const name = user.username ? `@${user.username}` : (user.first_name || "анон");
    
    if (!chat.users[user.id] || chat.users[user.id] !== name) {
      chat.users[user.id] = name;
      this.save();
    }
  }

  getRandomUser(chatId) {
    const chat = this.getChat(chatId);
    const ids = Object.keys(chat.users);
    if (ids.length === 0) return null;
    const randomId = ids[Math.floor(Math.random() * ids.length)];
    return chat.users[randomId];
  }

  isTopicMuted(chatId, threadId) {
    const chat = this.getChat(chatId);
    let tid = (threadId === null || threadId === undefined) ? 'general' : threadId;
    tid = String(tid);
    return chat.mutedTopics.some(t => String(t) === tid);
  }

  toggleMute(chatId, threadId) {
    const chat = this.getChat(chatId);
    let tid = (threadId === null || threadId === undefined) ? 'general' : threadId;
    tid = String(tid);
    
    const index = chat.mutedTopics.findIndex(t => String(t) === tid);
    
    if (index > -1) {
      chat.mutedTopics.splice(index, 1);
      this.save();
      return false;
    } else {
      chat.mutedTopics.push(tid);
      this.save();
      return true;
    }
  }

  // === ИНСТРУКЦИИ ===

  getUserInstruction(username) {
    if (!username) return "";
    try {
        if (fs.existsSync(INSTRUCTIONS_PATH)) {
            const instructions = JSON.parse(fs.readFileSync(INSTRUCTIONS_PATH, 'utf-8'));
            return instructions[username.toLowerCase()] || "";
        }
    } catch (e) { console.error("ошибка инструкций:", e); }
    return "";
  }

  // === ПРОФИЛИ ===

  getProfile(chatId, userId) {
    if (!this.profiles[chatId]) this.profiles[chatId] = {};
    
    if (!this.profiles[chatId][userId]) {
        return { realName: null, facts: "", attitude: "нейтрально", relationship: 50 };
    }
    const p = this.profiles[chatId][userId];
    if (typeof p.relationship === 'undefined') p.relationship = 50;
    
    return p;
  }

  getProfilesForUsers(chatId, userIds) {
    const result = {};
    if (!this.profiles[chatId]) return {};
    
    userIds.forEach(uid => {
        if (this.profiles[chatId][uid]) {
            result[uid] = this.profiles[chatId][uid];
        }
    });
    return result;
  }

  bulkUpdateProfiles(chatId, updatesMap) {
    this.profileUpdateQueue = this.profileUpdateQueue.then(() => {
      this._applyProfileUpdates(chatId, updatesMap);
    }).catch(err => {
      console.error("[profile update error]", err);
    });
  }

  _applyProfileUpdates(chatId, updatesMap) {
    if (!this.profiles[chatId]) this.profiles[chatId] = {};

    for (const [userId, data] of Object.entries(updatesMap)) {
        const current = this.profiles[chatId][userId] || { realName: null, facts: "", attitude: "нейтрально", relationship: 50 };

        if (data.realName && data.realName !== "неизвестно") current.realName = data.realName;
        if (data.facts) current.facts = data.facts;
        if (data.attitude) current.attitude = data.attitude;
        if (data.location) current.location = data.location;

        if (data.relationship !== undefined) {
          const newScore = parseInt(data.relationship, 10);
          if (!isNaN(newScore)) {
            const oldScore = current.relationship || 50;
            const delta = newScore - oldScore;

            let clampedDelta = delta;
            if (delta > 0) {
              clampedDelta = Math.min(delta, 3);
            } else if (delta < 0) {
              clampedDelta = Math.max(delta, -10);
              if (clampedDelta > -5 && clampedDelta < 0) clampedDelta = -5;
            }

            current.relationship = Math.max(0, Math.min(100, oldScore + clampedDelta));

            if (delta !== clampedDelta) {
              console.log(`[relationship clamp] ${userId}: ai хотел ${delta > 0 ? '+' : ''}${delta}, применил ${clampedDelta > 0 ? '+' : ''}${clampedDelta}`);
            }
          }
        }

        this.profiles[chatId][userId] = current;
    }
    this.saveProfiles();
  }

  findProfileByQuery(chatId, query) {
    if (!this.profiles[chatId]) return null;
    const chat = this.getChat(chatId);
    const q = query.toLowerCase().replace('@', '');
    
    for (const [uid, usernameRaw] of Object.entries(chat.users)) {
        if (usernameRaw.toLowerCase().includes(q)) {
            const p = this.getProfile(chatId, uid);
            return { ...p, username: usernameRaw };
        }
    }

    for (const [uid, profile] of Object.entries(this.profiles[chatId])) {
        if (profile.realName && profile.realName.toLowerCase().includes(q)) {
            const usernameRaw = chat.users[uid] || "unknown";
            return { ...profile, username: usernameRaw };
        }
    }

    return null;
  }

  // === БАН-ХАММЕР ===

  isBanned(userId) {
    if (!this.data.bannedUsers) return false;
    return !!this.data.bannedUsers[userId];
  }

  banUser(userId, info) {
    if (!this.data.bannedUsers) this.data.bannedUsers = {};
    this.data.bannedUsers[userId] = info || "забанен админом";
    this.save();
  }

  unbanUser(userId) {
    if (!this.data.bannedUsers) return;
    delete this.data.bannedUsers[userId];
    this.save();
  }

  getBannedList() {
    return this.data.bannedUsers || {};
  }

  findUserIdByUsername(username) {
    const target = username.replace('@', '').toLowerCase();

    for (const chat of Object.values(this.data.chats)) {
        for (const [uid, uName] of Object.entries(chat.users)) {
            if (String(uName).toLowerCase().includes(target)) {
                return uid;
            }
        }
    }
    return null;
  }

  // === ПРОФИЛИ ЧАТОВ ===

  getChatProfile(chatId) {
    if (!this.chatProfiles[chatId]) {
      return { topic: null, facts: null, style: null, lastUpdated: null };
    }
    return this.chatProfiles[chatId];
  }

  hasChatProfile(chatId) {
    return !!(this.chatProfiles[chatId] && this.chatProfiles[chatId].topic);
  }

  updateChatProfile(chatId, updates) {
    if (!this.chatProfiles[chatId]) {
      this.chatProfiles[chatId] = { topic: null, facts: null, style: null, lastUpdated: null };
    }

    const current = this.chatProfiles[chatId];

    if (updates.topic) {
      current.topic = updates.topic.substring(0, 200);
    }

    if (updates.facts) {
      current.facts = updates.facts.substring(0, 500);
    }

    if (updates.style) {
      current.style = updates.style;
    }

    current.lastUpdated = new Date().toISOString();
    this.chatProfiles[chatId] = current;
    this.saveChatProfiles();

    console.log(`[chat profile] обновлён профиль чата ${chatId}: "${current.topic}"`);
  }

  setChatTopic(chatId, topic) {
    if (!this.chatProfiles[chatId]) {
      this.chatProfiles[chatId] = { topic: null, facts: null, style: null, lastUpdated: null };
    }

    this.chatProfiles[chatId].topic = topic.substring(0, 200);
    this.chatProfiles[chatId].lastUpdated = new Date().toISOString();
    this.saveChatProfiles();

    console.log(`[chat profile] тема установлена для ${chatId}: "${topic}"`);
  }
}

module.exports = new StorageService();
