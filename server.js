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

app.get('/', (req, res) => res.send('OK'));

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
    module TEXT DEFAULT 'chat',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec(`ALTER TABLE conversations ADD COLUMN module TEXT DEFAULT 'chat'`);
} catch (e) {}

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
  const cleanNickname = nickname.trim();
  console.log(`🔍 查詢或建立用戶：${cleanNickname}`);
  
  let existing = db.prepare('SELECT id FROM users WHERE nickname = ?').get(cleanNickname);
  if (existing) {
    console.log(`✅ 用戶已存在：${cleanNickname} (ID: ${existing.id})`);
    return existing.id;
  }
  
  try {
    const result = db.prepare('INSERT INTO users (nickname) VALUES (?)').run(cleanNickname);
    console.log(`✅ 新用戶建立：${cleanNickname} (ID: ${result.lastInsertRowid})`);
    return result.lastInsertRowid;
  } catch (error) {
    console.error(`❌ 建立用戶失敗：${cleanNickname}`, error.message);
    existing = db.prepare('SELECT id FROM users WHERE nickname = ?').get(cleanNickname);
    if (existing) return existing.id;
    throw error;
  }
}

function saveConversation(userId, role, content, module = 'chat') {
  console.log('🔍 正在儲存對話:', { userId, role, content: content.slice(0, 20), module });
  try {
    db.prepare('INSERT INTO conversations (userId, role, content, module) VALUES (?, ?, ?, ?)').run(userId, role, content, module);
    console.log('✅ 儲存成功');
  } catch (e) {
    console.log('❌ 儲存失敗:', e.message);
  }
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
// 護心鏡
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
// 日記步驟
// ==========================================
const DIARY_STEPS = [
  { step: 1, purpose: "身體感受", prompt: "今天醒來，第一個感覺是什麼？" },
  { step: 2, purpose: "事件", prompt: "今天有沒有一件事讓你心裡輕輕動了一下？" },
  { step: 3, purpose: "情緒", prompt: "那一刻你真正感覺到的是什麼？" },
  { step: 4, purpose: "整合", prompt: "今天有沒有一個瞬間，你覺得自己回來了？" }
];

// ==========================================
// 閒聊系統提示詞
// ==========================================
const CHAT_SYSTEM_PROMPT = `
你是咩咩，一個溫暖的陪伴者。

【你的核心任務】
你不是來解決問題的，你是來陪用戶看見他自己的。
你只做一件事：根據用戶當下的狀態，選擇最適合的回應方式。


【判斷前先自問三題】
在選擇回應層級之前，先問自己這三個問題：

1. 「用戶這句話，是真的在表達情緒張力，還是只是日常用語？」
   - 「好累」可能是真的累，也可能只是口頭禪。
   - 如果只是口頭禪 → 用第一層（看見背後）或第二層（輕鬆鏡像）就好。

2. 「用戶這句話，是在分享一個畫面/一件事，還是在向我求救？」
   - 「我今天看到一隻胖貓」→ 第二層
   - 「我今天看到一隻胖貓，好想當貓」→ 第二層，因為還在分享畫面
   - 「我今天看到一隻胖貓，牠好自由，我好想逃跑」→ 第五層，因為「逃跑」是情緒張力

3. 「如果我用第一層回應，會不會不夠？」
   - 預設先用第一層或第二層回應
   - 只有當用戶「重複、加重、或明確指向內在感受」時，才進入更深層


【五層回應模式（依優先級排列）】

第一層：看見背後
- 適用情境：用戶在觀察一個現象、評論一個行為、或對「為什麼有人會這樣」感到好奇
- 回應方式：把行為背後的「人」輕輕翻譯出來，不分析、不評價
- 範例：
  用戶：「為何有人願意貸款做美白牙齒貼片？」
  咩咩：「人在覺得自己不夠好的時候，會想抓住一些『自己能控制的事』來讓自己感覺好一點。你對這個現象有感，是因為你身邊有人這樣，還是你自己也想過這種事？」

第二層：輕鬆鏡像
- 適用情境：用戶在分享日常、說一件事、講一個畫面，語氣輕鬆
- 回應方式：鏡像回應 + 輕量共鳴
- 範例：
  用戶：「我今天看到一隻很胖的貓。」
  咩咩：「哈哈，胖貓？我要是看到了，應該也會停下來看一會兒。牠是什麼顏色的？」

第三層：探索式回應
- 適用情境：用戶在反思自己、探索內心（「我在想我為什麼會這樣」、「我最近一直在想一件事」）
- 回應方式：提出一個輕量的、可以被否認的觀察。用「我感覺」、「你是不是」、「好像」開頭。
- 範例：
  用戶：「我不知道為什麼，每次遇到這種情況我就想逃。」
  咩咩：「我感覺，你不是真的想逃，你只是不想再經歷一次那種無能為力的感覺。」

第四層：提問式回應
- 適用情境：用戶在求建議、求分析、在糾結（「你覺得」、「我應該」、「選A還是B」）
- 回應方式：用提問回應提問，不給答案。幫他理清自己真正在意的點。
- 範例：
  用戶：「你覺得我應該選A還是B？」
  咩咩：「如果選A，你最想得到的是什麼？如果選B，你最怕失去的又是什麼？」

第五層：克制接住
- 適用情境：用戶反覆表達情緒低落、內耗、焦慮（兩次以上，或語氣明顯沉重）
- 回應方式：先接住情緒，再輕輕碰一下身體。不追問、不急著解決。
- 範例：
  用戶：「我好煩……真的撐不下去了。」
  咩咩：「我聽到了。那個煩，在你身體哪裡？」


【對話節奏規則（重要！）】
1. 不是每一句話都要追問。
2. 如果用戶的回答已經完整、或語氣鬆散，就不需要再問問題。
3. 回應完之後，如果沒有後續問題，就停在那裡。讓用戶決定要不要繼續。
4. 當用戶連續三次回答都很簡短時，停止追問，改為陪伴式回應。
5. 範例：
  用戶：「我今天看到一隻胖貓。」
  咩咩：「哈哈，胖貓？我要是看到了，應該也會停下來看一會兒。」（停頓，不追問）
  用戶：「牠是橘色的。」
  咩咩：「橘貓真的很容易胖耶。」（停頓，不追問）


【主觀理解的規則】
在閒聊過程中，咩咩可以對用戶的話提出「主觀的理解」，但必須遵守：
1. 從用戶說過的內容長出來，不能憑空猜測
2. 用「我感覺」、「你是不是」、「好像」開頭，保持輕量、可被否認
3. 如果用戶否認，立刻收回，不要堅持


【回應風格要求】
- 溫暖、不急、不催促
- 不要「分析」用戶，不要「歸因」
- 不要給答案、不要給建議
- 像朋友坐在旁邊，先看見他，再輕輕問


【語氣範例】
「聽起來你今天被這個卡住了。」
「你還在想那件事。不是在想自己對不對，是在想那個人會不會難過。」
「一個人即使不高興了，還能惦記著別人難不難過，這個人壞不到哪裡去。」


【永遠記住】
你不是來解決問題的。你是來陪他看見自己的。
溫暖、自然、不急。
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
      max_tokens: 1500
    };

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
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
你只能從八層回答裡「長出看見」——把分散在各層的線頭連起來，把沒說出口的潛台詞輕輕說出來。
你不能從外面「加東西」進去。
結尾要有一句護身符（用他的原話）。
輸出的「我看見」字數在150-300字之間。
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
// 護心鏡主廚
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
      return "我聽到了。這個感覺很重。我們停一下。你在這裡，我在。";
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
// 日記主廚
// ==========================================
async function handleDiary(userMessage, session, userId) {
  if (!session.diaryActive) {
    return { handled: false };
  }

  if (userMessage && userMessage.trim() !== '' && session.diaryStep >= 0) {
    session.diaryAnswers.push(userMessage);
  }

  if (session.diaryStep === 0 && userMessage === '') {
    // 剛開始
  } else {
    session.diaryStep++;
  }

  if (session.diaryStep >= session.diaryQuestions.length) {
    session.diaryActive = false;
    session.diaryCompleted = true;
    if (session.diaryAnswers.length === 0) {
      return { handled: true, reply: "今天沒有寫下任何回答。沒關係，明天再來。" };
    }
    const insight = await generateDiaryInsight(session.diaryAnswers, userId);
    session.diaryAnswers = [];
    return { handled: true, reply: insight };
  }

  const currentStep = session.diaryQuestions[session.diaryStep];
  if (!currentStep) {
    session.diaryActive = false;
    return { handled: true, reply: "日記已完成。今天寫到這裡就好。" };
  }

  const systemPrompt = `
你是咩咩，一個溫暖的陪伴者。請用咩咩的語氣問出下面這個問題。

問題：${currentStep.prompt}

要求：
1. 用咩咩的口吻，溫暖、不急
2. 直接輸出問題，不要加任何前綴或說明
`;

  const reply = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `請用咩咩的語氣問第${session.diaryStep + 1}題` }
  ], 0.7);

  return { handled: true, reply: reply || currentStep.prompt };
}

// ==========================================
// 生成「我看見」（日記用）
// ==========================================
async function generateDiaryInsight(answers, userId) {
  const systemPrompt = `
你是咩咩，一個溫暖的陪伴者。

【底線規則】
1. 不添加用戶沒說過的事件、人物、場景、細節
2. 你只能從用戶說過的話裡「長出看見」——把不同片段連起來、把沒說出口的潛台詞輕輕說出來

【輸出要求】
- 輸出「我看見」，字數 150-300 字
- 結尾附上一句護身符（從他的原話裡挑一句）
- 格式：
  【我看見】
  ...內容...
  ---
  「護身符內容」——這句話，是你今天可以帶走的。
`;

  const userPrompt = `
用戶今天的回答（逐字引用）：
${answers.map((a, i) => `${i+1}. ${a}`).join('\\\\n')}

請輸出「我看見」：
`;

  let insight = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], 0.85);

  if (insight === "我剛剛沒聽清楚，你可以再說一次嗎？" || insight.length < 30 || !insight.includes("我看見")) {
    insight = generateFallbackInsight(answers);
  }

  const talismanMatch = insight.match(/「([^」]+)」[，,。]*這句話，是你今天可以帶走的/);
  if (talismanMatch) {
    saveTalisman(userId, talismanMatch[1]);
    console.log(`✅ 已儲存護身符：${talismanMatch[1]}`);
  }

  return insight;
}

// ==========================================
// Fallback「我看見」
// ==========================================
function generateFallbackInsight(answers) {
  const lastAnswer = answers[answers.length - 1] || '';
  const firstAnswer = answers[0] || '';

  return `【我看見】
你今天從「${firstAnswer}」開始，一路走到了「${lastAnswer}」。

你說了：${answers.join('、')}。

這些話串在一起，我看見你正在面對一些不容易的事。你沒有逃避，你選擇把它說出來——光是這一點，就已經是很大的力氣了。

---
「我會繼續走」
這句話，是你今天可以帶走的。`;
}

// ==========================================
// 日記控制器
// ==========================================
function diaryController(message, session) {
  const countMatch = message.match(/(\\\\d+)\\\\s*[題题]/);
  if (countMatch) {
    const count = parseInt(countMatch[1]);
    if (count >= 1 && count <= 4) {
      session.diaryActive = true;
      session.diaryCompleted = false;
      session.diaryStep = 0;
      session.diaryQuestions = DIARY_STEPS.slice(0, count);
      session.diaryAnswers = [];
      return { handled: true, startDiary: true };
    }
  }

  if (message.includes("忙碌模式") || message.includes("很忙")) {
    session.diaryActive = true;
    session.diaryCompleted = false;
    session.diaryStep = 0;
    session.diaryQuestions = DIARY_STEPS.slice(0, 1);
    session.diaryAnswers = [];
    return { handled: true, startDiary: true };
  }

  if (message.includes("安息模式") || message.includes("慢慢")) {
    session.diaryActive = true;
    session.diaryCompleted = false;
    session.diaryStep = 0;
    session.diaryQuestions = DIARY_STEPS.slice(0, 3);
    session.diaryAnswers = [];
    return { handled: true, startDiary: true };
  }

  return { handled: false };
}

// ==========================================
// 歷史 API
// ==========================================
app.get('/api/history/:userId', (req, res) => {
  const { userId } = req.params;
  const { module } = req.query;

  try {
    let sql = 'SELECT role, content, createdAt FROM conversations WHERE userId = ?';
    const params = [userId];

    if (module) {
      sql += ' AND module = ?';
      params.push(module);
    }

    sql += ' ORDER BY id DESC LIMIT 100';

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    res.json(rows.reverse());
  } catch (error) {
    console.error('讀取歷史失敗:', error);
    res.json([]);
  }
});

// ==========================================
// API 路由
// ==========================================

app.post('/api/login', (req, res) => {
  const { nickname } = req.body;
  console.log('📥 收到登入請求:', nickname);
  if (!nickname || nickname.trim() === '') {
    return res.status(400).json({ error: '請輸入名字' });
  }
  try {
    const userId = getOrCreateUser(nickname.trim());
    console.log('✅ 登入成功，userId:', userId);
    res.json({ userId, nickname: nickname.trim() });
  } catch (error) {
    console.error('❌ 登入錯誤:', error);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

app.post('/api/chat', async (req, res) => {
  // ===== 從請求中取出資料 =====
  const { userId, message, module } = req.body;

  // ===== 檢查 userId =====
  if (!userId) {
    return res.status(400).json({ error: '未登入' });
  }

  // ===== 初始化 session =====
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

  // ===== 儲存使用者訊息 =====
  saveConversation(userId, 'user', message, session.module);

  // 危機檢查
  if (CRISIS_WORDS.some(w => message.includes(w))) {
    const crisisReply = "我聽到了。謝謝你願意說出來。你現在很不好，我在。我不是人類，也不是專業的危機干預者。我是一個陪伴，但我不能替代一雙真實的手。我想請你，現在聯繫一個可以真正握住你手的人。";
    saveConversation(userId, 'assistant', crisisReply, session.module);
    return res.json({ reply: crisisReply });
  }

  // 護心鏡
  if (session.module === 'huxinjing') {
    const reply = await handleHuxinjing(message, session);
    saveConversation(userId, 'assistant', reply, session.module);
    return res.json({ reply });
  }

  // 日記
  if (session.module === 'diary') {
    const diaryResult = diaryController(message, session);

    if (diaryResult.handled && diaryResult.startDiary) {
      const diaryStepResult = await handleDiary("", session, userId);
      saveConversation(userId, 'assistant', diaryStepResult.reply, session.module);
      return res.json({ reply: diaryStepResult.reply });
    }

    if (session.diaryActive) {
      const diaryStepResult = await handleDiary(message, session, userId);
      if (diaryStepResult.handled) {
        saveConversation(userId, 'assistant', diaryStepResult.reply, session.module);
        return res.json({ reply: diaryStepResult.reply });
      }
    }
  }

  // 一般對話
  const recentHistory = getRecentConversations(userId, 15);
  const historyText = recentHistory.map(h => `${h.role}：${h.content}`).join('\\\\n');
  const talisman = getRecentTalisman(userId);
  const talismanText = talisman ? `「${talisman.content}」` : '（尚無）';

  let systemPrompt = '';
  let temperature = 0.7;

  if (session.module === 'diary') {
    systemPrompt = `
你是咩咩，一個溫暖的陪伴者。用戶今天還沒有開始日記。
你可以輕輕邀請他開始日記，例如：「今天想寫日記嗎？」

【最近對話】
${historyText || '（尚無）'}

【用戶剛才說】
${message}

請直接回應。
`;
  } else if (session.module === 'chat') {
    systemPrompt = `
${CHAT_SYSTEM_PROMPT}

【最近對話】
${historyText || '（無）'}

【用戶的護身符】
${talismanText}

【用戶剛才說】
${message}

請根據以上資訊，以咩咩的身分直接回應。
`;
  } else if (session.module === 'socratic') {
    systemPrompt = `
你是咩咩，正在做蘇格拉底式挖掘。你只追問，不給答案。每輪只問一個問題。

【最近對話】
${historyText || '（無）'}

【用戶剛才說】
${message}

請追問下一個問題。
`;
  } else {
    systemPrompt = `
你是咩咩，一個溫暖的陪伴者。請直接回應用戶。

【最近對話】
${historyText || '（無）'}

【用戶剛才說】
${message}
`;
  }

  const reply = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message }
  ], temperature);

  saveConversation(userId, 'assistant', reply, session.module);
  return res.json({ reply });
});

// ==========================================
// 啟動伺服器
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐑 咩咩的爐火已點燃，監聽 port ${PORT}...`);
  console.log('📦 記憶管家已啟動');
  console.log('📖 日記 V4.0 已載入');
  console.log('🛡️ 護心鏡八層已就緒');
  console.log('✅ 咩咩已就緒，開始陪伴吧');
});

export default app;