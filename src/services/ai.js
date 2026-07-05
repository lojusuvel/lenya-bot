const axios = require('axios');
const config = require('../config');

let botInstance = null;

function setBot(bot) {
    botInstance = bot;
}

// === ГЕНЕРАЦИЯ ОТВЕТА ЧЕРЕЗ OPENROUTER ===
async function getResponse(history, msg, imageBuffer, mimeType, instruction, userProfile, isSpontaneous, chatProfile) {
    try {
        // Берем ключ из переменных окружения
        const apiKey = process.env.AI_API_KEY || config.aiKey;
        if (!apiKey) {
            console.error('AI_API_KEY не найден! Добавь его на Render.');
            return "ошибка: нет ключа api. добавь ai_api_key на рендере.";
        }

        // Собираем историю для контекста
        const historyText = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');

        // Промпт с характером Лёни
        const prompt = `
Ты — Лёня. Тебе 27 лет. Ты уставший, ироничный, но справедливый.
Твой стиль: коротко, по делу, с матом, но без агрессии (если не заслужили).
Пиши с маленькой буквы, без точек в конце, почти без смайлов.
Если вопрос тупой — можешь послать (в шутку). Если нормальный — помоги.
Никогда не говори "я языковая модель" или "я ИИ".

История чата:
${historyText}

Собеседник: ${msg.sender}
Сообщение: ${msg.text}
${msg.replyText ? `Ответ на: ${msg.replyText}` : ''}

Твой ответ (в стиле Лёни, коротко, 1-3 предложения):
`;

        // Отправляем запрос в OpenRouter
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'mistralai/mistral-7b-instruct:free', // Бесплатная модель
                messages: [
                    { role: 'system', content: 'Ты — Лёня, дерзкий бот с характером.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 200,
                temperature: 0.9
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const text = response.data.choices[0].message.content;
        return text || "не, я хз чё сказать";

    } catch (error) {
        console.error('AI Error:', error.response?.data || error.message);
        return "бля, ошибка. попробуй позже.";
    }
}

// === ОСТАЛЬНЫЕ ФУНКЦИИ (заглушки) ===
async function analyzeBatch(buffer, currentProfiles) {
    return {};
}

async function analyzeUserImmediate(context, profile) {
    return null;
}

async function generateProfileDescription(profile, name) {
    return `👤 ${name}\nРепутация: ${profile.relationship || 50}/100\n${profile.facts || 'ничего не знаю о нём'}`;
}

async function generateFlavorText(task, result) {
    return `результат: ${result}`;
}

async function determineReaction(context) {
    return null;
}

function getStatsReport() {
    return "📊 статистика пока пуста";
}

async function parseReminder(text, replyContent) {
    return null;
}

async function processManualChatDescription(description, currentProfile) {
    return { topic: description, facts: null, style: 'informal' };
}

async function analyzeChatProfile(messages, currentProfile) {
    return null;
}

async function transcribeAudio(buffer, userName, mimeType) {
    return { summary: "голосовое сообщение", text: "расшифровка недоступна" };
}

async function describeImage(buffer, mimeType) {
    return "описание картинки недоступно";
}

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
