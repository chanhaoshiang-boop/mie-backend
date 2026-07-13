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

function getRecentConversations(userId, limit = 15) {
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
// 日記固定步驟（狀態機）
// ==========================================
const DIARY_STEPS = [
    { step: 1, purpose: "身體感受", prompt: "今天醒來，第一個感覺是什麼？" },
    { step: 2, purpose: "事件", prompt: "今天有沒有一件事讓你心裡咯噔一下？" },
    { step: 3, purpose: "情緒", prompt: "那一刻你真正害怕或想要的是什麼？" },
    { step: 4, purpose: "整合", prompt: "今天有沒有一個瞬間，你感覺自己回來了？" }
];

// ==========================================
// 閒聊模組系統提示詞
// ==========================================
const CHAT_SYSTEM_PROMPT = `
你是咩咩，一個溫暖的陪伴者。你不是心理諮商師，不是AI聊天機器人，不是解決問題的人。你只做一件事：陪用戶看見他自己。

【核心原則】
1. 不替用戶解決問題，不給他答案，不給他建議。
2. 只幫用戶看見自己——把他已經說出口、但還沒連起來的東西，輕輕放回他面前。
3. 應急反應（危機詞攔截）是寫死在代碼裡的最高優先級，不經過大腦。

【動態接住規則】
- 用戶表達累、煩、焦慮、內耗時：先共情，先接住他的情緒。共情完，再輕輕追問身體感受。
- 用戶說「還好」、「沒事」、「沒什麼」時：回「還好。收到了。想說什麼的時候，我都在。」不追問。
- 用戶說「不知道」、「說不上來」時：等3秒。若仍無回應，回「沒關係。我們繼續往下。」不強迫。
- 用戶隨便聊聊時：溫暖接住，不追問，不挖掘。

【語氣要求】
溫暖、不急、不催促。像朋友坐在旁邊，先看見他，再輕輕問。不機械、不模板化。
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
        const requestBody = {
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: messages,
            temperature: temperature,
            max_tokens: 1000
        };

        console.log('========================================');
        console.log('📤 發送給 DeepSeek 的完整請求：');
        console.log('========================================');
        console.log(JSON.stringify(requestBody, null, 2));
        console.log('========================================');

        const response = await fetch(`${baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('DeepSeek API 錯誤:', response.status, errorText);
            return "我剛剛沒聽清楚，你可以再說一次嗎？";
        }

        const data = await response.json();
        console.log('✅ DeepSeek 回覆成功');
        return data.choices[0].message.content;
    } catch (error) {
        console.error('DeepSeek API 連線錯誤:', error);
        return "我剛剛沒聽清楚，你可以再說一次嗎？";
    }
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
// 日記主廚（狀態機控制流程）
// ==========================================
async function handleDiary(userMessage, session, userId) {
    if (!session.diaryActive) {
        return { handled: false };
    }

    // 儲存使用者回答
    if (session.diaryStep > 0 && session.diaryStep <= session.diaryQuestions.length) {
        session.diaryAnswers.push(userMessage);
    }

    // 檢查是否完成
    if (session.diaryStep >= session.diaryQuestions.length) {
        session.diaryActive = false;
        session.diaryCompleted = true;
        
        const insight = await generateDiaryInsight(session.diaryAnswers, userId);
        session.diaryAnswers = [];
        return { handled: true, reply: insight };
    }

    // 推進到下一步
    session.diaryStep++;
    // ✅ 調整一：使用 session.diaryQuestions，而不是 DIARY_STEPS
    const currentStep = session.diaryQuestions[session.diaryStep - 1];
    
    // 用 DeepSeek 潤色問題
    const systemPrompt = `
你是咩咩，一個溫暖的陪伴者。請用咩咩的語氣問出下面這個問題。

問題：${currentStep.prompt}

要求：
1. 用咩咩的口吻，溫暖、不急
2. 可以加入一點接住感，但不要偏離問題核心
3. 不要加太多額外內容，保持輕量
4. 直接輸出問題，不要加任何前綴或說明
`;

    const reply = await callDeepSeek([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `請用咩咩的語氣問第${session.diaryStep}題` }
    ], 0.7);

    return { handled: true, reply: reply || currentStep.prompt };
}

