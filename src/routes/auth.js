// 認證路由（v2）：以 Gmail（email）作為登入帳號。
// 註冊只需 email、姓名、密碼；登入用 email + 密碼。
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../auth-middleware');
const { ok, fail, nowIso, isValidEmail } = require('../helpers');

const router = express.Router();

// 對外安全使用者物件（不含密碼）
function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

// 註冊
router.post('/register', (req, res) => {
  const { email, display_name, password } = req.body || {};
  if (!email || !display_name || !password) {
    return fail(res, 400, 'VALIDATION_ERROR', 'email、display_name、password 皆為必填');
  }
  // 先正規化 email：去頭尾空白並轉小寫，再做格式驗證與查詢/寫入。
  // 避免 User@Gmail.com 與 user@gmail.com 被視為兩個帳號，或因大小寫不一致而登入失敗。
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'email 格式不正確');
  }
  if (String(password).length < 8) {
    return fail(res, 400, 'VALIDATION_ERROR', '密碼長度至少 8 碼');
  }

  const exists = db.prepare('SELECT id FROM Users WHERE email = ?').get(normalizedEmail);
  if (exists) {
    return fail(res, 409, 'CONFLICT', '此 Gmail 已被註冊');
  }

  const now = nowIso();
  const passwordHash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare(
      `INSERT INTO Users (email, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(normalizedEmail, display_name, passwordHash, now, now);

  const row = db.prepare('SELECT * FROM Users WHERE id = ?').get(info.lastInsertRowid);
  return ok(res, toPublicUser(row), 201);
});

// 登入（email + 密碼）
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return fail(res, 400, 'VALIDATION_ERROR', 'email 與 password 為必填');
  }
  // 與註冊一致地正規化 email，確保大小寫/空白不影響登入。
  const normalizedEmail = String(email).trim().toLowerCase();
  const row = db.prepare('SELECT * FROM Users WHERE email = ?').get(normalizedEmail);
  if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
    return fail(res, 401, 'UNAUTHORIZED', 'Gmail 或密碼錯誤');
  }
  const user = toPublicUser(row);
  const token = signToken({ id: user.id, email: user.email });
  return ok(res, { token, user });
});

module.exports = router;
