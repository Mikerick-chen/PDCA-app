// 使用者範圍資料路由（v2）：行事曆、統計、日記、備忘錄、重要日期。
// v2 變更：行事曆與統計的完成度改由 Plan_Items（已勾選/總數）即時計算。
const express = require('express');
const db = require('../db');
const { authRequired, sameUser } = require('../auth-middleware');
const { ok, fail, nowIso, isValidDate, isValidMonth } = require('../helpers');

const router = express.Router({ mergeParams: true });
router.use(authRequired, sameUser);

// 取某使用者在指定日期區間內，每個日誌的完成度（done/total）。
// 回傳 { 'YYYY-MM-DD': progress } 與 has_log 集合。
function progressByDate(userId, like) {
  const rows = db
    .prepare(
      `SELECT l.log_date AS date,
              COUNT(pi.id) AS total,
              COALESCE(SUM(pi.is_done), 0) AS done
       FROM PDCA_Daily_Logs l
       LEFT JOIN Plan_Items pi ON pi.log_id = l.id
       WHERE l.user_id = ? AND l.log_date LIKE ?
       GROUP BY l.id`
    )
    .all(userId, like);
  const map = {};
  for (const r of rows) {
    map[r.date] = r.total > 0 ? Math.round((r.done * 100) / r.total) : 0;
  }
  return map;
}

/* ============ 行事曆月綜覽 ============ */
router.get('/calendar', (req, res) => {
  const userId = Number(req.params.user_id);
  const month = req.query.month;
  if (!isValidMonth(month)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'month 為必填且需為 YYYY-MM 格式');
  }

  const progMap = progressByDate(userId, `${month}-%`);

  const diaryDates = db
    .prepare('SELECT DISTINCT entry_date FROM Diaries WHERE user_id = ? AND entry_date LIKE ?')
    .all(userId, `${month}-%`);
  const diarySet = new Set(diaryDates.map((d) => d.entry_date));

  const impDates = db
    .prepare('SELECT id, title, target_date, color FROM Important_Dates WHERE user_id = ? AND target_date LIKE ?')
    .all(userId, `${month}-%`);
  const impMap = {};
  for (const im of impDates) {
    (impMap[im.target_date] = impMap[im.target_date] || []).push({ id: im.id, title: im.title, color: im.color });
  }

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    days.push({
      date,
      has_log: date in progMap,
      progress: date in progMap ? progMap[date] : 0,
      has_diary: diarySet.has(date),
      important_dates: impMap[date] || [],
    });
  }
  return ok(res, { month, days });
});

/* ============ 完成度統計 ============ */
router.get('/stats', (req, res) => {
  const userId = Number(req.params.user_id);
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'from 與 to 為必填且需為 YYYY-MM-DD 格式');
  }

  const rows = db
    .prepare(
      `SELECT l.log_date AS date,
              COUNT(pi.id) AS total,
              COALESCE(SUM(pi.is_done), 0) AS done
       FROM PDCA_Daily_Logs l
       LEFT JOIN Plan_Items pi ON pi.log_id = l.id
       WHERE l.user_id = ? AND l.log_date >= ? AND l.log_date <= ?
       GROUP BY l.id
       ORDER BY l.log_date ASC`
    )
    .all(userId, from, to);

  const daily = rows.map((r) => ({
    date: r.date,
    progress: r.total > 0 ? Math.round((r.done * 100) / r.total) : 0,
  }));
  const avg = daily.length === 0 ? 0 : Math.round(daily.reduce((s, r) => s + r.progress, 0) / daily.length);

  // 連續達成天數：由 to 往前回推，progress > 0 視為達成
  const doneSet = new Set(daily.filter((r) => r.progress > 0).map((r) => r.date));
  let streak = 0;
  const cursor = new Date(to + 'T00:00:00Z');
  while (doneSet.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return ok(res, { from, to, daily, streak, avg_progress: avg });
});

