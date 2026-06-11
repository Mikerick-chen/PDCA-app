// JWT 驗證中介層：保護需要登入的 API。
// 依 SPEC — 受保護 API 需於 Authorization: Bearer <token> 帶入憑證。
const jwt = require('jsonwebtoken');
const db = require('./db');
const { fail } = require('./helpers');

// 原始碼預設密鑰：僅供辨識「未設定」之用，絕不可用於任何實際部署或本機開發。
const DEFAULT_JWT_SECRET = 'pdca-time-master-dev-secret-change-me';

// JWT 密鑰：一律以環境變數 JWT_SECRET 設定。
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const TOKEN_TTL = process.env.JWT_TTL || '7d';

// 啟動即驗證（fail-fast）：若 JWT_SECRET 未設定、或仍等於原始碼預設值，直接拒絕啟動。
// 原因：預設值就寫在公開原始碼裡，任何人都能用它以 HS256 簽出任意使用者的合法 token，
//       等於全站後門。寧可起不來，也不可帶著預設密鑰上線。本機開發亦需自行設定。
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET) {
  console.error(
    [
      '✗ 啟動中止：偵測到 JWT_SECRET 未設定或仍為原始碼預設值。',
      '  預設密鑰寫在公開程式碼中，任何人都能用它偽造任意使用者的 token（後門全開）。',
      '  請設定一段足夠長的隨機字串後再啟動，例如：',
      '    PowerShell： $env:JWT_SECRET="<至少 32 字元的隨機字串>"; npm start',
      '    bash      ： JWT_SECRET="<至少 32 字元的隨機字串>" npm start',
      '    Zeabur    ： 於服務的環境變數新增 JWT_SECRET（正式環境必填）。',
    ].join('\n')
  );
  process.exit(1);
}

// 核發 token
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// 驗證 token 的中介層；通過後將使用者資訊掛到 req.user
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return fail(res, 401, 'UNAUTHORIZED', '缺少或格式錯誤的授權標頭');
  }
  try {
    const payload = jwt.verify(parts[1], JWT_SECRET);
    // 確認 token 對應的使用者仍存在（避免舊版殘留 token 指向不存在的使用者而造成 500）
    const user = db.prepare('SELECT id FROM Users WHERE id = ?').get(payload.id);
    if (!user) return fail(res, 401, 'UNAUTHORIZED', '帳號不存在或登入已失效，請重新登入');
    req.user = payload;
    return next();
  } catch (e) {
    return fail(res, 401, 'UNAUTHORIZED', '憑證無效或已過期');
  }
}

// 確認路徑上的 :user_id 與 token 中的使用者一致，避免越權存取他人資料。
function sameUser(req, res, next) {
  const pathUserId = Number(req.params.user_id);
  if (!req.user || req.user.id !== pathUserId) {
    return fail(res, 401, 'FORBIDDEN', '無權存取其他使用者的資料');
  }
  return next();
}

// 讀書會新增的授權型態：確認請求者「屬於」路徑指定的群組（:id 或 :group_id）。
// 這是本功能唯一的跨使用者讀取授權——同群組成員可互看彼此的讀書資料（看板/排行於 S3）。
function requireGroupMember(req, res, next) {
  const groupId = Number(req.params.id || req.params.group_id);
  if (!req.user || !groupId) return fail(res, 403, 'FORBIDDEN', '無權存取此群組');
  const m = db.prepare('SELECT id FROM Group_Members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
  if (!m) return fail(res, 403, 'FORBIDDEN', '你不是此群組的成員');
  req.groupId = groupId;
  return next();
}

// 僅群組擁有者可執行（編輯/解散/踢人）。
function requireGroupOwner(req, res, next) {
  const groupId = Number(req.params.id || req.params.group_id);
  if (!req.user || !groupId) return fail(res, 403, 'FORBIDDEN', '無權執行此操作');
  const m = db.prepare('SELECT role FROM Group_Members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
  if (!m || m.role !== 'owner') return fail(res, 403, 'FORBIDDEN', '只有群組擁有者可執行此操作');
  req.groupId = groupId;
  return next();
}

module.exports = { signToken, authRequired, sameUser, requireGroupMember, requireGroupOwner, JWT_SECRET };
