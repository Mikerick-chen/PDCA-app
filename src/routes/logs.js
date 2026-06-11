// PDCA 日誌路由（v2）：
// - 初始化/查詢日誌時，一併回傳計畫項目（Plan_Items）與「即時計算的完成度」。
// - Plan 逐項新增（含預定時間）；Do 以勾選 is_done 確認完成。
// - 完成度 progress = 已勾選項目 / 總項目（無項目則 0）。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth-middleware');
const { ok, fail, nowIso, isValidDate } = require('../helpers');

const router = express.Router();

// 取某日誌的計畫項目
function itemsOf(logId) {
  return db
    .prepare('SELECT * FROM Plan_Items WHERE log_id = ? ORDER BY sort_order ASC, id ASC')
    .all(logId)
    .map((r) => ({
      id: r.id,
      log_id: r.log_id,
      content: r.content,
      planned_time: r.planned_time,
      is_done: r.is_done === 1,
      sort_order: r.sort_order,
    }));
}

// 即時計算完成度（百分比整數）
function progressOf(logId) {
  const r = db
    .prepare('SELECT COUNT(*) AS t, COALESCE(SUM(is_done), 0) AS d FROM Plan_Items WHERE log_id = ?')
    .get(logId);
  return r.t > 0 ? Math.round((r.d * 100) / r.t) : 0;
}

// 組出對外日誌物件（含項目與完成度）
function toLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    log_date: row.log_date,
    check_content: row.check_content,
    act_content: row.act_content,
    plan_items: itemsOf(row.id),
    progress: progressOf(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 初始化／取得當日日誌（冪等）
router.post('/init', authRequired, (req, res) => {
  const userId = req.user.id;
  const { log_date } = req.body || {};
  if (!isValidDate(log_date)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'log_date 為必填且需為 YYYY-MM-DD 格式');
  }
  const existing = db
    .prepare('SELECT * FROM PDCA_Daily_Logs WHERE user_id = ? AND log_date = ?')
    .get(userId, log_date);
  if (existing) return ok(res, toLog(existing), 200);

  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO PDCA_Daily_Logs (user_id, log_date, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, log_date, now, now);
  const row = db.prepare('SELECT * FROM PDCA_Daily_Logs WHERE id = ?').get(info.lastInsertRowid);
  return ok(res, toLog(row), 201);
});

// 依日期唯讀查詢日誌（查無回 null，不建立空日誌）。
// 用途：讀書會的「科目」下拉要帶入當天的計畫項目，但不應因此誤建空白日誌。
// 註：此路由須定義在 GET '/:id' 之前，否則 'by-date' 會被當成 :id。
router.get('/by-date', authRequired, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 需為 YYYY-MM-DD 格式');
  const row = db
    .prepare('SELECT * FROM PDCA_Daily_Logs WHERE user_id = ? AND log_date = ?')
    .get(req.user.id, date);
  return ok(res, row ? toLog(row) : null);
});

// 查詢單一日誌
router.get('/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM PDCA_Daily_Logs WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.user.id) {
    return fail(res, 404, 'NOT_FOUND', '找不到指定日誌');
  }
  return ok(res, toLog(row));
});

// 更新 Check / Act 文字（Plan/Do 由項目 API 處理）
router.patch('/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM PDCA_Daily_Logs WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.user.id) {
    return fail(res, 404, 'NOT_FOUND', '找不到指定日誌');
  }
  const body = req.body || {};
  // 樂觀鎖（選配，任務 M）：若前端帶了 updated_at 且與現況不符，表示此日誌已在他處被更新 →
  // 回 409，並於 details.current 附上伺服器最新版，讓前端非破壞性地重載、不直接覆蓋他人變更。
  // 與「最後寫入者勝」並存：前端收到 409 後會以最新 updated_at 重試，使用者的編輯仍可勝出。
  if ('updated_at' in body && body.updated_at && body.updated_at !== row.updated_at) {
    return fail(res, 409, 'CONFLICT', '此日誌已在他處被更新，已為你重新載入', { current: toLog(row) });
  }
  const fields = [];
  const values = [];
  for (const col of ['check_content', 'act_content']) {
    if (col in body) {
      fields.push(`${col} = ?`);
      values.push(body[col]);
    }
  }
  if (fields.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', '至少需提供 check_content 或 act_content');
  }
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(row.id);
  db.prepare(`UPDATE PDCA_Daily_Logs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM PDCA_Daily_Logs WHERE id = ?').get(row.id);
  return ok(res, toLog(updated));
});

// 新增一個計畫項目（Plan 逐項輸入）
// 【待辦本質・刻意設計】計畫項目僅屬「當日」這筆 log，永遠不跨日。
// 嚴禁日後加入「把昨天的 Act 自動帶成今天的 Plan」之類的跨日帶入邏輯——
// 本工具定位為待辦清單，跨日彙整只透過唯讀的「本週 Act 回顧」面板（/week-acts）呈現。
router.post('/:id/items', authRequired, (req, res) => {
  const log = db.prepare('SELECT * FROM PDCA_Daily_Logs WHERE id = ?').get(req.params.id);
  if (!log || log.user_id !== req.user.id) {
    return fail(res, 404, 'NOT_FOUND', '找不到指定日誌');
  }
  const { content, planned_time } = req.body || {};
  if (!content || !String(content).trim()) {
    return fail(res, 400, 'VALIDATION_ERROR', 'content 為必填');
  }
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM Plan_Items WHERE log_id = ?').get(log.id);
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO Plan_Items (log_id, content, planned_time, is_done, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    )
    .run(log.id, String(content).trim(), planned_time || null, maxRow.m + 1, now, now);
  const item = db.prepare('SELECT * FROM Plan_Items WHERE id = ?').get(info.lastInsertRowid);
  return ok(res, {
    id: item.id,
    log_id: item.log_id,
    content: item.content,
    planned_time: item.planned_time,
    is_done: item.is_done === 1,
    sort_order: item.sort_order,
    // 一併回傳該日誌最新的 plan_items 與 progress，前端新增後即可就地更新、不必再 GET。
    plan_items: itemsOf(log.id),
    progress: progressOf(log.id),
  }, 201);
});

module.exports = router;