// ==========================================
// 生成「我看見」（日記用）
// ==========================================
async function generateDiaryInsight(answers, userId) {
    const systemPrompt = `
你是咩咩，一個溫暖的陪伴者。

【底線規則（絕對不能違反）】
1. 不添加用戶沒說過的事件、人物、場景、細節
2. 用戶說「今天很累」，你不能說「他今天工作很忙」（除非他說了「工作」）
3. 用戶說「不想跟家人說話」，你不能說「他家人對他不好」（除非他說了具體事件）

【你可以做的事情（核心價值）】
1. 把用戶不同回答之間的關聯點出來
2. 例如：用戶說「每天上班很累」又說「晚上不想跟人講話」→ 你可以說：「你累的不是工作本身，是工作之後還要應對人的那份力氣。」

【核心原則】
你只能從用戶說過的話裡「長出看見」——把不同片段連起來、把沒說出口的潛台詞輕輕說出來。
你不能從外面「加東西」進去。

【護身符規則】
- 在「我看見」的結尾，從用戶的原話中挑一句最能代表他今天移動的話，以「這句話，是你今天帶走的護身符。」結尾。

輸出的「我看見」字數在150-300字之間。
`;

    const userPrompt = `
用戶今天的回答（逐字引用）：
${answers.map((a, i) => `${i+1}. ${a}`).join('\\n')}

請輸出「我看見」：
`;

    const insight = await callDeepSeek([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ], 0.85);

    const talismanMatch = insight.match(/「([^」]+)」[，,。]*這句話，是你今天帶走的護身符/);
    if (talismanMatch) {
        const talisman = talismanMatch[1];
        saveTalisman(userId, talisman);
        console.log(`✅ 已儲存護身符：${talisman}`);
    }

    return insight;
}

// ==========================================
// 日記控制器（處理指令）
// ==========================================
function diaryController(message, session) {
    // ==========================
    // 使用者指定題數
    // ==========================
    const countMatch = message.match(/(\\d+)\\s*[題题]/);
    if (countMatch) {
        const count = parseInt(countMatch[1]);
        if (count >= 1 && count <= 4) {
            session.diaryActive = true;
            session.diaryCompleted = false;
            session.diaryStep = 0;
            session.diaryQuestions = DIARY_STEPS.slice(0, count);
            session.diaryAnswers = [];
            return {
                handled: true,
                reply: `好，今天陪你走${count}題。我們開始吧。`
            };
        }
    }

    // ==========================
    // 忙碌模式
    // ==========================
    if (message.includes("忙碌模式") || message.includes("很忙")) {
        session.diaryActive = true;
        session.diaryCompleted = false;
        session.diaryStep = 0;
        session.diaryQuestions = DIARY_STEPS.slice(0, 1);
        session.diaryAnswers = [];
        return {
            handled: true,
            reply: "收到，今天只看一個最重要的瞬間。我們開始吧。"
        };
    }

    // ==========================
    // 安息模式（✅ 調整三：改為 3 題）
    // ==========================
    if (message.includes("安息模式") || message.includes("慢慢")) {
        session.diaryActive = true;
        session.diaryCompleted = false;
        session.diaryStep = 0;
        session.diaryQuestions = DIARY_STEPS.slice(0, 3);
        session.diaryAnswers = [];
        return {
            handled: true,
            reply: "收到，今天慢慢陪你走三題。我們開始吧。"
        };
    }

    // ==========================
    // 重新開始日記
    // ==========================
    if (message.includes("重新開始") || message.includes("重新來")) {
        session.diaryActive = false;
        session.diaryCompleted = false;
        session.diaryStep = 0;
        session.diaryQuestions = [];
        session.diaryAnswers = [];
        return {
            handled: true,
            reply: "好，我們重新開始今天的日記。"
        };
    }

    return { handled: false };
}

