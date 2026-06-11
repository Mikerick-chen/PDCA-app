// 群組路由（v3 讀書會）：建立 / 加入 / 退出 / 管理。
// 群組型態＝邀請碼制私人群組（知道碼才能加入）。看板與排行榜於 Batch S3 實作。
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authRequired, requireGroupMember, requireGroupOwner } = require('../auth-middleware');
const { ok, fail, nowIso, isValidDate } = require('../helpers');

const router = express.Router();
router.use(authRequired);

const MAX_SESSION_MS = 6 * 60 * 60 * 1000; // 與 study.js 一致：逾此視為非「讀書中」（避免關分頁殘留）

// 加入端點限流：防暴力試邀請碼
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => fail(res, 429, 'RATE_LIMITED', '嘗試過於頻繁，請稍後再試'),
});

// 邀請碼字元（去掉易混淆的 0/O/1/I/L）
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genInviteCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function uniqueInviteCode() {
  for (let i = 0; i < 12; i++) {
    const code = genInviteCode();
    if (!db.prepare('SELECT 1 FROM Study_Groups WHERE invite_code = ?').get(code)) return code;
  }
  return genInviteCode(8); // 極少數連續碰撞時的退路
}
function memberCount(groupId) {
  return db.prepare('SELECT COUNT(*) AS c FROM Group_Members WHERE group_id = ?').get(groupId).c;
}
function toGroup(g, role) {
  return {
    id: g.id, name: g.name, description: g.description, color: g.color,
    owner_id: g.owner_id, invite_code: g.invite_code,
    role: role || null, member_count: memberCount(g.id), created_at: g.created_at,
  };
}

// 建立群組（建立者自動成為 owner + member）
router.post('/', (req, res) => {
  const { name, description, color } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'VALIDATION_ERROR', 'name 為必填');
  const now = nowIso();
  const code = uniqueInviteCode();
  const info = db
    .prepare('INSERT INTO Study_Groups (name, description, owner_id, invite_code, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(name).trim(), description || null, req.user.id, code, color || null, now, now);
  db.prepare('INSERT INTO Group_Members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(info.lastInsertRowid, req.user.id, 'owner', now);
  const g = db.prepare('SELECT * FROM Study_Groups WHERE id = ?').get(info.lastInsertRowid);
  return ok(res, toGroup(g, 'owner'), 201);
});

// 我加入的群組
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT g.*, gm.role AS my_role
       FROM Study_Groups g JOIN Group_Members gm ON gm.group_id = g.id
       WHERE gm.user_id = ? ORDER BY gm.joined_at DESC`
    )
    .all(req.user.id);
  return ok(res, rows.map((g) => toGroup(g, g.my_role)));
});

// 用邀請碼加入（已是成員則回現況；冪等）
router.post('/join', joinLimiter, (req, res) => {
  const raw = req.body && req.body.invite_code;
  const code = raw ? String(raw).trim().toUpperCase() : '';
  if (!code) return fail(res, 400, 'VALIDATION_ERROR', 'invite_code 為必填');
  const g = db.prepare('SELECT * FROM Study_Groups WHERE invite_code = ?').get(code);
  if (!g) return fail(res, 404, 'NOT_FOUND', '邀請碼無效');
  const exists = db.prepare('SELECT id FROM Group_Members WHERE group_id = ? AND user_id = ?').get(g.id, req.user.id);
  if (!exists) {
    db.prepare('INSERT INTO Group_Members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(g.id, req.user.id, 'member', nowIso());
  }
  const role = db.prepare('SELECT role FROM Group_Members WHERE group_id = ? AND user_id = ?').get(g.id, req.user.id).role;
  return ok(res, toGroup(g, role));
});

// 群組詳情 + 成員清單（限成員）
router.get('/:id', requireGroupMember, (req, res) => {
  const g = db.prepare('SELECT * FROM Study_Groups WHERE id = ?').get(req.groupId);
  const members = db
    .prepare(
      `SELECT gm.user_id, gm.role, gm.joined_at, u.display_name
       FROM Group_Members gm JOIN Users u ON u.id = gm.user_id
       WHERE gm.group_id = ? ORDER BY (gm.role = 'owner') DESC, gm.joined_at ASC`
    )
    .all(req.groupId)
    .map((m) => ({ user_id: m.user_id, display_name: m.display_name, role: m.role, joined_at: m.joined_at }));
  const my = db.prepare('SELECT role FROM Group_Members WHERE group_id = ? AND user_id = ?').get(req.groupId, req.user.id);
  return ok(res, { ...toGroup(g, my.role), members });
});

// 編輯群組（owner）
router.patch('/:id', requireGroupOwner, (req, res) => {
  const body = req.body || {};
  const fields = [];
  const values = [];
  for (const col of ['name', 'description', 'color']) {
    if (col in body) {
      if (col === 'name' && !String(body.name).trim()) return fail(res, 400, 'VALIDATION_ERROR', 'name 不可為空');
      fields.push(`${col} = ?`);
      values.push(col === 'name' ? String(body.name).trim() : (body[col] || null));
    }
  }
  if (fields.length === 0) return fail(res, 400, 'VALIDATION_ERROR', '至少需提供一個可更新欄位');
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(req.groupId);
  db.prepare(`UPDATE Study_Groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const g = db.prepare('SELECT * FROM Study_Groups WHERE id = ?').get(req.groupId);
  return ok(res, toGroup(g, 'owner'));
});

