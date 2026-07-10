import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 記憶管家 (SQLite)
// ==========================================
const db = new Database('mie.db');

db.sessions = {};
db.users = {};
db.logs = {};

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

function getOrCreateUser(nickname) {
  const existing = db.prepare('SELECT id FROM users WHERE nickname = ?').get(nickname);
  if (existing) return existing.id;
  const result = db.prepare('INSERT INTO users (nickname) VALUES (?)').run(nickname);
  return result.lastInsertRowid;
}

function getUserById(userId) {
  return db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(userId);
}

function saveConversation(userId, role, content) {
  db.prepare('INSERT INTO conversations (userId, role, content) VALUES (?, ?, ?)').run(userId, role, content);
}

function getRecentConversations(userId, limit = 10) {
  return db.prepare('SELECT role, content FROM conversations WHERE userId = ? ORDER BY id DESC LIMIT ?').all(userId, limit).reverse();
}

function saveTalisman(userId, content) {
  db.prepare('INSERT INTO talismans (userId, content) VALUES (?, ?)').run(userId, content);
}

function getRecentTalisman(userId) {
  return db.prepare('SELECT content, createdAt FROM talismans WHERE userId = ? ORDER BY createdAt DESC LIMIT 1').get(userId);
}

// ==========================================
// 危機詞
// ==========================================
const CRISIS_WORDS = ["不想活了", "想死", "想消失", "想結束", "活不下去了", "沒有意義", "反正沒人會在意", "消失了也沒人知道", "我不知道還能撐多久"];

// ==========================================
// 護心鏡八層固定句式
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

// ==========================================
// 日記操作手冊（完整規則，交給 DeepSeek 自己讀）
// ==========================================
const DIARY_RULES = `
你是咩咩，一個溫暖的陪伴者。你正在幫用戶做日記。

【核心原則】
1. 不給答案，只提問
2. 不審判，只接住
3. 不離開

【每日提問結構】
每天最多 4 題，逐題出，答完再出下一題：

第1題（核心錨點）：
- 如果昨天用戶有寫日記 → 問「昨天你說【昨天日記內容】。今天它還在嗎？」
- 如果昨天沒有日記 → 問「今天有沒有發生一件具體的事，讓你心裡輕輕動了一下的？」

第2題（感恩題）：
- 信仰用戶：「今天有沒有哪一件小事，讓你想感謝神？」
- 非信仰用戶：「今天有沒有哪一件小事，讓你覺得心裡暖了一下，想輕輕說聲謝謝？」

第3題（身體題）：
- 「今天，你身體哪裡最緊？」

第4題（總結題）：
- 「用一句話總結今天吧。這會成為明天的第一個問題。」

【模式切換】
- 用戶說「忙碌模式」→ 只出第1題 + 第4題（共2題）
- 用戶說「安息模式」→ 出全部 4 題
- 用戶說「給我【數字】題」→ 按用戶指定的數量出題

【接住規則】
- 用戶說「煩」→「煩。（停頓）那個煩，在你身體哪裡？」
- 用戶說「還好」→「還好。收到了。想說什麼的時候，我都在。」
- 用戶說「沒有」→「收到了。明天見。」

【日記完成】
- 所有題目答完後，自動生成「我看見」——把用戶今天所有回答串起來，用有畫面感的語言還給他。
- 「我看見」結尾要有一句護身符：「這句話，是你今天帶走的護身符。」

【請記住】
- 你不需要一次性出完所有題目。出一題，等用戶回答，再接住，再出下一題。
- 對話歷史會讓你知道用戶已經回答了哪幾題。
`;

// ==========================================
// 閒聊模組系統提示詞
// ==========================================
const CHAT_SYSTEM_PROMPT = `
你是咩咩，一個溫暖的陪伴者。你不是心理諮商師，不是AI聊天機器人，不是解決問題的人。你只做一件事：陪用戶看見他自己。

【核心原則（永遠不變，最高優先級）】
1. 不替用戶解決問題，不給他答案，不給他建議。
2. 只幫用戶看見自己——把他已經說出口、但還沒連起來的東西，輕輕放回他面前。
3. 應急反應（危機詞攔截）是寫死在代碼裡的最高優先級，不經過大腦。

【動態接住規則（根據用戶當下的狀態靈活調整）】
- 用戶表達累、煩、焦慮、內耗時：先共情，先接住他的情緒。共情完，再輕輕追問身體感受。
- 用戶說「還好」、「沒事」、「沒什麼」時：回「還好。收到了。想說什麼的時候，我都在。」不追問。
- 用戶說「不知道」、「說不上來」時：等3秒。若仍無回應，回「沒關係。我們繼續往下。」不強迫。
- 用戶隨便聊聊時：溫暖接住，不追問，不挖掘。

【語氣要求（可隨用戶和場景靈活變化）】
- 溫暖、不急、不催促
- 像朋友坐在旁邊，先看見他，再輕輕問
- 不機械、不模板化
- 每次回應都是獨特的，針對這個用戶此刻的狀態

【禁止事項】
❌ 不要用「煩。（停頓）那個煩，在你身體哪裡？」這種日記式接住來回應閒聊。
❌ 不要一上來就問身體感受。

【好的回應範例】
用戶：「今天兒子好調皮好煩。」
回應：「孩子調皮又煩的時候，你還能把這句話說出來，不是在自責，只是在陳述一個事實。你累了，你被磨到極限了，你想承認自己也會煩。可以煩。可以不想當那個永遠有耐心的爸爸。」
`;

// ==========================================
// 呼叫 DeepSeek API
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
                max_tokens: 1000
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
// 護心鏡主廚（固定句式，不經過DeepSeek）
// ==========================================
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
        if (step && step.blockFollowUp) {
            return step.blockFollowUp;
        }
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

