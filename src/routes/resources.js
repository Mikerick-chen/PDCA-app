// 以資源 id 操作的路由（v2）：計畫項目 / 日記 / 備忘錄 / 重要日期 的更新與刪除。
// 每個操作都會驗證資源屬於 token 內的使用者，避免越權。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth-middleware');
const { ok, fail, nowIso } = require('../helpers');

const router = express.Router();
router.use(authRequired);

// 直接掛在使用者下的資源：驗證 row.user_id
function owned(table, id, userId) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row || row.user_id !== userId) return null;
  return row;
}

/* ---- 計畫項目：更新（含 Do 勾選）/ 刪除 ---- */
// 計畫項目經由所屬日誌驗證擁有者
function ownedItem(id, userId) {
  const item = db.prepare('SELECT * FROM Plan_Items WHERE id = ?').get(id);
  if (!item) return null;
  const log = db.prepare('SELECT user_id FROM PDCA_Daily_Logs WHERE id = ?').get(item.log_id);
  if (!log || log.user_id !== userId) return null;
  return item;
}

// 取某日誌最新的計畫項目與完成度（百分比整數）。
// 讓 PATCH/DELETE /items/:id 直接回傳這份資料，前端即可就地更新，省去一趟 GET /logs/:id。
function itemsAndProgress(logId) {
  const items = db
    .prepare('SELECT * FROM Plan_Items WHERE log_id = ? ORDER BY sort_order ASC, id ASC')
    .all(logId)
    .map((r) => ({
      id: r.id, log_id: r.log_id, content: r.content, planned_time: r.planned_time,
      is_done: r.is_done === 1, sort_order: r.sort_order,
    }));
  const total = items.length;
  const done = items.filter((i) => i.is_done).length;
  const progress = total > 0 ? Math.round((done * 100) / total) : 0;
  return { plan_items: items, progress };
}

router.patch('/items/:id', (req, res) => {
  const item = ownedItem(req.params.id, req.user.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '找不到指定計畫項目');

  const body = req.body || {};
  const fields = [];
  const values = [];
  if ('content' in body) {
    if (!String(body.content).trim()) return fail(res, 400, 'VALIDATION_ERROR', 'content 不可為空');
    fields.push('content = ?');
    values.push(String(body.content).trim());
  }
  if ('planned_time' in body) {
    fields.push('planned_time = ?');
    values.push(body.planned_time || null);
  }
  if ('is_done' in body) {
    fields.push('is_done = ?');
    values.push(body.is_done ? 1 : 0);
  }
  if ('sort_order' in body) {
    fields.push('sort_order = ?');
    values.push(Number(body.sort_order) || 0);
  }
  if (fields.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', '至少需提供一個可更新欄位');
  }
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(item.id);
  db.prepare(`UPDATE Plan_Items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const u = db.prepare('SELECT * FROM Plan_Items WHERE id = ?').get(item.id);
  // 一併回傳該日誌最新的 plan_items 與 progress，供前端就地更新（降低同步成本）。
  return ok(res, {
    id: u.id, log_id: u.log_id, content: u.content, planned_time: u.planned_time,
    is_done: u.is_done === 1, sort_order: u.sort_order,
    ...itemsAndProgress(u.log_id),
  });
});

router.delete('/items/:id', (req, res) => {
  const item = ownedItem(req.params.id, req.user.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', '找不到指定計畫項目');
  const logId = item.log_id;
  db.prepare('DELETE FROM Plan_Items WHERE id = ?').run(item.id);
  // 刪除後同樣回傳該日誌最新狀態，前端據此就地更新、不必再 GET。
  return ok(res, { deleted_id: item.id, ...itemsAndProgress(logId) });
});

/* ---- 日記：更新 / 刪除 ---- */
router.patch('/diaries/:id', (req, res) => {
  const row = owned('Diaries', req.params.id, req.user.id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '找不到指定日記');
  const body = req.body || {};
  const fields = [];
  const values = [];
  for (const col of ['title', 'content', 'mood']) {
    if (col in body) { fields.push(`${col} = ?`); values.push(body[col]); }
  }
  if (fields.length === 0) return fail(res, 400, 'VALIDATION_ERROR', '至少需提供一個可更新欄位');
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(row.id);
  db.prepare(`UPDATE Diaries SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const u = db.prepare('SELECT * FROM Diaries WHERE id = ?').get(row.id);
  return ok(res, {
    id: u.id, user_id: u.user_id, entry_date: u.entry_date, title: u.title,
    content: u.content, mood: u.mood, created_at: u.created_at, updated_at: u.updated_at,
  });
});

router.delete('/diaries/:id', (req, res) => {
  const row = owned('Diaries', req.params.id, req.user.id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '找不到指定日記');
  db.prepare('DELETE FROM Diaries WHERE id = ?').run(row.id);
  return ok(res, { deleted_id: row.id });
});

/* ---- 備忘錄：更新 / 刪除 ---- */
router.patch('/memos/:id', (req, res) => {
  const row = owned('Memos', req.params.id, req.user.id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '找不到指定備忘錄');
  const body = req.body || {};
  const fields = [];
  const values = [];
  for (const col of ['title', 'content', 'color']) {
    if (col in body) { fields.push(`${col} = ?`); values.push(body[col]); }
  }
  if ('is_pinned' in body) { fields.push('is_pinned = ?'); values.push(body.is_pinned ? 1 : 0); }
  if (fields.length === 0) return fail(res, 400, 'VALIDATION_ERROR', '至少需提供一個可更新欄位');
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(row.id);
  db.prepare(`UPDATE Memos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const u = db.prepare('SELECT * FROM Memos WHERE id = ?').get(row.id);
  return ok(res, {
    id: u.id, user_id: u.user_id, title: u.title, content: u.content, color: u.color,
    is_pinned: u.is_pinned === 1, created_at: u.created_at, updated_at: u.updated_at,
  });
});

router.delete('/memos/:id', (req, res) => {
  const row = owned('Memos', req.params.id, req.user.id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '找不到指定備忘錄');
  db.prepare('DELETE FROM Memos WHERE id = ?').run(row.id);
  return ok(res, { deleted_id: row.id });
});

/* ---- 重要日期：更新 / 刪除 ---- */
router.patch('/important-dates/:id', (req, res) => {
  const row = owned('Important_Dates', req.params.id, req.user.id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '找不到指定重要日期');
  const body = req.body || {};
  const fields = [];
  const values = [];
  for (const col of ['title', 'target_date', 'color']) {
    if (col in body) { fields.push(`${col} = ?`); values.push(body[col]); }
  }
  if (fields.length === 0) return fail(res, 400, 'VALIDATION_ERROR', '至少需提供一個可更新欄位');
  values.push(row.id);
  db.prepare(`UPDATE Important_Dates SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const u = db.prepare('SELECT * FROM Important_Dates WHERE id = ?').get(row.id);
  return ok(res, {
    id: u.id, user_id: u.user_id, title: u.title, target_date: u.target_date,
    color: u.color, created_at: u.created_at,
  });
});

router.delete('/important-dates/:id', (req, res) => {
  const row = owned('Important_Dates', req.params.id, req.user.id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '找不到指定重要日期');
  db.prepare('DELETE FROM Important_Dates WHERE id = ?').run(row.id);
  return ok(res, { deleted_id: row.id });
});

module.exports = router;
