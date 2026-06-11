// 讀書計時路由（v3 讀書會）：碼錶式讀書時段（明確「開始/結束」，無心跳）。
// 設計重點：讀書時數一律由「伺服器時間戳」計算（started_at / ended_at），不信任前端宣稱的秒數。
// 取捨：無心跳 → 若使用者關分頁未按「結束」，該段仍視為進行中，直到他按結束、
//       或被「單段最長上限」（MAX_SESSION）惰性自動結算（避免一段跑到天荒地老）。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth-middleware');
const { ok, fail, nowIso, isValidDate } = require('../helpers');

const router = express.Router();
router.use(authRequired);

const MAX_SESSION_MS = 6 * 60 * 60 * 1000; // 單段最長 6 小時，逾時自動結算（封頂計入）

function secondsBetween(a, b) {
  const d = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return d > 0 ? d : 0;
}
function toSession(r) {
  if (!r) return null;
  return {
    id: r.id, user_id: r.user_id, subject: r.subject, study_date: r.study_date,
    started_at: r.started_at, ended_at: r.ended_at,
    duration_seconds: r.duration_seconds, status: r.status,
  };
}
function activeSession(userId) {
  return db
    .prepare('SELECT * FROM Study_Sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC')
    .get(userId);
}
function finalize(row, endIso) {
  const dur = secondsBetween(row.started_at, endIso);
  db.prepare('UPDATE Study_Sessions SET ended_at = ?, duration_seconds = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(endIso, dur, 'ended', nowIso(), row.id);
}
// 惰性結算：把此使用者「開始已超過 MAX_SESSION」的進行中段自動結束（封頂於上限）。
// 處理「關分頁沒按結束」的遺留段，避免無限累計或永遠顯示讀書中。
function finalizeStale(userId) {
  const now = Date.now();
  const running = db.prepare('SELECT * FROM Study_Sessions WHERE user_id = ? AND ended_at IS NULL').all(userId);
  for (const r of running) {
    const startedMs = new Date(r.started_at).getTime();
    if (now - startedMs > MAX_SESSION_MS) {
      finalize(r, new Date(startedMs + MAX_SESSION_MS).toISOString());
    }
  }
}

// 開始一段讀書；若已有進行中段：回傳同一段（可更新科目），不重複建立 active。
router.post('/sessions/start', (req, res) => {
  const userId = req.user.id;
  const { subject, date } = req.body || {};
  if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 為必填且需為 YYYY-MM-DD 格式');
  finalizeStale(userId);
  const now = nowIso();

  const existing = activeSession(userId);
  if (existing) {
    if (subject !== undefined) {
      db.prepare('UPDATE Study_Sessions SET subject = ?, updated_at = ? WHERE id = ?')
        .run(subject || null, now, existing.id);
    }
    return ok(res, toSession(db.prepare('SELECT * FROM Study_Sessions WHERE id = ?').get(existing.id)));
  }

  const info = db
    .prepare(
      `INSERT INTO Study_Sessions (user_id, subject, study_date, started_at, ended_at, duration_seconds, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, 'running', ?, ?)`
    )
    .run(userId, subject || null, date, now, now, now);
  return ok(res, toSession(db.prepare('SELECT * FROM Study_Sessions WHERE id = ?').get(info.lastInsertRowid)), 201);
});

// 結束一段讀書（定稿 ended_at 與 duration）
router.post('/sessions/:id/stop', (req, res) => {
  const row = db.prepare('SELECT * FROM Study_Sessions WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.user.id) return fail(res, 404, 'NOT_FOUND', '找不到讀書時段');
  if (!row.ended_at) finalize(row, nowIso());
  return ok(res, toSession(db.prepare('SELECT * FROM Study_Sessions WHERE id = ?').get(row.id)));
});

// 我的某日讀書：已結束總時數（finished_seconds）、各段、目前進行中段（active）。
// 進行中段的即時秒數由前端依 active.started_at 自行累加（碼錶），不需心跳。
router.get('/me', (req, res) => {
  const userId = req.user.id;
  const date = req.query.date;
  if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 需為 YYYY-MM-DD 格式');
  finalizeStale(userId);
  const rows = db
    .prepare('SELECT * FROM Study_Sessions WHERE user_id = ? AND study_date = ? ORDER BY started_at ASC')
    .all(userId, date);
  const finished = rows.filter((r) => r.ended_at).reduce((s, r) => s + r.duration_seconds, 0);
  return ok(res, { date, finished_seconds: finished, sessions: rows.map(toSession), active: toSession(activeSession(userId)) });
});

// 我的每日讀書總時數（個人圖表用；僅統計已結束的段）
router.get('/summary', (req, res) => {
  const userId = req.user.id;
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'from 與 to 需為 YYYY-MM-DD 格式');
  }
  finalizeStale(userId);
  const rows = db
    .prepare(
      `SELECT study_date AS date, COALESCE(SUM(duration_seconds), 0) AS seconds
       FROM Study_Sessions WHERE user_id = ? AND study_date >= ? AND study_date <= ? AND ended_at IS NOT NULL
       GROUP BY study_date ORDER BY study_date ASC`
    )
    .all(userId, from, to);
  return ok(res, { from, to, daily: rows.map((r) => ({ date: r.date, seconds: r.seconds })) });
});

module.exports = router;