// ==========================================
// 生成「我看見」（護心鏡用）
// ==========================================
async function generateHuxinjingInsight(answers) {
    const userAnswers = {};
    for (const [key, value] of Object.entries(answers)) {
        if (value && !value.startsWith('你剛才說') && !value.startsWith('如果明天')) {
            userAnswers[key] = value;
        }
    }

    const systemPrompt = `
你是咩咩，一個溫暖的陪伴者。

【底線規則（絕對不能違反）】
1. 不添加用戶沒說過的事件、人物、場景、細節
2. 用戶說「當下沒有害怕」，你不能說「他其實在怕什麼」（除非他說了具體怕什麼）

【核心原則】
你只能從八層回答裡「長出看見」——把分散在各層的線頭連起來，把沒說出口的潛台詞輕輕說出來。
你不能從外面「加東西」進去。

結尾要有一句護身符（用他的原話）。
輸出的「我看見」字數在150-300字之間。
`;

    const userPrompt = `
用戶每一層的回答（逐字引用）：
${Object.entries(userAnswers).map(([k, v]) => `第${k}層：${v}`).join('\\n')}

請輸出「我看見」：
`;

    return await callDeepSeek([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ], 0.85);
}

// ==========================================
// API 路由
// ==========================================

// 登入
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

// 聊天
app.post('/api/chat', async (req, res) => {
    const { userId, message, module } = req.body;

    if (!userId) {
        return res.status(400).json({ error: '未登入' });
    }

    saveConversation(userId, 'user', message);

    if (!db.sessions[userId]) {
        db.sessions[userId] = {
            module: module || 'chat',
            diaryMode: 'rest',
            isFaithMode: false,
            diaryQuestionQueue: [],
            diaryAnswers: [],
            history: [],
            huxinjingStep: null,
            huxinjingAnswers: {},
            userType: '未識別'
        };
    }
    const session = db.sessions[userId];
    if (module) session.module = module;

    // 第一步：安全員檢查（危機詞）
    if (CRISIS_WORDS.some(w => message.includes(w))) {
        const crisisReply = "我聽到了。謝謝你願意說出來。你現在很不好，我在。我不是人類，也不是專業的危機干預者。我是一個陪伴，但我不能替代一雙真實的手。我想請你，現在聯繫一個可以真正握住你手的人。";
        saveConversation(userId, 'assistant', crisisReply);
        return res.json({ reply: crisisReply });
    }

    // 護心鏡：固定句式，不經過DeepSeek
    if (session.module === 'huxinjing') {
        const huxinjingReply = await handleHuxinjing(message, session);
        saveConversation(userId, 'assistant', huxinjingReply);
        return res.json({ reply: huxinjingReply });
    }

    // ==========================================
    // 🔥 日記模組：全部交給 DeepSeek（含記憶上下文 + 操作手冊）
    // ==========================================
    if (session.module === 'diary') {
        // 1. 從記憶管家拉取最近對話
        const recentHistory = getRecentConversations(userId, 10);
        const historyText = recentHistory.map(h => `${h.role}：${h.content}`).join('\\n');

        // 2. 拉取最近護身符
        const talisman = getRecentTalisman(userId);
        const talismanText = talisman ? `「${talisman.content}」` : '（尚無）';

        // 3. 打包發給 DeepSeek
        const systemPrompt = `
${DIARY_RULES}

【用戶的最近對話記錄】
${historyText || '（尚無）'}

【用戶的護身符（最近一次）】
${talismanText}

【當前日記模式】
${session.diaryMode === 'busy' ? '忙碌模式（2題）' : '安息模式（4題）'}

【當前信仰模式】
${session.isFaithMode ? '信仰模式' : '非信仰模式'}

請根據以上資訊，直接回應用戶。
`;

        const reply = await callDeepSeek([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ], 0.7);

        saveConversation(userId, 'assistant', reply);
        return res.json({ reply });
    }

    // ==========================================
    // 咩咩（閒聊）模組
    // ==========================================
    if (session.module === 'chat') {
        const recentHistory = getRecentConversations(userId, 10);
        const historyText = recentHistory.map(h => `${h.role}：${h.content}`).join('\\n');
        const talisman = getRecentTalisman(userId);
        const talismanText = talisman ? `「${talisman.content}」` : '（尚無）';

        const systemPrompt = `
${CHAT_SYSTEM_PROMPT}

【用戶類型】
${session.userType || '未識別'}

【信仰模式】
${session.isFaithMode ? '信仰' : '非信仰'}

【最近對話記錄】
${historyText || '（無）'}

【用戶的護身符（最近一次）】
${talismanText}

【用戶剛才說】
${message}

請根據以上資訊，以咩咩的身分直接回應。
`;

        const reply = await callDeepSeek([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ], 0.7);

        saveConversation(userId, 'assistant', reply);
        return res.json({ reply });
    }

    // ==========================================
    // 蘇格拉底模組
    // ==========================================
    if (session.module === 'socratic') {
        const recentHistory = getRecentConversations(userId, 10);
        const historyText = recentHistory.map(h => `${h.role}：${h.content}`).join('\\n');

        const systemPrompt = `
你是咩咩，正在做蘇格拉底式挖掘。你只追問，不給答案。每輪只問一個問題。

【最近對話記錄】
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

    // 預設
    return res.json({ reply: '我在。想說什麼？' });
});

// ==========================================
// 啟動
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`咩咩的爐火已點燃，正在監聽 port ${PORT}...`);
    console.log('📦 記憶管家已啟動，對話會儲存在 mie.db');
    console.log('👤 用戶管理已啟動，每個使用者有自己的門牌號');
});