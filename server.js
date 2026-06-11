// PDCA Time Master 後端進入點。
// 技術棧：Node.js + Express + SQLite（依 SPEC v1.3）。
// 同時以靜態方式提供前端（public/），方便在 Zeabur 單一服務部署。
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./src/db'); // 載入即完成資料庫初始化（建表、索引、外鍵），並取得 db 實例供備份使用

const authRoutes = require('./src/routes/auth');
const logsRoutes = require('./src/routes/logs');
const userDataRoutes = require('./src/routes/user-data');
const resourceRoutes = require('./src/routes/resources');
const studyRoutes = require('./src/routes/study');   // v3 讀書會：讀書計時
const groupRoutes = require('./src/routes/groups');   // v3 讀書會：群組
const { fail } = require('./src/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

// 信任反向代理（Zeabur 等 PaaS 會在代理後方）：讓 express-rate-limit 取得真實用戶端 IP。
// 用具體層數（1）而非 true，避免 rate-limit 對「過度寬鬆的 trust proxy」發出警告。
app.set('trust proxy', 1);

// CORS：允許前端來源（正式環境可用 CORS_ORIGIN 限制網域）
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '2mb' }));

// 健康檢查
app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// 登入／註冊限流：對 /api/v1/auth 套用合理上限，防暴力撞庫與灌帳號。
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 時間窗：15 分鐘
  max: 30,                  // 每個 IP 於時間窗內最多 30 次（登入+註冊合計）
  standardHeaders: true,
  legacyHeaders: false,
  // 沿用統一回應信封與慣例狀態碼（429 Too Many Requests）
  handler: (req, res) => fail(res, 429, 'RATE_LIMITED', '登入/註冊嘗試過於頻繁，請稍後再試'),
});

// API 路由掛載
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/logs', logsRoutes);
app.use('/api/v1/users/:user_id', userDataRoutes); // 行事曆/日記/備忘錄/重要日期/統計
app.use('/api/v1/study', studyRoutes);   // 讀書會：讀書計時（sessions/me/summary）
app.use('/api/v1/groups', groupRoutes);  // 讀書會：群組（CRUD/join/leave/members）
app.use('/api/v1', resourceRoutes); // diaries/:id, memos/:id, important-dates/:id

// 前端靜態資源
app.use(express.static(path.join(__dirname, 'public')));

// 未匹配的 API 路徑 → 統一 404
app.use('/api', (req, res) => fail(res, 404, 'NOT_FOUND', '找不到此 API 端點'));

// 其餘路徑回傳前端首頁（單頁式應用）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 全域錯誤處理
app.use((err, req, res, next) => {
  console.error(err);
  return fail(res, 500, 'INTERNAL_ERROR', '伺服器內部錯誤');
});

// ===== 每日自動備份 =====
// 持久卷也會壞或被誤刪。以 SQLite 的 VACUUM INTO 匯出一份帶日期的完整副本，保留最近 7 份。
// 備份檔放在資料庫同層的 backups/ 內（亦在 .gitignore 的 data/ 之下，不進版控）。
function runBackup() {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'pdca.db');
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dest = path.join(backupDir, `pdca-${stamp}.db`);
    if (fs.existsSync(dest)) fs.unlinkSync(dest); // VACUUM INTO 要求目標檔不存在
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    // 只保留最近 7 份（依檔名日期排序，刪除最舊者）
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => /^pdca-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    while (files.length > 7) {
      const old = files.shift();
      fs.unlinkSync(path.join(backupDir, old));
    }
    console.log(`資料庫已備份至 ${dest}`);
  } catch (e) {
    console.error('資料庫備份失敗：', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`PDCA Time Master 後端已啟動： http://localhost:${PORT}`);
  // 啟動後 10 秒做一次備份（即使頻繁 redeploy 也至少有當日快照），其後每 24 小時一次。
  setTimeout(runBackup, 10 * 1000);
  setInterval(runBackup, 24 * 60 * 60 * 1000);
});
