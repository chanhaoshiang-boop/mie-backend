import Database from 'better-sqlite3';
const db = new Database('mie.db');

// 清空 conversations 表
db.prepare('DELETE FROM conversations').run();
console.log('✅ 已清空 conversations 表');

// 確認
const count = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
console.log(`📊 剩餘記錄數：${count.count}`);