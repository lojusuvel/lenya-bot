// src/services/ai.js
const config = require('../config');
const storage = require('./storage');

// Заглушка, чтобы не падало
module.exports = {
    getResponse: async (history, msg, imageBuffer, mimeType, instruction, userProfile, isSpontaneous, chatProfile) => {
        return "привет, я лёня. пока что работаю в тестовом режиме.";
    },
    analyzeBatch: async (buffer, currentProfiles) => {
        return {};
    },
    analyzeUserImmediate: async (context, profile) => {
        return null;
    },
    generateProfileDescription: async (profile, name) => {
        return `пользователь ${name}`;
    },
    generateFlavorText: async (task, result) => {
        return `результат: ${result}`;
    },
    determineReaction: async (context) => {
        return null;
    },
    getStatsReport: () => {
        return "статистика пока пуста";
    },
    parseReminder: async (text, replyContent) => {
        return null;
    },
    processManualChatDescription: async (description, currentProfile) => {
        return { topic: description, facts: null, style: 'informal' };
    },
    analyzeChatProfile: async (messages, currentProfile) => {
        return null;
    },
    transcribeAudio: async (buffer, userName, mimeType) => {
        return { summary: "голосовое сообщение", text: "расшифровка недоступна" };
    },
    describeImage: async (buffer, mimeType) => {
        return "описание картинки недоступно";
    },
    setBot: (bot) => {}
};