// 解散群組（owner）；CASCADE 會清掉成員
router.delete('/:id', requireGroupOwner, (req, res) => {
  db.prepare('DELETE FROM Study_Groups WHERE id = ?').run(req.groupId);
  return ok(res, { deleted_id: req.groupId });
});

// 退出群組（成員）；owner 退出 → 轉移給最早加入的其他成員，若無人則自動解散
router.delete('/:id/leave', requireGroupMember, (req, res) => {
  const groupId = req.groupId;
  const me = db.prepare('SELECT role FROM Group_Members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
  db.prepare('DELETE FROM Group_Members WHERE group_id = ? AND user_id = ?').run(groupId, req.user.id);
  let dissolved = false;
  if (me.role === 'owner') {
    const next = db.prepare('SELECT user_id FROM Group_Members WHERE group_id = ? ORDER BY joined_at ASC LIMIT 1').get(groupId);
    if (next) {
      db.prepare('UPDATE Group_Members SET role = ? WHERE group_id = ? AND user_id = ?').run('owner', groupId, next.user_id);
      db.prepare('UPDATE Study_Groups SET owner_id = ?, updated_at = ? WHERE id = ?').run(next.user_id, nowIso(), groupId);
    } else {
      db.prepare('DELETE FROM Study_Groups WHERE id = ?').run(groupId);
      dissolved = true;
    }
  }
  return ok(res, { left_group_id: groupId, dissolved });
});

/* ---- 即時看板 + 排行榜（限成員）---- */

// 即時看板：每位成員的「是否讀書中、目前科目、即時秒數、今日總時」（依今日總時排序）。
router.get('/:id/board', requireGroupMember, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 需為 YYYY-MM-DD 格式');
  const members = db
    .prepare(
      `SELECT gm.user_id, gm.role, u.display_name
       FROM Group_Members gm JOIN Users u ON u.id = gm.user_id WHERE gm.group_id = ?`
    )
    .all(req.groupId);
  if (members.length === 0) return ok(res, { date, members: [], group_today_seconds: 0 });
  const ids = members.map((m) => m.user_id);
  const ph = ids.map(() => '?').join(',');

  // 今日「已結束」段的總秒數（每人）
  const finishedRows = db
    .prepare(
      `SELECT user_id, COALESCE(SUM(duration_seconds), 0) AS secs FROM Study_Sessions
       WHERE study_date = ? AND ended_at IS NOT NULL AND user_id IN (${ph}) GROUP BY user_id`
    )
    .all(date, ...ids);
  const finishedMap = {};
  finishedRows.forEach((r) => { finishedMap[r.user_id] = r.secs; });

  // 進行中（且未逾上限＝視為讀書中）段，取每人最新一筆
  const runningRows = db
    .prepare(`SELECT user_id, subject, started_at FROM Study_Sessions WHERE ended_at IS NULL AND user_id IN (${ph}) ORDER BY started_at DESC`)
    .all(...ids);
  const now = Date.now();
  const runMap = {};
  for (const r of runningRows) {
    if (runMap[r.user_id]) continue; // 每人只取最新
    const elapsed = Math.floor((now - new Date(r.started_at).getTime()) / 1000);
    if (elapsed * 1000 <= MAX_SESSION_MS) runMap[r.user_id] = { subject: r.subject, live_seconds: elapsed > 0 ? elapsed : 0 };
  }

  const list = members.map((m) => {
    const run = runMap[m.user_id];
    const todayFinished = finishedMap[m.user_id] || 0;
    return {
      user_id: m.user_id, display_name: m.display_name, role: m.role,
      status: run ? 'studying' : 'idle',
      current_subject: run ? run.subject : null,
      live_seconds: run ? run.live_seconds : 0,
      today_seconds: todayFinished + (run ? run.live_seconds : 0),
    };
  });
  list.sort((a, b) => b.today_seconds - a.today_seconds);
  const groupTotal = list.reduce((s, m) => s + m.today_seconds, 0);
  return ok(res, { date, members: list, group_today_seconds: groupTotal });
});

