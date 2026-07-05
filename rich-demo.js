// === ДЕМО / СМОУК-ТЕСТ RICH MESSAGES ===
// Шлёт АДМИНУ в личку набор примеров новых "богатых" сообщений + живые ответы нейронки.
// Только отправка (без polling) — НЕ конфликтует с прод-ботом на сервере.
//
// Запуск из корня проекта:  node scripts/rich-demo.js
// Нужен .env с TELEGRAM_BOT_TOKEN, ADMIN_USER_ID и хотя бы одним AI-ключом.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');
const config = require('../src/config');
const ai = require('../src/services/ai');
const { sendRich } = require('../src/utils/rich');

const bot = new TelegramBot(config.telegramToken, { polling: false });
ai.setBot(bot);
const ADMIN = config.adminId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(label, content, opts) {
  try {
    const res = await sendRich(bot, ADMIN, content, opts);
    console.log(`[DEMO] ${label.padEnd(18)} -> ${res.mode}${res.error ? '  («' + res.error + '»)' : ''}`);
  } catch (e) {
    console.error(`[DEMO] ${label.padEnd(18)} -> FAILED: ${e.response?.data?.description || e.message}`);
  }
  await sleep(1000);
}

async function ask(label, question, instruction = '') {
  try {
    const text = await ai.getResponse(
      [], { sender: 'admin', text: question, replyText: '' },
      null, 'image/jpeg', instruction, null, false, null
    );
    console.log(`[DEMO] AI "${question.slice(0, 30)}..." -> ${text ? text.length + ' симв.' : 'ПУСТО'}`);
    await send(label, { markdown: text || '_(нейронка вернула пустоту)_' });
  } catch (e) {
    console.error(`[DEMO] AI "${question.slice(0, 30)}" FAILED: ${e.message}`);
    await send(label, { markdown: `⚠️ не смог получить ответ: \`${e.message}\`` });
  }
}