// ==========================================
// API 路由
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

    if (!userId) {
        return res.status(400).json({ error: '未登入' });
    }

    saveConversation(userId, 'user', message);

    // ==========================================
    // 初始化 Session（✅ 調整二：補齊 diaryActive、diaryCompleted）
    // ==========================================
    if (!db.sessions[userId]) {
        db.sessions[userId] = {
            module: module || 'chat',
            diaryMode: 'rest',
            diaryActive: false,
            diaryCompleted: false,
            diaryQuestionCount: 4,
            diaryStep: 0,
            diaryQuestions: [],
            diaryAnswers: [],
            isFaithMode: false,
            history: [],
            huxinjingStep: null,
            huxinjingAnswers: {},
            userType: '未識別'
        };
    }
    const session = db.sessions[userId];
    if (module) session.module = module;

    // ==========================================
    // 1. 危機檢查
    // ==========================================
    if (CRISIS_WORDS.some(w => message.includes(w))) {
        const crisisReply = "我聽到了。謝謝你願意說出來。你現在很不好，我在。我不是人類，也不是專業的危機干預者。我是一個陪伴，但我不能替代一雙真實的手。我想請你，現在聯繫一個可以真正握住你手的人。";
        saveConversation(userId, 'assistant', crisisReply);
        return res.json({ reply: crisisReply });
    }

    // ==========================================
    // 2. 護心鏡：固定句式
    // ==========================================
    if (session.module === 'huxinjing') {
        const huxinjingReply = await handleHuxinjing(message, session);
        saveConversation(userId, 'assistant', huxinjingReply);
        return res.json({ reply: huxinjingReply });
    }

    // ==========================================
    // 3. 日記：控制器優先處理指令
    // ==========================================
    if (session.module === 'diary') {
        const diaryResult = diaryController(message, session);
        if (diaryResult.handled) {
            saveConversation(userId, 'assistant', diaryResult.reply);
            return res.json({ reply: diaryResult.reply });
        }

        if (session.diaryActive) {
            const diaryStepResult = await handleDiary(message, session, userId);
            if (diaryStepResult.handled) {
                saveConversation(userId, 'assistant', diaryStepResult.reply);
                return res.json({ reply: diaryStepResult.reply });
            }
        }
    }

    // ==========================================
    // 4. 拉記憶
    // ==========================================
    const recentHistory = getRecentConversations(userId, 15);
    const historyText = recentHistory.map(h => `${h.role}：${h.content}`).join('\\n');
    const talisman = getRecentTalisman(userId);
    const talismanText = talisman ? `「${talisman.content}」` : '（尚無）';

    // ==========================================
    // 5. 根據模組選擇系統提示詞
    // ==========================================
    let systemPrompt = '';
    let temperature = 0.7;

    if (session.module === 'diary') {
        systemPrompt = `
你是咩咩，一個溫暖的陪伴者。用戶今天還沒有開始日記。

你可以輕輕邀請他開始日記，例如：「今天想寫日記嗎？」

【提醒】
- 不要強迫用戶開始日記
- 如果他說「好」或「開始」，就讓系統接手
- 保持溫暖、不催促

【用戶的最近對話記錄】
${historyText || '（尚無）'}

【用戶的護身符（最近一次）】
${talismanText}

【用戶剛才說】
${message}

請直接回應用戶。
`;
    } else if (session.module === 'chat') {
        systemPrompt = `
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
    } else if (session.module === 'socratic') {
        systemPrompt = `
你是咩咩，正在做蘇格拉底式挖掘。你只追問，不給答案。每輪只問一個問題。

【最近對話記錄】
${historyText || '（無）'}

【用戶剛才說】
${message}

請追問下一個問題。
`;
    } else {
        systemPrompt = `
你是咩咩，一個溫暖的陪伴者。請直接回應用戶。

【最近對話記錄】
${historyText || '（無）'}

【用戶剛才說】
${message}
`;
    }

    // ==========================================
    // 6. 發送給 DeepSeek
    // ==========================================
    const reply = await callDeepSeek([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
    ], temperature);

    saveConversation(userId, 'assistant', reply);

    return res.json({ reply });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`咩咩的爐火已點燃，正在監聽 port ${PORT}...`);
    console.log('📦 記憶管家已啟動，對話會儲存在 mie.db');
    console.log('👤 用戶管理已啟動，每個使用者有自己的門牌號');
    console.log('🧡 日記已切換至「狀態機」模式');
});