// 排行榜：今日(day) 或 本週(week) 的「已結束」讀書總時數（由多到少）。
router.get('/:id/leaderboard', requireGroupMember, (req, res) => {
  const period = req.query.period === 'week' ? 'week' : 'day';
  const date = req.query.date;
  if (!isValidDate(date)) return fail(res, 400, 'VALIDATION_ERROR', 'date 需為 YYYY-MM-DD 格式');

  let from;
  let to;
  if (period === 'day') {
    from = date;
    to = date;
  } else {
    // 以日期字串所在週的週一~週日（UTC parse，時區安全，與 /week-acts 一致）
    const d = new Date(date + 'T00:00:00Z');
    const dow = d.getUTCDay();
    const offMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() + offMon);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    from = mon.toISOString().slice(0, 10);
    to = sun.toISOString().slice(0, 10);
  }

  const members = db
    .prepare(`SELECT gm.user_id, u.display_name FROM Group_Members gm JOIN Users u ON u.id = gm.user_id WHERE gm.group_id = ?`)
    .all(req.groupId);
  const ids = members.map((m) => m.user_id);
  let map = {};
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT user_id, COALESCE(SUM(duration_seconds), 0) AS secs FROM Study_Sessions
         WHERE ended_at IS NOT NULL AND study_date >= ? AND study_date <= ? AND user_id IN (${ph}) GROUP BY user_id`
      )
      .all(from, to, ...ids);
    rows.forEach((r) => { map[r.user_id] = r.secs; });
  }
  const list = members
    .map((m) => ({ user_id: m.user_id, display_name: m.display_name, seconds: map[m.user_id] || 0 }))
    .sort((a, b) => b.seconds - a.seconds);
  return ok(res, { period, from, to, members: list });
});

// 踢除成員（owner；不可踢自己——擁有者請用「退出/解散」）
router.delete('/:id/members/:user_id', requireGroupOwner, (req, res) => {
  const targetId = Number(req.params.user_id);
  if (targetId === req.user.id) return fail(res, 400, 'VALIDATION_ERROR', '擁有者請用「退出/解散」而非踢除自己');
  const m = db.prepare('SELECT id FROM Group_Members WHERE group_id = ? AND user_id = ?').get(req.groupId, targetId);
  if (!m) return fail(res, 404, 'NOT_FOUND', '此使用者不是群組成員');
  db.prepare('DELETE FROM Group_Members WHERE group_id = ? AND user_id = ?').run(req.groupId, targetId);
  return ok(res, { removed_user_id: targetId });
});

module.exports = router;
