// 共用工具：統一回應格式、時間、驗證。
// 依 SPEC 3.2 — 成功一律包 { success:true, data }；錯誤包 { success:false, error }。

// 取得目前 UTC 的 ISO 8601 字串
function nowIso() {
  return new Date().toISOString();
}

// 統一成功回應
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

// 統一錯誤回應
function fail(res, status, code, message, details = {}) {
  return res.status(status).json({
    success: false,
    error: { code, message, details },
  });
}

// 驗證日期字串格式 YYYY-MM-DD（且必須是真實存在的日期）
function isValidDate(str) {
  if (typeof str !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  // 進一步擋掉「格式正確但日子不存在」的日期：如 2026-02-30 會被 JS 靜默進位成 2026-03-02。
  // 將 parse 後的結果轉回 YYYY-MM-DD 與原字串比對，不相等即視為非法（回 400）。
  return d.toISOString().slice(0, 10) === str;
}

// 驗證 YYYY-MM 月份
function isValidMonth(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}$/.test(str);
}

// 驗證 Email 格式（簡易）
function isValidEmail(str) {
  return typeof str === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

module.exports = { nowIso, ok, fail, isValidDate, isValidMonth, isValidEmail };
