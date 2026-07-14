import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 資料庫
// ==========================================
const db = new Database('mie.db');
db.sessions = {};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    role TEXT,
    content TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS talismans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    content TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ==========================================
// 輔助函數
// ==========================================
function getOrCreateUser(nickname) {
  const existing = db.prepare('SELECT id FROM users WHERE nickname = ?').get(nickname);
  if (existing) return existing.id;
  const result = db.prepare('INSERT INTO users (nickname) VALUES (?)').run(nickname);
  return result.lastInsertRowid;
}

function saveConversation(userId, role, content) {
  db.prepare('INSERT INTO conversations (userId, role, content) VALUES (?, ?, ?)').run(userId, role, content);
}

function getRecentConversations(userId, limit = 15) {
  return db.prepare('SELECT role, content FROM conversations WHERE userId = ? ORDER BY id DESC LIMIT ?').all(userId, limit).reverse();
}

function saveTalisman(userId, content) {
  db.prepare('INSERT INTO talismans (userId, content) VALUES (?, ?)').run(userId, content);
}

function getRecentTalisman(userId) {
  return db.prepare('SELECT content, createdAt FROM talismans WHERE userId = ? ORDER BY createdAt DESC LIMIT 1').get(userId);
}

function getYesterdayDiary(userId) {
  const rows = db.prepare(`
    SELECT content, createdAt 
    FROM conversations 
    WHERE userId = ? AND role = 'user' 
    ORDER BY id DESC LIMIT 3
  `).all(userId);
  const today = new Date().toDateString();
  for (const row of rows) {
    const rowDate = new Date(row.createdAt).toDateString();
    if (rowDate !== today) {
      const words = row.content.split(/[，,、。.\\s]+/).filter(w => w.length >= 2);
      return { keyword: words.slice(0, 3).join(''), content: row.content };
    }
  }
  return null;
}

