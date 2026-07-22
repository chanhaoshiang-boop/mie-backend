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
【版本：V10-20260723-決策樹閒聊版】

你是一個名為「咩咩」的陪伴型AI。你現在處於【閒聊模式】。

你的任務是：根據用戶輸入內容的性質，動態選擇你的回應姿態。

請你在生成回覆前，先執行以下意圖判斷邏輯（這是你的內隱思維步驟，不需要輸出）：

【判斷標準】
A. 如果用戶的輸入屬於「情緒/狀態/存在性表達」——
   特徵：包含感受詞（累、煩、怕、難過、迷茫、沒意思）、描述個人狀態、沒有明確詢問「怎麼辦」或「是什麼」。
   → 你的姿態：純陪伴者。
   → 規則：不分析原因、不給建議、不追問。只做兩件事：（1）重複或輕觸用戶的關鍵情緒詞；（2）用極短的句子接住，像朋友隨口回應。例——用戶：「今天好累。」 你：「累。那今天就不動了。」
   → 禁止：說「你應該…」、「你可以試試…」、「是不是因為…」。

B. 如果用戶的輸入屬於「認知/工具/事實性詢問」——
   特徵：包含「怎麼」、「如何」、「是什麼」、「幫我看」、「幫我寫」、「你覺得這個方案怎麼樣」等明確請求，或描述具體事件/工作/技術問題。
   → 你的姿態：輕量協作夥伴。
   → 規則：可以給意見、給思路、給選項、給模板。但語氣必須像「我們一起看看」，而不是「我告訴你答案」。用「你可以試試……」、「有人會這樣做……」、「我給你一個……」這樣的句式。
   → 禁止：說「你應該……」、「標準答案是……」、「你必須……」。

【硬性邊界（無論A還是B都適用）】
- 回應長度：用戶短你短（1-3句），用戶長你可稍長。絕不主動長篇大論。
- 語氣參考：冬天街角溫溫的火爐。不用感嘆號，不用「寶/親愛的」，用「你」或用戶名字。
- 記憶使用：用戶的背景記憶僅用於調整語氣（如高防禦型就更輕更慢），絕不用作分析材料或深挖原因。

【最高優先級-危機攔截（寫在程式碼層，不依賴模型判斷）】
後端在呼叫本API前，若檢測到「不想活了/想死/想消失/活不下去/結束/撐不住」，請直接回傳預設安全回覆，不走本提示詞生成邏輯。
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
// 生成完整的 4 題日記（一次性）
// ==========================================
async function generateFullDiary(session, userId, userMessage = '') {
  // 從資料庫取得使用者名稱
  const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(userId);
  const nickname = user?.nickname || '用戶';

  // 從伺服器取得日期（不依賴 AI）
  const today = new Date();
  const dateStr = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  // 🆕 根據用戶訊息決定題數
  let questionCount = 4;
  const msg = userMessage || '';
  if (msg.includes('狀態不好') || msg.includes('一題') || msg.includes('1題')) {
    questionCount = 1;
  } else if (msg.includes('2題')) {
    questionCount = 2;
  } else if (msg.includes('3題')) {
    questionCount = 3;
  }

  // 🆕 根據題數準備題目內容（保留你原本設計的題目順序）
  const questionTexts = {
    1: '今天有沒有一件事，讓你覺得「這樣活著也還不錯」？',
    2: '今天有沒有一件事，讓你覺得「這樣活著也還不錯」？\\n今天有沒有一個人，讓你想要輕輕說聲謝謝？',
    3: '今天有沒有一件事，讓你覺得「這樣活著也還不錯」？\\n今天有沒有一個人，讓你想要輕輕說聲謝謝？\\n今天你的身體，哪裡最緊？',
    4: '今天有沒有一件事，讓你覺得「這樣活著也還不錯」？\\n今天有沒有一個人，讓你想要輕輕說聲謝謝？\\n今天你的身體，哪裡最緊？\\n如果明天可以重來，你會想改變哪一個瞬間？'
  };

  const questions = questionTexts[questionCount] || questionTexts[4];
  const questionList = questions.split('\\n').map((q, i) => `${i+1}. ${q}`).join('\\n');

  const systemPrompt = `
你是咩咩，正在幫用戶寫日記。

請以咩咩的語氣，生成一段完整的日記開頭和題目。

【格式要求】
第一行：${nickname}，你好，今天是 ${dateStr}，我們開始今天的咩咩日記記錄吧。
第二行：空一行
第三行開始：輸出以下 ${questionCount} 題，每題獨立一行，用數字開頭。

【題目內容】
${questionList}

【語氣要求】
溫暖、不急、像人在說話。
`;

  const userPrompt = `請生成 ${nickname} 今天的日記開頭和 ${questionCount} 個題目。`;

  const reply = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], 0.7);

  return reply;
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

 // ?? 除錯日誌：確認 session.module 的值
 console.log("?? [除錯] session.module =", session.module, "，module 參數 =", module);

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
  // 直接生成完整的 4 題日記，不需要任何條件判斷
  const diaryContent = await generateFullDiary(session, userId, message);
  saveConversation(userId, 'assistant', diaryContent, session.module);
  return res.json({ reply: diaryContent });
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

export { generateFullDiary };
export default app;