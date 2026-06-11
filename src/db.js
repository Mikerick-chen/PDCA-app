// 資料庫模組（v2）：初始化 SQLite、建立核心表、外鍵與索引。
// v2 變更：移除 username（改以 email 登入）；Plan/Do 改為結構化的 Plan_Items；
//          完成度（progress）改由「已勾選項目 / 總項目」即時計算，不再存欄位。
// 依 SPEC — 初始資料庫狀態必須為空，不放入任何 seed 或 demo 資料。
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pdca.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  -- 使用者表（以 email 作為登入帳號）
  CREATE TABLE IF NOT EXISTS Users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,      -- Gmail，登入用
    display_name  TEXT NOT NULL,             -- 姓名，App 內顯示
    password_hash TEXT NOT NULL,             -- 密碼雜湊（嚴禁存明文）
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  -- 每日 PDCA 日誌表（Plan/Do 移至 Plan_Items；此表僅留 Check/Act 文字）
  CREATE TABLE IF NOT EXISTS PDCA_Daily_Logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    log_date      TEXT NOT NULL,             -- YYYY-MM-DD
    check_content TEXT,
    act_content   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (user_id, log_date),
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
  );

  -- 計畫項目表：Plan 逐項輸入、Do 以勾選確認完成
  CREATE TABLE IF NOT EXISTS Plan_Items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id       INTEGER NOT NULL,
    content      TEXT NOT NULL,              -- 計畫內容
    planned_time TEXT,                       -- 預定時間（如 09:00 或 09:00-10:00），可為空
    is_done      INTEGER NOT NULL DEFAULT 0, -- 0 未完成 / 1 已完成（Do 勾選）
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (log_id) REFERENCES PDCA_Daily_Logs(id) ON DELETE CASCADE
  );

  -- 備忘錄表
  CREATE TABLE IF NOT EXISTS Memos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT,
    content     TEXT,
    color       TEXT,
    is_pinned   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
  );

  -- 日記表（每日可多篇）
  CREATE TABLE IF NOT EXISTS Diaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    entry_date  TEXT NOT NULL,
    title       TEXT,
    content     TEXT,
    mood        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
  );

  -- 重要日期表（倒數天數）
  CREATE TABLE IF NOT EXISTS Important_Dates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    target_date TEXT NOT NULL,
    color       TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_logs_user_date    ON PDCA_Daily_Logs(user_id, log_date);
  CREATE INDEX IF NOT EXISTS idx_items_log         ON Plan_Items(log_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_memos_user        ON Memos(user_id, is_pinned, updated_at);
  CREATE INDEX IF NOT EXISTS idx_diaries_user_date ON Diaries(user_id, entry_date);
  CREATE INDEX IF NOT EXISTS idx_impdates_user_tgt ON Important_Dates(user_id, target_date);
`);

// === v3 讀書會（群組讀書計時）新增資料表 ===
// 全為新增，使用 CREATE TABLE IF NOT EXISTS，不影響既有資料；完全相容既有 pdca.db。
// 註：群組表命名為 Study_Groups（避開 SQLite 的 GROUPS 保留字疑慮）。
db.exec(`
  -- 讀書時段：碼錶式計時，一次運行 = 一列；時數一律由伺服器時間戳計算（防作弊）
  CREATE TABLE IF NOT EXISTS Study_Sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    subject          TEXT,                            -- 科目／標籤，可空
    study_date       TEXT NOT NULL,                   -- YYYY-MM-DD（使用者本地日期，供當日彙總、時區安全）
    started_at       TEXT NOT NULL,                   -- 伺服器 ISO 開始時間
    ended_at         TEXT,                            -- NULL = 進行中
    duration_seconds INTEGER NOT NULL DEFAULT 0,      -- 秒數（結束時 = ended_at - started_at 定稿）
    status           TEXT NOT NULL DEFAULT 'running', -- running / ended
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
  );

  -- 讀書會 / 群組
  CREATE TABLE IF NOT EXISTS Study_Groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    owner_id    INTEGER NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,                 -- 加入用邀請碼（不可猜）
    color       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES Users(id) ON DELETE CASCADE
  );

  -- 群組成員（Users ↔ Study_Groups 多對多）
  CREATE TABLE IF NOT EXISTS Group_Members (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    role      TEXT NOT NULL DEFAULT 'member',         -- owner / member
    joined_at TEXT NOT NULL,
    UNIQUE (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES Study_Groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES Users(id)        ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_study_user_date ON Study_Sessions(user_id, study_date);
  CREATE INDEX IF NOT EXISTS idx_study_active    ON Study_Sessions(user_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_gm_group        ON Group_Members(group_id);
  CREATE INDEX IF NOT EXISTS idx_gm_user         ON Group_Members(user_id);
`);

module.exports = db;