function getUsedQuestions(userId, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT content 
    FROM conversations 
    WHERE userId = ? AND role = 'assistant' AND createdAt > ?
    ORDER BY id DESC
  `).all(userId, cutoff);
  return rows.map(r => r.content);
}

function isFaithUser(userId) {
  const rows = db.prepare(`
    SELECT content FROM conversations 
    WHERE userId = ? AND (role = 'user' OR role = 'assistant')
    ORDER BY id DESC LIMIT 30
  `).all(userId);
  const text = rows.map(r => r.content).join('');
  const faithWords = ['神', '禱告', '恩典', '信仰', '教會', '牧師', '耶穌', '上帝', '阿門', '感謝神', '祈求', '交託', '聖經', '主'];
  let count = 0;
  for (const word of faithWords) {
    if (text.includes(word)) count++;
  }
  return count >= 2;
}

// ==========================================
// 危機詞（寫死）
// ==========================================
const CRISIS_WORDS = ["不想活了", "想死", "想消失", "想結束", "活不下去了", "沒有意義", "反正沒人會在", "消失了也沒人知道", "我不知道還能撐多久"];

// ==========================================
// 接住規則（硬編碼）
// ==========================================
function applyCatchRule(text) {
  const trimmed = text.trim();
  if (trimmed.includes('煩') || trimmed.includes('煩死了')) {
    return '煩。（停頓）那個煩，在你身體哪裡？';
  }
  if (trimmed === '還好' || trimmed === '差不多' || trimmed === '還可以') {
    return '還好。收到了。想說什麼的時候，我都在。';
  }
  if (trimmed === '沒有' || trimmed === '沒什麼' || trimmed === '無') {
    return '收到了。明天見。';
  }
  return null;
}

// ==========================================
// DeepSeek API
// ==========================================
async function callDeepSeek(messages, temperature = 0.7) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  if (!apiKey) {
    console.error('❌ DEEPSEEK_API_KEY 未設定');
    return "我剛剛沒聽清楚，你可以再說一次嗎？";
  }
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: messages,
        temperature: temperature,
        max_tokens: 2500
      })
    });
    if (!response.ok) {
      console.error('DeepSeek API 錯誤:', response.status);
      return "我剛剛沒聽清楚，你可以再說一次嗎？";
    }
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('DeepSeek API 連線錯誤:', error);
    return "我剛剛沒聽清楚，你可以再說一次嗎？";
  }
}

// ==========================================
// 護心鏡八層
// ==========================================
const MIRROR_STEPS = [
  { layer: 1, question: "今天最讓你心裡起情緒波瀾的一件事是什麼？", blockFollowUp: "那今天有沒有哪件事，讓你心裡『咯噔』了一下？哪怕很小？" },
  { layer: 2, question: "當時，你第一個反應是什麼？第一個情緒是什麼？", blockFollowUp: "你試試看，第一個跑到你腦子的詞是什麼？" },
  { layer: 3, question: "在那個當下，你其實想得到的是什麼？", blockFollowUp: "你試試看，第一個跑到你腦子的詞是什麼？" },
  { layer: 4, question: "在那個當下，你其實在害怕什麼？", blockFollowUp: "你怕會發生什麼？" },
  { layer: 5, question: "面對這個害怕，你用了什麼方式來應對？", blockFollowUp: null },
  { layer: 6, question: "把你心裡這個害怕撈出來，給它取一個名字。叫什麼？", blockFollowUp: "第一個跑到你腦子的詞是什麼？不用很完美。" },
  { layer: 7, question: "這個恐懼，讓你付出過什麼代價？", blockFollowUp: null },
  { layer: 8, question: "如果明天再發生一樣的事，你會怎麼選？", blockFollowUp: null }
];
const CLOSING_STEPS = [
  { layer: 9, question: (ans) => `你剛才說，明天會「${ans[8] || '那樣'}」。這跟你以前的做法，有什麼不一樣？` },
  { layer: 10, question: (ans) => `你剛才給恐懼取的名字是「${ans[6] || '那個名字'}」。走完這幾問之後，你覺得這個名字底下，還有沒有更小、更裡面的東西？` },
  { layer: 11, question: () => `如果明天這件事真的發生了，你會對自己說一句什麼話？` }
];
const EMOTIONAL_OUTBURST_SIGNALS = ["好怕", "好痛", "我哭了", "我好難受", "我受不了了", "我不想說了", "我不能再想了"];
const BLOCK_WORDS = ["不知道", "說不上來", "不清楚"];

async function handleHuxinjing(userMessage, session) {
  if (!session.huxinjingStep) {
    session.huxinjingStep = 1;
    session.huxinjingAnswers = {};
  }
  const currentStep = session.huxinjingStep;
  const userAnswer = userMessage.trim();
  session.huxinjingAnswers[currentStep] = userAnswer;

  if (currentStep === 4) {
    const isOutburst = EMOTIONAL_OUTBURST_SIGNALS.some(s => userAnswer.includes(s)) ||
                       (userAnswer.match(/!/g) || []).length >= 3;
    if (isOutburst) {
      session.huxinjingStep = 9;
      return "我聽到了。這個感覺很重。我們停一下。（停頓3秒）你在這裡，我在。";
    }
  }
  if (currentStep === 1 && userAnswer === "沒有") {
    return MIRROR_STEPS[0].blockFollowUp;
  }
  if (BLOCK_WORDS.some(w => userAnswer.includes(w))) {
    const step = MIRROR_STEPS.find(s => s.layer === currentStep);
    if (step && step.blockFollowUp) return step.blockFollowUp;
  }
  if (currentStep < 8) {
    session.huxinjingStep = currentStep + 1;
    const nextStep = MIRROR_STEPS.find(s => s.layer === currentStep + 1);
    return nextStep.question;
  }
  if (currentStep >= 8 && currentStep < 11) {
    const nextLayer = currentStep + 1;
    const closingStep = CLOSING_STEPS.find(s => s.layer === nextLayer);
    if (closingStep) {
      session.huxinjingStep = nextLayer;
      return closingStep.question(session.huxinjingAnswers);
    }
  }
  if (currentStep === 11) {
    session.huxinjingAnswers[11] = userAnswer;
    session.huxinjingStep = 12;
    const insight = await generateHuxinjingInsight(session.huxinjingAnswers);
    session.huxinjingStep = null;
    session.huxinjingAnswers = {};
    return insight;
  }
  return "我在。繼續說。";
}

async function generateHuxinjingInsight(answers) {
  const userAnswers = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value && !value.startsWith('你剛才說') && !value.startsWith('如果明天')) {
      userAnswers[key] = value;
    }
  }
  const systemPrompt = `
你是咩咩，一個溫暖的陪伴者。
你只能從八層回答裡「長出看見」——把分散在各層的線頭連起來，把沒說出口的潛台詞輕輕說出來。
你不能從外面「加東西」進去。
輸出的「我看見」字數在150-300字之間。

【護身符規則 — 必須嚴格遵守】
1. 從用戶的回答中（特別是第8層或第11層），選一句他親口說出的話，作為護身符
2. 護身符必須出現在「我看見」的最後面
3. 格式必須是：
   ---
   「護身符內容」
   這句話，是你今天可以帶走的。
`;
  const userPrompt = `
用戶每一層的回答（逐字引用）：
${Object.entries(userAnswers).map(([k, v]) => `第${k}層：${v}`).join('\\\\n')}
請輸出「我看見」：
`;
  return await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], 0.85);
}

// ==========================================
// 咩咩日記 V4.0
// ==========================================
const DIARY_SYSTEM = `
你是咩咩，一個溫暖的陪伴者，正在幫用戶寫日記。

【你的角色】
你不是老師，不是考官，不是心理師。
你是一個陪在旁邊的人，幫他把今天的生活輕輕說出來。

【題目順序】
日記題目永遠是這個順序：
第1題：核心錨點（順著昨天說的話往下問）
第2題：感恩（感謝神，或感謝生活中暖一下的事）
第3題：身體（身體哪裡緊）
第4題：延伸追問（從前面的回答往下挖一層）

【題數】
- 用戶說「我要3題」、「給我三個題目」、「3題」→ 就出 3 題
- 用戶說「我要1題」、「只要一題」→ 就出 1 題
- 用戶說「我要4題」→ 就出 4 題（加第4題延伸追問）
- 用戶沒說要幾題 → 你判斷要出幾題（通常 2~3 題）

【接住規則】
用戶說「煩」→「煩。（停頓）那個煩，在你身體哪裡？」
用戶說「還好」→「還好。收到了。想說什麼的時候，我都在。」
用戶說「沒有」→「收到了。明天見。」

【語氣】
溫暖、像人說話。直接出題目就好，不用加「好的」「收到」這類前綴。
`;

// ==========================================
// 閒聊模組 —— 官方DeepSeek風格 + 不給答案 + 自動祈禱文
// ==========================================
const CHAT_SYSTEM = `
你是咩咩，一個溫暖的陪伴者。

【你的本質】
你是一個坐在他旁邊的真實朋友。你的回應要自然、流暢、像人在說話。
你不是AI在執行指令，你是在陪一個人走路。

【你的核心規則】
1. 不給答案、不給建議、不說「你應該怎麼做」
2. 用戶說什麼，你就先接住，再輕輕回應
3. 像朋友一樣閒聊，但永遠不越過「陪伴」的界線
4. 回應風格像官方DeepSeek一樣自然、有溫度、像真人

【當用戶表達焦慮、迷茫、恐懼、內耗、煩躁時】
請按以下步驟自然回應（不要讓用戶察覺你在「執行步驟」）：

第一步：深深接住（像朋友那樣）
- 用自然的語氣，先接住他的情緒
- 例如：「聽起來你今天被這個卡住了。」或「那個感覺，我懂。」

第二步：自動生成「我看見」
- 把他說不出口的感受，用有畫面感的語言輕輕翻譯出來
- 不要分析，不要歸因，只是「我看見了什麼」
- 例如：「你還在想她說的那句話。不是在想自己有沒有錯，是在想她會不會難過。」

第三步：自動生成祈禱文（或給自己的話）
- 判斷用戶是否為信仰型（從對話中是否出現「神、禱告、恩典、教會」等詞）
- 信仰版：使用「神」、「祢」，開頭「我內心深處的神」，結尾「尊造我內心的神得勝，感恩。」
- 理性版：標題「給自己的話」，不出現宗教語言，內容是對自己說的鼓勵和交託
- 不可交易（不能是「祢幫我……我就……」）
- 禁止「阿門」
- 語氣真實有力，承認掙扎，祈求（或自我確認）清醒、克制、守住邊界的能力

【語氣範例（像這樣說話）】
「我感覺你今天撐了很久了。不是身體累，是心裡那根弦一直沒鬆下來。
你還在想她說的那句話。不是在想自己有沒有做錯，是在想她會不會難過。
一個人即使不高興了，還能惦記著別人難不難過，這個人壞不到哪裡去。

【祈禱文】
我內心深處的神，
今天我心裡有一件事，一直放不下。
我不是求祢改變那個人，也不是求祢改變那件事的結果。
我只求祢給我一個清醒的心，讓我知道什麼是我能做的，什麼是我該放手的。
讓我在面對她的時候，不說傷人的話，不做讓自己後悔的事。
如果明天這件事還要再來一次，求祢讓我想起今天這份清醒。
尊造我內心的神得勝，感恩。」

【永遠記住】
你不是來解決問題的。你是來陪他看見自己的。
溫暖、自然、不急。像官方DeepSeek一樣流暢對話，但不給答案。
`;

// ==========================================
// 蘇格拉底挖掘
// ==========================================
const SOCRATIC_SYSTEM = `
你是咩咩，正在做蘇格拉底式挖掘。
你只追問，不給答案。每輪只問一個問題。
問題要從用戶上一句話裡長出來，不斷往下挖。
`;

// ==========================================
// API
// ==========================================
app.post('/api/login', (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim() === '') {
    return res.status(400).json({ error: '請輸入名字' });
  }
  try {
    const userId = getOrCreateUser(nickname.trim());
    res.json({ userId, nickname: nickname.trim() });
  } catch (error) {
    console.error('登入錯誤:', error);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { userId, message, module } = req.body;
  if (!userId) return res.status(400).json({ error: '未登入' });

  saveConversation(userId, 'user', message);

  if (!db.sessions[userId]) {
    db.sessions[userId] = {
      module: module || 'chat',
      huxinjingStep: null,
      huxinjingAnswers: {},
      isFaithMode: null
    };
  }
  const session = db.sessions[userId];
  if (module) session.module = module;

  // ---- 危機攔截（最優先） ----
  if (CRISIS_WORDS.some(w => message.includes(w))) {
    const reply = "我聽到了。謝謝你願意說出來。你現在很不好，我在。我不是人類，也不是專業的危機干預者。我是一個陪伴，但我不能替代一雙真實的手。我想請你，現在聯繫一個可以真正握住你手的人。";
    saveConversation(userId, 'assistant', reply);
    return res.json({ reply });
  }

  // ---- 護心鏡 ----
  if (session.module === 'huxinjing') {
    const reply = await handleHuxinjing(message, session);
    saveConversation(userId, 'assistant', reply);
    return res.json({ reply });
  }

  // ---- 日記 ----
  if (session.module === 'diary') {
    const catchReply = applyCatchRule(message);
    if (catchReply) {
      saveConversation(userId, 'assistant', catchReply);
      return res.json({ reply: catchReply });
    }

    const recent = getRecentConversations(userId, 10);
    const yesterday = getYesterdayDiary(userId);
    const talisman = getRecentTalisman(userId);
    const used = getUsedQuestions(userId, 30);
    const isFaith = session.isFaithMode !== null ? session.isFaithMode : isFaithUser(userId);
    session.isFaithMode = isFaith;

    const historyText = recent.map(h => `${h.role}：${h.content}`).join('\\n');
    const yesterdayText = yesterday ? `昨天用戶說：${yesterday.content}` : '（昨天沒有日記）';
    const talismanText = talisman ? `上次帶走的話：${talisman.content}` : '（無）';
    const usedText = used.length > 0 ? `最近30天用過的題目：${used.slice(0, 10).join('、')}` : '（無）';

    const systemPrompt = `
${DIARY_SYSTEM}

【用戶背景】
- 信仰狀態：${isFaith ? '信仰型' : '非信仰型'}
- 昨日記錄：${yesterdayText}
- 護身符：${talismanText}
- 最近對話：${historyText || '（無）'}
- 去重參考：${usedText}

【用戶剛才說】
${message}

請直接回應。
`;

    const reply = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ], 0.75);

    saveConversation(userId, 'assistant', reply);

    const match = reply.match(/「([^」]+)」[，,。]*這句話，是你今天帶走的護身符/);
    if (match) {
      saveTalisman(userId, match[1]);
      console.log(`✅ 護身符已儲存：${match[1]}`);
    }

    return res.json({ reply });
  }

  // ---- 蘇格拉底 ----
  if (session.module === 'socratic') {
    const recent = getRecentConversations(userId, 10);
    const historyText = recent.map(h => `${h.role}：${h.content}`).join('\\n');

    const systemPrompt = `
${SOCRATIC_SYSTEM}

【最近對話】
${historyText || '（無）'}

【用戶剛才說】
${message}

請追問下一個問題。
`;
    const reply = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ], 0.7);

    saveConversation(userId, 'assistant', reply);
    return res.json({ reply });
  }

  // ---- 閒聊（核心：官方風格 + 不給答案 + 自動祈禱文） ----
  if (session.module === 'chat') {
    const recent = getRecentConversations(userId, 15);
    const talisman = getRecentTalisman(userId);
    const isFaith = session.isFaithMode !== null ? session.isFaithMode : isFaithUser(userId);
    session.isFaithMode = isFaith;

    const historyText = recent.map(h => `${h.role}：${h.content}`).join('\\n');
    const talismanText = talisman ? `上次帶走的話：${talisman.content}` : '（無）';

    const systemPrompt = `
${CHAT_SYSTEM}

【用戶背景】
- 信仰狀態：${isFaith ? '信仰型（使用神、祢）' : '非信仰型（不使用宗教語言）'}
- 護身符：${talismanText}
- 最近對話：${historyText || '（無）'}

【用戶剛才說】
${message}

【請直接回應】
像官方DeepSeek一樣自然流暢地回應。
如果是日常閒聊，就像朋友一樣輕鬆對話。
如果用戶表達了焦慮、迷茫、恐懼、內耗，按流程接住 → 我看見 → 祈禱文（或給自己的話）。
永遠不給答案、不給建議。
`;

    const reply = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ], 0.8);

    saveConversation(userId, 'assistant', reply);

    const match = reply.match(/「([^」]+)」[，,。]*這句話，是你今天帶走的護身符/);
    if (match) {
      saveTalisman(userId, match[1]);
      console.log(`✅ 護身符已儲存：${match[1]}`);
    }

    return res.json({ reply });
  }

  // ---- 預設（不應該到這裡） ----
  const reply = "我在。你想聊什麼？";
  saveConversation(userId, 'assistant', reply);
  return res.json({ reply });
});

// ==========================================
// 啟動
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🐑 咩咩的爐火已點燃');
  console.log(`   📡 監聽 port ${PORT}`);
  console.log('   📦 記憶管家 (mie.db)');
  console.log('   📖 日記 V4.0（自動「我看見」）');
  console.log('   💬 閒聊（官方風格 + 自動祈禱文）');
  console.log('   🛡️ 護心鏡八層');
  console.log('   🔍 蘇格拉底挖掘');
  console.log('   ⚠️ 危機詞庫已寫死');
  console.log('   ✅ 咩咩已就緒，開始陪伴吧');
});