async function main() {
  if (!ADMIN) { console.error('[DEMO] нет admin_user_id в .env'); process.exit(1); }
  console.log(`[DEMO] шлю примеры админу ${ADMIN}...\n`);

  // 0) вступление
  await send('intro', { markdown: 'лёнЯ обновился! теперь умею красиво оформлять сообщения. лови примеры ⬇️' });

  // 1) статистика — как будет выглядеть «лёня стата»
  await send('stats', { html:
`<h3>📊 статистика лёни</h3>
<p>сегодня <b>13.06</b> · режим <b>⚡️ api</b></p>
<table>
<tr><th>канал</th><th>запросов</th></tr>
<tr><td>smart (ответы)</td><td>128</td></tr>
<tr><td>logic (анализ)</td><td>540</td></tr>
<tr><td>search (поиск)</td><td>17</td></tr>
</table>
<details><summary>подробнее по периодам</summary>
<p>неделя: api 1 240 · google 88 · поиск 96<br/>месяц: api 5 600 · google 410 · поиск 380<br/>всего: 42.1k запросов</p>
</details>` });

  // 2) help — как будет выглядеть /help
  await send('help', { html:
`<h3>🦉 что я умею</h3>
<b>вижу и слышу</b>
<ul>
<li>кидай войс — расшифрую и сделаю краткую суть</li>
<li>кидай фото / видео / pdf — пойму и прокомментирую</li>
<li>гуглю актуальное: курсы, погода, новости</li>
</ul>
<details><summary>🎲 развлекуха и 🕵️ досье</summary>
<ul>
<li>«лёня стрельни» — игра: угадай число 1-10</li>
<li>«лёня кто я?» — досье на тебя</li>
<li>«лёня стата» — расход токенов</li>
</ul>
</details>` });

  // 3) расшифровка войса
  await send('voice', { html:
`<p>🎙 <b>краткая суть:</b> админ спрашивает, во сколько завтра созвон.</p>
<details><summary>полный текст</summary>
<blockquote>слушай, привет. напомни, пожалуйста, во сколько у нас там завтра созвон? кажется, в два, но я не уверен.</blockquote>
</details>` });

  // 4) алерт админу
  await send('admin-alert', { html:
`<h4>🔔 новый контакт</h4>
<p>📂 чат: <b>лёня тест</b><br/>🆔 <code>-1001234567890</code><br/>👤 @someuser (иван)</p>
<blockquote>привет, а можно у тебя бота такого же попросить?</blockquote>` });

  // 5) досье — «кто я»
  await send('dossier', { html:
`<h4>🕵️ досье: @admin</h4>
<p>репутация: <b>92 / 100</b> — свой 🤝</p>
<blockquote>зовут админ. живёт в японии. любит дерзкие ботов и чёрный юмор.</blockquote>` });

  // === ТЕСТЫ СИНТАКСИСА ===

  await send('checklist-emoji', { html:
`<b>план на день</b>
<ul>
<li>✅ допилить rich-сообщения</li>
<li>⬜ прогнать смоук-тест</li>
<li>⬜ раскатать на прод</li>
</ul>` });

  await send('checklist-native', { html:
`<b>нативные чекбоксы?</b>
<ul>
<li><input type="checkbox" checked> готово</li>
<li><input type="checkbox"> не готово</li>
</ul>` });

  await send('table-aligned', { html:
`<table class="striped">
<tr><th>модель</th><th align="right">цена/ответ</th></tr>
<tr><td>gemma 3 27b</td><td align="right">0.006 ₽</td></tr>
<tr><td>gemini 3 flash</td><td align="right">0.10 ₽</td></tr>
<tr><td>perplexity sonar</td><td align="right">0.43 ₽</td></tr>
</table>` });

  await send('spoiler', { html:
`спойлер-тег: <tg-spoiler>секрет один</tg-spoiler>
span-вариант: <span class="tg-spoiler">секрет два</span>` });

  await send('quote-code', { html:
`<blockquote>преждевременная оптимизация — корень всех зол.<cite>дональд кнут</cite></blockquote>
<pre><code class="language-js">const lenya = "🦉";
console.log("лёня на связи", lenya);</code></pre>` });

  await send('divider', { html: `сверху текст<hr/>снизу текст после разделителя` });

  await send('markdown-field', { markdown:
`# заголовок markdown

обычный абзац с **жирным** и _курсивом_.

- пункт раз
- пункт два

| a | b |
|---|---|
| 1 | 2 |

> цитата

\`\`\`js
const x = 1;
\`\`\`` });

  // === ЖИВЫЕ ОТВЕТЫ НЕЙРОНКИ ===
  console.log('\n[DEMO] спрашиваю нейронку (живые ответы)...');
  await send('--- ai ---', { markdown: '🤖 *а теперь — живые ответы нейронки:*' });

  await ask('ai-casual', 'лёня, здарова! как сам, чё делаешь?');
  await ask('ai-fact', 'лёня, в каком году вышел первый айфон?');
  await ask('ai-table',
    'лёня, объясни по-простому разницу между tcp и udp и сведи различия в табличку',
    'сейчас уместно ответить подробно: используй markdown — короткий заголовок, и обязательно таблицу сравнения.');
  await ask('ai-list',
    'лёня, накидай 5 коротких пунктов, как новичку начать бегать',
    'ответь нумерованным списком из 5 пунктов в markdown.');
  
  // === НОВАЯ ИГРА "СТРЕЛЬНИ" ===
  await send('game-shot', { html:
`<h4>🔫 игра "стрельни"</h4>
<p>напиши <b>лёня стрельни</b> — я загадаю число от 1 до 10, а ты попробуй угадать!</p>
<p>пример:<br/>
<code>лёня стрельни 5</code> — если угадаешь — я скажу "попал!", если нет — "мимо, братишка"</p>
` });

  // === ПРО ВРЕМЯ (ТОКИО) ===
  await send('time-tokyo', { html:
`<p>⏰ <b>время — токио (utc+9)</b></p>
<blockquote>сервер теперь в японии. если спросишь "сколько время?" — скажу по твоему часовому поясу.</blockquote>
` });
}

main().then(() => { console.log('\n[DEMO] готово.'); process.exit(0); })
  .catch((e) => { console.error('[DEMO] фатал:', e); process.exit(1); });
