const axios = require('axios');
const config = require('../config');

let botInstance = null;

function setBot(bot) {
    botInstance = bot;
}

async function getResponse(history, msg, imageBuffer, mimeType, instruction, userProfile, isSpontaneous, chatProfile) {
    try {
        const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
        if (!apiKey) {
            console.error('GOOGLE_GEMINI_API_KEY не найден!');
            return "ошибка: нет ключа gemini.";
        }

        const historyText = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');

        const prompt = `
Ты — Лёня. Тебе 27 лет. Ты уставший, ироничный, но справедливый.
Твой стиль: коротко, по делу, с матом, но без агрессии.
Пиши с маленькой буквы, без точек в конце.
Никогда не говори "я языковая модель" или "я ИИ".

История чата:
${historyText}

Собеседник: ${msg.sender}
Сообщение: ${msg.text}
${msg.replyText ? `Ответ на: ${msg.replyText}` : ''}

Твой ответ (в стиле Лёни, коротко, 1-3 предложения):
`;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                contents: [
                    {
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    temperature: 0.9,
                    maxOutputTokens: 200
                }
            }
        );

        const text = response.data.candidates[0].content.parts[0].text;
        return text || "не, я хз чё сказать";

    } catch (error) {
        console.error('Gemini Error:', error.response?.data || error.message);
        return "бля, ошибка. попробуй позже.";
    }
}

async function analyzeBatch(buffer, currentProfiles) { return {}; }
async function analyzeUserImmediate(context, profile) { return null; }
async function generateProfileDescription(profile, name) {
    return `👤 ${name}\nРепутация: ${profile.relationship || 50}/100\n${profile.facts || 'ничего не знаю о нём'}`;
}
async function generateFlavorText(task, result) { return `результат: ${result}`; }
async function determineReaction(context) { return null; }
function getStatsReport() { return "📊 статистика пока пуста"; }
async function parseReminder(text, replyContent) { return null; }
async function processManualChatDescription(description, currentProfile) {
    return { topic: description, facts: null, style: 'informal' };
}
async function analyzeChatProfile(messages, currentProfile) { return null; }
async function transcribeAudio(buffer, userName, mimeType) {
    return { summary: "голосовое сообщение", text: "расшифровка недоступна" };
}
async function describeImage(buffer, mimeType) { return "описание картинки недоступно"; }

module.exports = {
    getResponse,
    analyzeBatch,
    analyzeUserImmediate,
    generateProfileDescription,
    generateFlavorText,
    determineReaction,
    getStatsReport,
    parseReminder,
    processManualChatDescription,
    analyzeChatProfile,
    transcribeAudio,
    describeImage,
    setBot
};