/* ============ 本週 Act 回顧（週末彙整用）============ */
// 取「date 所在週」的週一~週五各日 Act，供週末（六/日）在 PDCA 下方彙整本週行動。
// 說明：以日期字串本身的星期計算（UTC parse），時區安全——同一個日期字串在任何時區
//       都會算出同一個「週一」，不會因 server/client 時區差異而錯位。
// 權限：本路由群已於檔首 router.use(authRequired, sameUser)，故無需額外處理。
router.get('/week-acts', (req, res) => {
  const userId = Number(req.params.user_id);
  const date = req.query.date;
  if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 需為 YYYY-MM-DD 格式');

  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay();                       // 0=日, 1=一, ..., 6=六
  const offsetToMon = dow === 0 ? -6 : 1 - dow;    // 回推到當週週一
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + offsetToMon);

  const days = [];
  for (let i = 0; i < 5; i++) {                     // 週一~週五
    const x = new Date(mon);
    x.setUTCDate(mon.getUTCDate() + i);
    days.push(x.toISOString().slice(0, 10));
  }

  const ph = days.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT log_date, act_content FROM PDCA_Daily_Logs WHERE user_id = ? AND log_date IN (${ph})`)
    .all(userId, ...days);

  const map = {};
  rows.forEach((r) => { map[r.log_date] = r.act_content; });
  const labels = ['一', '二', '三', '四', '五'];
  const result = days.map((dt, i) => ({ date: dt, weekday: labels[i], act_content: map[dt] || null }));
  return ok(res, { week_start: days[0], days: result });
});

/* ============ 日記 CRUD（每日可多篇）============ */
function toDiary(r) {
  return {
    id: r.id, user_id: r.user_id, entry_date: r.entry_date, title: r.title,
    content: r.content, mood: r.mood, created_at: r.created_at, updated_at: r.updated_at,
  };
}
router.get('/diaries', (req, res) => {
  const userId = Number(req.params.user_id);
  const date = req.query.date;
  let rows;
  if (date) {
    if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 需為 YYYY-MM-DD 格式');
    rows = db.prepare('SELECT * FROM Diaries WHERE user_id = ? AND entry_date = ? ORDER BY created_at ASC').all(userId, date);
  } else {
    rows = db.prepare('SELECT * FROM Diaries WHERE user_id = ? ORDER BY entry_date DESC, created_at DESC').all(userId);
  }
  return ok(res, rows.map(toDiary));
});
router.post('/diaries', (req, res) => {
  const userId = Number(req.params.user_id);
  const { entry_date, title, content, mood } = req.body || {};
  if (!isValidDate(entry_date)) return fail(res, 400, 'VALIDATION_ERROR', 'entry_date 為必填且需為 YYYY-MM-DD 格式');
  const now = nowIso();
  const info = db
    .prepare('INSERT INTO Diaries (user_id, entry_date, title, content, mood, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, entry_date, title || null, content || null, mood || null, now, now);
  return ok(res, toDiary(db.prepare('SELECT * FROM Diaries WHERE id = ?').get(info.lastInsertRowid)), 201);
});

/* ============ 備忘錄 CRUD ============ */
function toMemo(r) {
  return {
    id: r.id, user_id: r.user_id, title: r.title, content: r.content, color: r.color,
    is_pinned: r.is_pinned === 1, created_at: r.created_at, updated_at: r.updated_at,
  };
}
router.get('/memos', (req, res) => {
  const userId = Number(req.params.user_id);
  // 分頁（offset 型）：避免備忘錄年復一年累積時一次撈回全部。
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  // 多取一筆判斷是否還有更多
  const rows = db
    .prepare('SELECT * FROM Memos WHERE user_id = ? ORDER BY is_pinned DESC, updated_at DESC LIMIT ? OFFSET ?')
    .all(userId, limit + 1, offset);
  const has_more = rows.length > limit;
  const items = (has_more ? rows.slice(0, limit) : rows).map(toMemo);
  return ok(res, { items, has_more, offset, limit });
});
router.post('/memos', (req, res) => {
  const userId = Number(req.params.user_id);
  const { title, content, color, is_pinned } = req.body || {};
  const now = nowIso();
  const info = db
    .prepare('INSERT INTO Memos (user_id, title, content, color, is_pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, title || null, content || null, color || null, is_pinned ? 1 : 0, now, now);
  return ok(res, toMemo(db.prepare('SELECT * FROM Memos WHERE id = ?').get(info.lastInsertRowid)), 201);
});

/* ============ 重要日期 CRUD ============ */
function toImpDate(r) {
  return { id: r.id, user_id: r.user_id, title: r.title, target_date: r.target_date, color: r.color, created_at: r.created_at };
}
router.get('/important-dates', (req, res) => {
  const userId = Number(req.params.user_id);
  const rows = db.prepare('SELECT * FROM Important_Dates WHERE user_id = ? ORDER BY target_date ASC').all(userId);
  return ok(res, rows.map(toImpDate));
});
router.post('/important-dates', (req, res) => {
  const userId = Number(req.params.user_id);
  const { title, target_date, color } = req.body || {};
  if (!title || !isValidDate(target_date)) return fail(res, 400, 'VALIDATION_ERROR', 'title 為必填、target_date 需為 YYYY-MM-DD 格式');
  const now = nowIso();
  const info = db
    .prepare('INSERT INTO Important_Dates (user_id, title, target_date, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, title, target_date, color || null, now);
  return ok(res, toImpDate(db.prepare('SELECT * FROM Important_Dates WHERE id = ?').get(info.lastInsertRowid)), 201);
});

module.exports = router;
