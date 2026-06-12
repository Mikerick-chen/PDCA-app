// PDCA Time Master 前端主程式 v2（Vanilla JS，無框架）。
// v2 變更：
//  - 以 Gmail（email）登入；註冊只需 Gmail / 姓名 / 密碼。
//  - Plan 改為逐項輸入（含預定時間）；Do 以勾選確認完成。
//  - 完成度由勾選比例自動計算，不再手動拉動。
//  - 移除「三大目標範本」按鈕；重新設計登入頁面。

'use strict';

const API = '/api/v1';
const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || navigator.userAgent || ''));
const state = {
  token: localStorage.getItem('pdca_token') || null,
  user: JSON.parse(localStorage.getItem('pdca_user') || 'null'),
  view: 'pdca',
  selectedDate: todayStr(),
  calMonth: todayStr().slice(0, 7),
  currentLog: null,
  importantDates: [],
  navCollapsed: localStorage.getItem('pdca_nav_collapsed') === '1', // 側欄是否收合（純 UI 狀態）
};
let chart = null;
let chartTimer = null;            // Check 圖表刷新的 debounce 計時器（避免連點時整張重畫）
// 倒數計時器狀態抽離至模組層：切換視圖時 interval 會被清掉，但狀態保留，重繪後還原（修「切視圖卡死」）。
const timerState = { remaining: 25 * 60, total: 25 * 60, running: false, endsAt: 0 };
let timerInterval = null;         // setInterval 代號（取代舊的全域 timer）
let syncTimer = null;             // 跨裝置近即時同步的輪詢計時器
// 讀書會：讀書計時器（碼錶，無心跳；即時秒數由 started_at 本地累加）
let studyTickInterval = null;
let studyActive = null;           // 目前進行中的讀書段（或 null）
let studyFinishedSeconds = 0;     // 今日「已結束」段的總秒數
let studySelectedGroupId = null;  // 目前選取的群組（看板）
let studyBoardTab = 'today';      // 看板分頁：today（今日看板）/ week（本週排行）
let studyBoardInterval = null;    // 看板輪詢計時器（~15 秒）

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function esc(s) {
  // 一律跳脫：& < > " ' `（補上單引號與反引號，避免值被放進單引號/反引號屬性時破防）
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    const msg = (json.error && json.error.message) || `錯誤（${res.status}）`;
    if (res.status === 401 && state.token) { logout(); }
    // 在錯誤物件帶上狀態碼/代碼/細節，供呼叫端分流（如樂觀鎖 409）。
    const err = new Error(msg);
    err.status = res.status;
    err.code = json.error && json.error.code;
    err.details = (json.error && json.error.details) || {};
    throw err;
  }
  return json.data;
}

/* ============ UI 元件：Toast / 確認框 / 忙碌狀態 / 載入骨架（D3）============ */
// 非阻斷的浮出通知（取代原生 alert）。type: info / success / error
function toast(message, type = 'info', ms = 3600) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = el('<div id="toastHost" class="toast-host" aria-live="polite" aria-atomic="false"></div>');
    document.body.appendChild(host);
  }
  const icon = type === 'error' ? 'ti-alert-circle' : type === 'success' ? 'ti-circle-check' : 'ti-info-circle';
  const t = el(`<div class="toast toast-${type}" role="status"><i class="ti ${icon}"></i><span>${esc(message)}</span></div>`);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const close = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 200); };
  t.onclick = close;
  setTimeout(close, ms);
}

// 樣式化確認對話框（取代原生 confirm）；回傳 Promise<boolean>。支援 ESC/Enter、點遮罩取消。
function confirmDialog(message, { confirmText = '確定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = el(`<div class="modal-mask"><div class="modal modal-confirm" role="dialog" aria-modal="true">
      <p class="confirm-msg">${esc(message)}</p>
      <div class="modal-btns">
        <button class="btn-ghost" data-act="cancel">${esc(cancelText)}</button>
        <button class="btn-save${danger ? ' btn-danger' : ''}" data-act="ok">${esc(confirmText)}</button>
      </div></div></div>`);
    document.body.appendChild(modal);
    const done = (v) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); };
    document.addEventListener('keydown', onKey);
    modal.querySelector('[data-act="cancel"]').onclick = () => done(false);
    modal.querySelector('[data-act="ok"]').onclick = () => done(true);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) done(false); });
    modal.querySelector('[data-act="ok"]').focus();
  });
}

// 非同步動作期間，讓按鈕進入忙碌/禁用狀態（顯示轉圈），完成後還原。
async function withBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
  try { return await fn(); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); } }
}

/* ---- 載入骨架（取代「載入中…」純文字，降低感知延遲、零版面位移）---- */
function skelView(inner) { return `<div class="view">${inner}</div>`; }
function skeletonPDCA() {
  const cell = '<div class="skel-card"><div class="skel skel-h"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:72%"></div></div>';
  return skelView(`<div class="skel skel-title"></div><div class="pdca-grid">${cell.repeat(4)}</div>`);
}
function skeletonCards(n = 4) {
  const card = '<div class="skel-card"><div class="skel skel-line" style="width:42%"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:80%"></div></div>';
  return skelView(`<div class="skel skel-title"></div><div class="skel-stack">${card.repeat(n)}</div>`);
}
function skeletonCalendar() {
  return skelView(`<div class="skel skel-title"></div><div class="skel-cal">${'<div class="skel skel-cell"></div>'.repeat(35)}</div>`);
}
function skeletonBoardRows(n = 4) {
  return ('<div class="skel-row"><div class="skel skel-av"></div><div class="skel skel-line"></div></div>').repeat(n);
}

/* ============ 命令面板（⌘K / Ctrl+K，D5）============ */
// 收合/展開側欄（抽出供按鈕與命令共用）
function toggleNav() {
  state.navCollapsed = !state.navCollapsed;
  localStorage.setItem('pdca_nav_collapsed', state.navCollapsed ? '1' : '0');
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('nav-collapsed', state.navCollapsed);
  const nb = document.getElementById('btnNav');
  if (nb) nb.setAttribute('aria-expanded', state.navCollapsed ? 'false' : 'true');
}
// 跳到今天
function jumpToday() {
  state.selectedDate = todayStr();
  const di = document.getElementById('dInput'); if (di) di.value = state.selectedDate;
  renderView();
}

// 組出所有可執行命令（依現有功能）
function buildCommands() {
  const go = (view) => { state.view = view; renderView(); };
  const gotoThen = async (view, fn) => { state.view = view; await renderView(); fn(); };
  return [
    { g: '前往', icon: 'ti-layout-grid', label: 'PDCA', kw: 'pdca 計畫', run: () => go('pdca') },
    { g: '前往', icon: 'ti-calendar-month', label: '行事曆', kw: 'calendar 月曆', run: () => go('calendar') },
    { g: '前往', icon: 'ti-book', label: '日記', kw: 'diary', run: () => go('diary') },
    { g: '前往', icon: 'ti-notes', label: '備忘錄', kw: 'memo notes', run: () => go('memos') },
    { g: '前往', icon: 'ti-users-group', label: '讀書會', kw: 'study group', run: () => go('study') },
    { g: '日期', icon: 'ti-calendar-month', label: '跳到今天', kw: 'today 今天', run: () => jumpToday() },
    { g: '日期', icon: 'ti-chevron-left', label: '前一天', kw: 'prev 昨天 yesterday', run: () => shiftDate(-1) },
    { g: '日期', icon: 'ti-chevron-right', label: '後一天', kw: 'next 明天 tomorrow', run: () => shiftDate(1) },
    { g: '新增', icon: 'ti-book', label: '新增日記', kw: 'add new diary 寫', run: () => gotoThen('diary', () => openDiaryModal()) },
    { g: '新增', icon: 'ti-notes', label: '新增備忘錄', kw: 'add new memo', run: () => gotoThen('memos', () => openMemoModal()) },
    { g: '新增', icon: 'ti-flag', label: '新增重要日期', kw: 'add important date countdown 倒數', run: () => openImportantDates() },
    { g: '新增', icon: 'ti-plus', label: '建立讀書會', kw: 'create study group', run: () => gotoThen('study', () => openGroupModal()) },
    { g: '新增', icon: 'ti-login-2', label: '加入讀書會', kw: 'join group invite 邀請碼', run: () => gotoThen('study', () => openJoinGroupModal()) },
    { g: '工具', icon: 'ti-clock-hour-4', label: '專注時鐘', kw: 'focus clock 全螢幕', run: () => openFocusClock() },
    { g: '工具', icon: 'ti-moon', label: '切換深/淺色', kw: 'theme dark light 深色 淺色', run: () => toggleTheme() },
    { g: '工具', icon: 'ti-menu-2', label: '收合/展開側欄', kw: 'sidebar collapse 側欄', run: () => toggleNav() },
    { g: '工具', icon: 'ti-logout', label: '登出', kw: 'logout sign out 登出', run: () => logout() },
  ];
}

let cmdkSel = 0;
let cmdkFiltered = [];
function closeCmdk() { document.querySelectorAll('.cmdk-mask').forEach((n) => n.remove()); }
function openCmdk() {
  if (!state.token || !state.user) return;       // 僅登入後可用
  if (document.querySelector('.cmdk-mask')) { closeCmdk(); return; } // 再按一次關閉
  const all = buildCommands();
  cmdkSel = 0;
  const mask = el(`<div class="cmdk-mask"><div class="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
    <div class="cmdk-search"><i class="ti ti-search"></i><input id="cmdkInput" type="text" placeholder="輸入命令或搜尋…（Esc 關閉）" autocomplete="off" aria-label="命令搜尋" /></div>
    <div class="cmdk-list" id="cmdkList" role="listbox"></div>
  </div></div>`);
  document.body.appendChild(mask);
  const input = mask.querySelector('#cmdkInput');
  const listEl = mask.querySelector('#cmdkList');
  const mark = () => {
    listEl.querySelectorAll('.cmdk-item').forEach((it) => it.classList.toggle('active', +it.dataset.i === cmdkSel));
    const a = listEl.querySelector('.active'); if (a) a.scrollIntoView({ block: 'nearest' });
  };
  const run = (c) => { if (!c) return; closeCmdk(); try { c.run(); } catch (e) { toast(e.message, 'error'); } };
  const renderList = () => {
    const q = input.value.trim().toLowerCase();
    cmdkFiltered = q ? all.filter((c) => (`${c.label} ${c.kw || ''} ${c.g}`).toLowerCase().includes(q)) : all;
    if (cmdkSel >= cmdkFiltered.length) cmdkSel = Math.max(0, cmdkFiltered.length - 1);
    if (cmdkFiltered.length === 0) { listEl.innerHTML = '<div class="cmdk-empty">找不到相符的命令</div>'; return; }
    let html = ''; let lastG = null;
    cmdkFiltered.forEach((c, i) => {
      if (c.g !== lastG) { html += `<div class="cmdk-group">${esc(c.g)}</div>`; lastG = c.g; }
      html += `<div class="cmdk-item${i === cmdkSel ? ' active' : ''}" role="option" data-i="${i}"><i class="ti ${c.icon}"></i><span>${esc(c.label)}</span></div>`;
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.cmdk-item').forEach((it) => {
      it.onmousemove = () => { const idx = +it.dataset.i; if (cmdkSel !== idx) { cmdkSel = idx; mark(); } };
      it.onclick = () => run(cmdkFiltered[+it.dataset.i]);
    });
  };
  input.oninput = renderList;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = Math.min(cmdkFiltered.length - 1, cmdkSel + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = Math.max(0, cmdkSel - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(cmdkFiltered[cmdkSel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
  };
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeCmdk(); });
  renderList();
  setTimeout(() => input.focus(), 0);
}
// 全域快捷鍵：⌘K（Mac）/ Ctrl+K（其他）開啟/關閉命令面板。只註冊一次。
function registerCmdk() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCmdk(); }
  });
}

/* ============ 無障礙（a11y，D4）============ */
// 讓「可點擊的 div」也能用鍵盤操作（Enter / Space），並補上 role/tabindex。
function onActivate(elm, fn) {
  elm.setAttribute('role', 'button');
  elm.setAttribute('tabindex', '0');
  elm.addEventListener('click', fn);
  elm.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } });
}
// 所有浮層（modal-mask / cmdk-mask）統一補：role/aria-modal、開啟自動聚焦、
// Tab 焦點鎖在浮層內、Esc 關閉、關閉後把焦點還給開啟前的元素。只註冊一次（MutationObserver）。
function setupOverlayA11y() {
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const isOverlay = (n) => n.nodeType === 1 && n.classList && (n.classList.contains('modal-mask') || n.classList.contains('cmdk-mask'));
  const enhance = (mask) => {
    const dialog = mask.querySelector('.modal, .cmdk') || mask;
    if (!dialog.getAttribute('role')) dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    mask._prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        const cancel = mask.querySelector('[data-act="cancel"],#dy-cancel,#mo-cancel,#g-cancel,#j-cancel,#m-close,#id-cancel');
        e.preventDefault();
        if (cancel) cancel.click(); else mask.remove();
      } else if (e.key === 'Tab') {
        const f = Array.from(mask.querySelectorAll(FOCUSABLE)).filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !mask.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };
    mask._a11yKey = onKey;
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { if (!mask.contains(document.activeElement)) { const f = dialog.querySelector(FOCUSABLE); if (f) f.focus(); } }, 0);
  };
  new MutationObserver((muts) => {
    muts.forEach((m) => {
      m.addedNodes.forEach((n) => { if (isOverlay(n)) enhance(n); });
      m.removedNodes.forEach((n) => {
        if (isOverlay(n)) {
          if (n._a11yKey) document.removeEventListener('keydown', n._a11yKey, true);
          if (n._prevFocus && n._prevFocus.focus) { try { n._prevFocus.focus(); } catch (e) { /* 忽略 */ } }
        }
      });
    });
  }).observe(document.body, { childList: true });
}

/* ============ 主題（深色模式，D2）============ */
// 偏好存於 localStorage.pdca_theme：light / dark / system（預設 system）。
function getThemePref() { return localStorage.getItem('pdca_theme') || 'system'; }
function effectiveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
// 套用主題：設定 <html data-theme>；pref 有給就一併存起來，並同步頂部切換鈕的圖示
function applyTheme(pref) {
  if (pref) localStorage.setItem('pdca_theme', pref);
  document.documentElement.dataset.theme = effectiveTheme(getThemePref());
  updateThemeToggleIcon();
  if (chart) { applyChartTheme(chart); chart.update('none'); } // 圖表色彩跟著切換
}
// 一鍵切換深/淺色（頂部列方框月亮/太陽鈕）
function toggleTheme() {
  const cur = effectiveTheme(getThemePref());
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
// 依目前主題更新頂部鈕圖示：淺色顯示月亮（點了變深色）、深色顯示太陽（點了變淺色）
function updateThemeToggleIcon() {
  const btn = document.getElementById('btnTheme');
  if (!btn) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  btn.innerHTML = `<i class="ti ti-${dark ? 'sun' : 'moon'}"></i>`;
  btn.title = dark ? '切換為淺色' : '切換為深色';
  btn.setAttribute('aria-label', dark ? '切換為淺色模式' : '切換為深色模式');
}

function boot() {
  if (state.token && state.user) {
    // 確保目前帳號也在「已登入帳號池」中（升級自舊版時補上）
    if (!loadAccounts().some((a) => a.id === state.user.id)) upsertAccount(state.user, state.token);
    renderApp();
  } else renderAuth();
}

/* ============ 多帳號切換（記住已登入過的帳號，可直接切換）============ */
// 帳號池：[{ id, email, display_name, token }]。純前端便利功能；token 存 localStorage，
// 與既有單一 token 的儲存方式一致（若日後改用 httpOnly cookie，這裡一併調整）。
function loadAccounts() {
  try { return JSON.parse(localStorage.getItem('pdca_accounts') || '[]'); } catch (e) { return []; }
}
function saveAccounts(list) { localStorage.setItem('pdca_accounts', JSON.stringify(list)); }
// 登入成功後把帳號加入/更新到帳號池（移到最前）
function upsertAccount(user, token) {
  const list = loadAccounts().filter((a) => a.id !== user.id);
  list.unshift({ id: user.id, email: user.email, display_name: user.display_name, token });
  saveAccounts(list);
}
function removeAccount(id) { saveAccounts(loadAccounts().filter((a) => a.id !== id)); }
// 設定目前作用中的帳號（同步 state 與 localStorage）
function setCurrent(user, token) {
  state.token = token;
  state.user = user;
  localStorage.setItem('pdca_token', token);
  localStorage.setItem('pdca_user', JSON.stringify(user));
}

// 直接切換到帳號池中的某帳號（免再輸入密碼；若該 token 已失效，下次 API 會收 401 自動處理）
function switchAccount(id) {
  const acc = loadAccounts().find((a) => a.id === id);
  if (!acc) return;
  setCurrent({ id: acc.id, email: acc.email, display_name: acc.display_name }, acc.token);
  closeAccountMenu();
  renderApp();
}
// 登入其他帳號：保留帳號池，前往登入頁；登入成功後會自動加入池並切換過去
function addAccount() {
  closeAccountMenu();
  renderAuth('login', { info: '登入要新增／切換的帳號（不會登出現有帳號）。' });
}

// 登出「目前帳號」：移出帳號池；若還有其他已登入帳號則直接切過去，否則回登入頁。
// （api() 在 401 時也會呼叫此函式：等同「此 token 失效 → 換下一個帳號或重新登入」。）
function logout() {
  const currentId = state.user && state.user.id;
  if (currentId != null) removeAccount(currentId);
  localStorage.removeItem('pdca_token');
  localStorage.removeItem('pdca_user');
  state.token = null;
  state.user = null;
  const rest = loadAccounts();
  if (rest.length > 0) {
    setCurrent({ id: rest[0].id, email: rest[0].email, display_name: rest[0].display_name }, rest[0].token);
    renderApp();
  } else {
    renderAuth();
  }
}

// 帳號切換下拉選單
function closeAccountMenu() {
  document.querySelectorAll('.acct-backdrop, .account-menu').forEach((n) => n.remove());
  const av = document.getElementById('btnAvatar');
  if (av) av.setAttribute('aria-expanded', 'false');
}
function openAccountMenu() {
  closeAccountMenu();
  const cur = state.user || {};
  const initialOf = (a) => esc((a.display_name || a.email || '?').slice(0, 1));
  const others = loadAccounts().filter((a) => a.id !== cur.id);
  const rows = others.map((a) => `
    <div class="acct-item" data-id="${a.id}">
      <span class="acct-av">${initialOf(a)}</span>
      <span class="acct-meta"><b>${esc(a.display_name || '（未命名）')}</b><span>${esc(a.email)}</span></span>
      <i class="ti ti-arrows-exchange acct-switch" title="切換到此帳號"></i>
      <button class="acct-remove" data-remove="${a.id}" title="從清單移除"><i class="ti ti-x"></i></button>
    </div>`).join('') || '<div class="acct-empty">沒有其他已登入的帳號</div>';

  const backdrop = el('<div class="acct-backdrop"></div>');
  const menu = el(`<div class="account-menu">
    <div class="acct-current">
      <span class="acct-av lg">${initialOf(cur)}</span>
      <div class="acct-meta"><b>${esc(cur.display_name || '（未命名）')}</b><span>${esc(cur.email || '')}</span></div>
    </div>
    <div class="acct-section-label">切換帳號</div>
    <div class="acct-list">${rows}</div>
    <div class="acct-actions">
      <button class="acct-action" id="acctAdd"><i class="ti ti-user-plus"></i> 登入其他帳號</button>
      <button class="acct-action danger" id="acctLogout"><i class="ti ti-logout"></i> 登出目前帳號</button>
    </div>
  </div>`);
  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
  const avBtn = document.getElementById('btnAvatar'); if (avBtn) avBtn.setAttribute('aria-expanded', 'true');
  backdrop.onclick = closeAccountMenu;
  menu.querySelectorAll('.acct-item').forEach((row) => {
    const id = Number(row.dataset.id);
    row.setAttribute('aria-label', `切換到 ${row.querySelector('.acct-meta b')?.textContent || '此帳號'}`);
    onActivate(row, () => switchAccount(id));
    const rm = row.querySelector('.acct-remove');
    rm.onclick = (e) => { e.stopPropagation(); removeAccount(Number(rm.dataset.remove)); openAccountMenu(); };
  });
  menu.querySelector('#acctAdd').onclick = addAccount;
  menu.querySelector('#acctLogout').onclick = () => { closeAccountMenu(); logout(); };
}

/* ============ 登入 / 註冊（v2 新版設計）============ */
function renderAuth(mode = 'login', opts = {}) {
  const root = document.getElementById('root');
  const isLogin = mode === 'login';
  root.innerHTML = `
    <div class="auth-shell">
      <aside class="auth-hero">
        <div class="hero-top">
          <div class="hero-brand">
            <span class="logo"><i class="ti ti-target-arrow"></i></span>
            PDCA Time Master
          </div>
          <p class="hero-tag">把每一天，<br>變成一次持續的進步。</p>
        </div>
        <ul class="hero-features">
          <li><i class="ti ti-circle-check"></i><div><b>Plan-Do-Check-Act</b><span>每天逐項規劃、勾選完成</span></div></li>
          <li><i class="ti ti-circle-check"></i><div><b>行事曆綜覽</b><span>一眼看整月的完成度</span></div></li>
          <li><i class="ti ti-circle-check"></i><div><b>日記與備忘錄</b><span>隨手記下想法與待辦</span></div></li>
          <li><i class="ti ti-circle-check"></i><div><b>專注時鐘與圖表</b><span>讓你的成長被看見</span></div></li>
        </ul>
        <div class="hero-foot">持續改善，從今天開始。</div>
      </aside>
      <main class="auth-panel">
        <div class="auth-form">
          <div class="auth-form-brand"><i class="ti ti-target-arrow"></i> PDCA Time Master</div>
          <h1>${isLogin ? '歡迎回來' : '建立你的帳號'}</h1>
          <p class="sub">${isLogin ? '使用 Gmail 登入，開始今天的循環' : '只要 Gmail、姓名與密碼即可開始'}</p>
          ${opts.info ? `<div class="info-msg">${esc(opts.info)}</div>` : ''}
          <div class="err-msg" id="authErr"></div>
          ${isLogin ? '' : `
          <div class="field"><label>姓名</label>
            <div class="input-wrap"><i class="ti ti-user"></i><input id="f-name" type="text" placeholder="App 內顯示的名稱" /></div>
          </div>`}
          <div class="field"><label>Gmail</label>
            <div class="input-wrap"><i class="ti ti-mail"></i><input id="f-email" type="email" placeholder="you@gmail.com" autocomplete="email" value="${esc(opts.email || '')}" /></div>
          </div>
          <div class="field"><label>密碼${isLogin ? '' : '（至少 8 碼）'}</label>
            <div class="input-wrap"><i class="ti ti-lock"></i><input id="f-password" type="password" placeholder="••••••••" /></div>
          </div>
          <button class="btn-primary" id="authSubmit">
            <i class="ti ${isLogin ? 'ti-login-2' : 'ti-user-plus'}"></i>${isLogin ? '登入' : '註冊並登入'}
          </button>
          <p class="auth-switch">
            ${isLogin ? '還沒有帳號？' : '已經有帳號了？'}
            <a id="authToggle">${isLogin ? '立即註冊' : '前往登入'}</a>
          </p>
        </div>
      </main>
    </div>`;

  document.getElementById('authToggle').onclick = () => renderAuth(isLogin ? 'register' : 'login');
  document.getElementById('authSubmit').onclick = () => submitAuth(mode);
  root.querySelectorAll('input').forEach((i) => {
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(mode); });
  });
}

async function submitAuth(mode) {
  const errBox = document.getElementById('authErr');
  errBox.textContent = '';
  const email = val('f-email');
  const password = val('f-password');
  const btn = document.getElementById('authSubmit');
  try {
    await withBusy(btn, async () => {
      if (mode === 'register') {
        await api('POST', '/auth/register', { email, display_name: val('f-name'), password });
        // 註冊成功後不直接進入 App，退回登入頁讓使用者重新登入以確認註冊無誤
        renderAuth('login', { info: '註冊成功，請使用 Gmail 與密碼登入。', email });
        return;
      }
      const data = await api('POST', '/auth/login', { email, password });
      setCurrent(data.user, data.token);
      upsertAccount(data.user, data.token); // 記住此帳號，供日後直接切換
      renderApp();
    });
  } catch (e) {
    errBox.textContent = e.message;
  }
}
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

/* ============ 應用骨架 ============ */
function renderApp() {
  const root = document.getElementById('root');
  const initial = (state.user.display_name || state.user.email || '?').slice(0, 1);
  root.innerHTML = `
    <div class="app${state.navCollapsed ? ' nav-collapsed' : ''}">
      <a href="#main" class="skip-link">跳到主要內容</a>
      <header class="topbar">
        <button class="icon-btn nav-toggle" id="btnNav" title="收合／展開選單" aria-label="收合或展開選單" aria-expanded="${state.navCollapsed ? 'false' : 'true'}"><i class="ti ti-menu-2"></i></button>
        <div class="brand"><i class="ti ti-target-arrow" style="color:var(--plan)"></i><span>PDCA Time Master</span></div>
        <button class="cmdk-trigger" id="btnCmdk" title="命令面板（${IS_MAC ? '⌘' : 'Ctrl'}＋K）" aria-label="開啟命令面板">
          <i class="ti ti-search"></i><span class="cmdk-kbd">${IS_MAC ? '⌘' : 'Ctrl'} K</span>
        </button>
        <button class="countdown-pill" id="cdPill" title="重要日期倒數" aria-label="重要日期倒數">
          <i class="ti ti-flag"></i><span id="cdPillText">新增重要日期</span>
        </button>
        <div class="spacer"></div>
        <div class="date-switch">
          <button id="dPrev" aria-label="前一天"><i class="ti ti-chevron-left"></i></button>
          <input type="date" id="dInput" value="${state.selectedDate}" aria-label="選擇日期" style="border:1px solid var(--border);border-radius:8px;height:32px;padding:0 8px;" />
          <button id="dNext" aria-label="後一天"><i class="ti ti-chevron-right"></i></button>
        </div>
        <button class="theme-toggle" id="btnTheme" title="切換深/淺色" aria-label="切換深/淺色"><i class="ti ti-moon"></i></button>
        <button class="icon-btn" id="btnClock" title="專注時鐘" aria-label="專注時鐘"><i class="ti ti-clock-hour-4"></i></button>
        <button class="avatar" id="btnAvatar" aria-haspopup="true" aria-expanded="false" title="帳號：${esc(state.user.display_name || state.user.email || '')}（點擊切換）" aria-label="帳號選單">${esc(initial)}</button>
        <button class="icon-btn" id="btnLogout" title="登出" aria-label="登出"><i class="ti ti-logout"></i></button>
      </header>
      <div class="body">
        <nav class="sidebar" aria-label="主要導覽">
          ${navItem('pdca', 'ti-layout-grid', 'PDCA')}
          ${navItem('calendar', 'ti-calendar-month', '行事曆')}
          ${navItem('diary', 'ti-book', '日記')}
          ${navItem('memos', 'ti-notes', '備忘錄')}
          ${navItem('study', 'ti-users-group', '讀書會')}
        </nav>
        <main class="main" id="main" tabindex="-1" aria-label="主要內容"></main>
      </div>
    </div>`;

  document.getElementById('btnLogout').onclick = logout;
  document.getElementById('btnClock').onclick = openFocusClock;
  document.getElementById('btnTheme').onclick = toggleTheme;
  updateThemeToggleIcon();
  document.getElementById('btnAvatar').onclick = openAccountMenu;
  document.getElementById('btnCmdk').onclick = openCmdk;
  document.getElementById('cdPill').onclick = openImportantDates;
  // 側欄收合切換：記住偏好（localStorage，純 UI 狀態），不影響任何業務資料。
  document.getElementById('btnNav').onclick = toggleNav;
  document.getElementById('dPrev').onclick = () => shiftDate(-1);
  document.getElementById('dNext').onclick = () => shiftDate(1);
  document.getElementById('dInput').onchange = (e) => {
    state.selectedDate = e.target.value;
    if (state.view === 'pdca' || state.view === 'diary') renderView();
  };
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.onclick = () => { state.view = n.dataset.view; renderView(); };
  });

  loadImportantDates();
  renderView();
}

function navItem(view, icon, label) {
  const active = state.view === view;
  return `<button class="nav-item${active ? ' active' : ''}" data-view="${view}"${active ? ' aria-current="page"' : ''}><i class="ti ${icon}"></i><span>${label}</span></button>`;
}

function shiftDate(delta) {
  const d = new Date(state.selectedDate + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  state.selectedDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const input = document.getElementById('dInput');
  if (input) input.value = state.selectedDate;
  if (state.view === 'pdca' || state.view === 'diary') renderView();
}

function setActiveNav() {
  document.querySelectorAll('.nav-item').forEach((n) => {
    const on = n.dataset.view === state.view;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });
}

async function renderView(opts = {}) {
  // 切換視圖/日期前，先把未存的 Check/Act flush 出去，避免重新渲染時無聲丟字。
  await flushCheckAct();
  // 停掉計時器的 interval（狀態保留在 timerState），避免舊 interval 更新已被移除的 DOM 而卡死。
  clearTimerInterval();
  clearStudyTick();
  clearStudyBoard();
  setActiveNav();
  const main = document.getElementById('main');
  if (state.view === 'pdca') return renderPDCA(main, opts);
  if (state.view === 'calendar') return renderCalendar(main, opts);
  if (state.view === 'diary') return renderDiary(main, opts);
  if (state.view === 'memos') return renderMemos(main, opts);
  if (state.view === 'study') return renderStudyGroups(main, opts);
}

/* ============ 跨裝置近即時同步（F）============ */
// 切回分頁 / 視窗聚焦 / 每 20 秒，安靜就地重抓目前視圖，拿到別台裝置剛存的內容。
function softRefresh() {
  if (!state.token || !state.user) return;
  // 使用者正在打字（焦點在輸入框）→ 跳過，避免把輸入中的內容洗掉。
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  // 有開啟對話框時跳過，避免底層重繪干擾。
  if (document.querySelector('.modal-mask')) return;
  // 讀書會（計時器在本地累加）與備忘錄（分頁狀態）不自動輪詢刷新，避免打斷使用者。
  if (state.view === 'study' || state.view === 'memos') return;
  renderView({ quiet: true });
}
// 全程只註冊一次監聽（登出時 softRefresh 會因無 token 自動失效）。
function startSync() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(); });
  window.addEventListener('focus', () => softRefresh());
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (!document.hidden) softRefresh(); }, 20000);
}

/* ============ 重要日期（倒數天數）============ */
async function loadImportantDates() {
  try {
    state.importantDates = await api('GET', `/users/${state.user.id}/important-dates`);
    updateCountdownPill();
  } catch (e) { /* 靜默 */ }
}
function daysUntil(dateStr) {
  const target = new Date(dateStr + 'T00:00:00');
  const now = new Date(todayStr() + 'T00:00:00');
  return Math.round((target - now) / 86400000);
}
function updateCountdownPill() {
  const txt = document.getElementById('cdPillText');
  if (!txt) return;
  const upcoming = state.importantDates
    .map((d) => ({ ...d, left: daysUntil(d.target_date) }))
    .filter((d) => d.left >= 0)
    .sort((a, b) => a.left - b.left)[0];
  txt.textContent = upcoming ? `距 ${upcoming.title} ${upcoming.left} 天` : '新增重要日期';
}

function openImportantDates() {
  const rows = state.importantDates
    .map((d) => {
      const left = daysUntil(d.target_date);
      const leftTxt = left >= 0 ? `還有 ${left} 天` : `已過 ${-left} 天`;
      return `<div class="diary-card" style="padding:10px 12px">
        <div class="meta"><span class="title">${esc(d.title)}</span>
        <div class="card-actions"><button data-del="${d.id}"><i class="ti ti-trash"></i></button></div></div>
        <div class="mood-tag">${d.target_date}・${leftTxt}</div></div>`;
    })
    .join('') || '<div class="empty-state">尚無重要日期</div>';

  const modal = el(`<div class="modal-mask"><div class="modal">
    <h3>重要日期倒數</h3>
    <div class="diary-list" style="margin-bottom:14px">${rows}</div>
    <input id="id-title" placeholder="事件名稱（如 期末考）" aria-label="事件名稱" />
    <input id="id-date" type="date" aria-label="目標日期" />
    <div class="modal-btns">
      <button class="btn-ghost" id="id-cancel">關閉</button>
      <button class="btn-save" id="id-add">新增</button>
    </div></div></div>`);
  document.body.appendChild(modal);
  modal.querySelector('#id-cancel').onclick = () => modal.remove();
  modal.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      await api('DELETE', `/important-dates/${b.dataset.del}`);
      await loadImportantDates();
      modal.remove(); openImportantDates();
    };
  });
  modal.querySelector('#id-add').onclick = async () => {
    const title = modal.querySelector('#id-title').value.trim();
    const target_date = modal.querySelector('#id-date').value;
    if (!title || !target_date) return;
    await api('POST', `/users/${state.user.id}/important-dates`, { title, target_date, color: '#e24b4a' });
    await loadImportantDates();
    modal.remove(); openImportantDates();
  };
}

/* ============ PDCA 視圖 ============ */
async function renderPDCA(main, opts = {}) {
  // 安靜就地刷新（輪詢/聚焦觸發）：版面已存在則不重建、不顯示「載入中」，只更新資料。
  const quiet = opts.quiet && document.getElementById('planItems') && state.currentLog;
  if (!quiet) main.innerHTML = skeletonPDCA();
  let log;
  try {
    log = await api('POST', '/logs/init', { log_date: state.selectedDate });
  } catch (e) {
    if (!quiet) main.innerHTML = `<div class="view"><div class="empty-state">${esc(e.message)}</div></div>`;
    return;
  }
  state.currentLog = log;

  if (quiet) {
    // 就地更新：保留捲動位置、計時器與週末面板，不重建整個版面。
    // softRefresh 已確保此時焦點不在輸入框，可安全同步 Check/Act 文字（拿到別台裝置剛存的內容）。
    const checkEl = document.getElementById('check');
    const actEl = document.getElementById('act');
    if (checkEl && checkEl.value !== (log.check_content || '')) checkEl.value = log.check_content || '';
    if (actEl && actEl.value !== (log.act_content || '')) actEl.value = log.act_content || '';
    renderPlanList();
    renderDoList();
    updateCheckProgress();
    bindTimer();            // 重新接上計時器（renderView 切換時清了 interval），保留運行狀態繼續顯示
    scheduleChartRefresh();
    maybeRenderWeekendReview();
    return;
  }

  main.innerHTML = `
    <div class="view">
      <div class="pdca-head">
        <h2 class="view-title" style="margin:0">PDCA・${state.selectedDate}</h2>
        <span class="save-status" id="saveStatus" title="Check／Act 會自動儲存" aria-live="polite" role="status"></span>
      </div>
      <div class="pdca-grid">
        <div class="pdca-cell plan">
          <h3><i class="ti ti-bulb"></i>Plan 計畫</h3>
          <div class="plan-items" id="planItems"></div>
          <div class="plan-add">
            <input id="piTime" class="pi-time" placeholder="時間" aria-label="計畫時間" />
            <input id="piContent" class="pi-new" placeholder="新增一項計畫…" aria-label="新增計畫項目" />
            <button id="piAdd" class="pi-add-btn" title="新增"><i class="ti ti-plus"></i></button>
          </div>
        </div>
        <div class="pdca-cell do">
          <h3><i class="ti ti-player-play"></i>Do 執行</h3>
          <div class="do-items" id="doItems"></div>
        </div>
        <div class="pdca-cell check">
          <h3><i class="ti ti-chart-bar"></i>Check 檢核</h3>
          <div class="check-progress" id="checkProg"></div>
          <textarea id="check" placeholder="對照計畫與執行的落差…">${esc(log.check_content)}</textarea>
          <div class="check-chart-wrap"><canvas id="checkChart" height="120"></canvas></div>
          <div class="stat-row" id="statRow"></div>
        </div>
        <div class="pdca-cell act">
          <h3><i class="ti ti-rotate-clockwise"></i>Act 行動</h3>
          <textarea id="act" placeholder="下一步的改善行動…">${esc(log.act_content)}</textarea>
        </div>
      </div>
      ${timerBarHTML()}
    </div>`;

  // 新增項目（以回應就地更新，不再額外 GET /logs/:id）
  const addItem = async () => {
    const content = document.getElementById('piContent').value.trim();
    const planned_time = document.getElementById('piTime').value.trim();
    if (!content) return;
    const r = await api('POST', `/logs/${state.currentLog.id}/items`, { content, planned_time });
    document.getElementById('piContent').value = '';
    document.getElementById('piTime').value = '';
    applyLogItems(r.plan_items, r.progress);
    document.getElementById('piContent').focus();
  };
  document.getElementById('piAdd').onclick = addItem;
  document.getElementById('piContent').addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });

  // Check／Act 自動儲存：打字停 1.5 秒自動送出；失焦（blur）立即送出。
  // 取代原本的手動「儲存」按鈕，避免切日期/切視圖時把未存內容洗掉（無聲丟字）。
  ['check', 'act'].forEach((id) => {
    const t = document.getElementById(id);
    if (!t) return;
    t.addEventListener('input', () => {
      caDirty = true;
      setSaveStatus('編輯中…', 'dirty');
      clearTimeout(caTimer);
      caTimer = setTimeout(autoSaveCheckAct, 1500);
    });
    t.addEventListener('blur', () => { autoSaveCheckAct(); });
  });

  renderPlanList();
  renderDoList();
  updateCheckProgress();
  bindTimer();
  loadCheckChart();
  maybeRenderWeekendReview();
}

// 以「最新的 plan_items 與 progress」就地更新 Plan / Do / Check 三處（不再額外 GET /logs/:id）。
// 完成度由後端回應提供（前端亦可就地算），圖表以 debounce 後 chart.update() 刷新。
function applyLogItems(plan_items, progress) {
  if (!state.currentLog) return;
  state.currentLog.plan_items = plan_items;
  if (typeof progress === 'number') state.currentLog.progress = progress;
  renderPlanList();
  renderDoList();
  updateCheckProgress();
  scheduleChartRefresh();
}

// 前端就地重算完成度（樂觀更新時用，不等後端）。
function recomputeProgress() {
  if (!state.currentLog) return;
  const items = state.currentLog.plan_items || [];
  const total = items.length;
  const done = items.filter((i) => i.is_done).length;
  state.currentLog.progress = total > 0 ? Math.round((done * 100) / total) : 0;
}

// Check 圖表刷新做 ~500ms debounce，避免連續勾選時整張圖表狂重畫。
function scheduleChartRefresh() {
  clearTimeout(chartTimer);
  chartTimer = setTimeout(loadCheckChart, 500);
}

/* ============ 本週 Act 回顧（週末面板，H）============ */
// 待辦本質提醒：此面板只是「即時關聯顯示」週一~週五的 Act，
// 並非把任何內容複製或帶入別天；不改任何資料、不新增資料表。

// 週六/週日才在 PDCA 下方顯示「本週 Act 回顧」面板；其餘日子移除既有面板。
function maybeRenderWeekendReview() {
  const dow = new Date(state.selectedDate + 'T00:00:00').getDay();
  const existing = document.querySelector('.weekend-review');
  if (dow !== 0 && dow !== 6) { if (existing) existing.remove(); return; }
  renderWeekendActReview();
}

// 抓當週週一~週五的 Act，逐列顯示；點任一列跳到該日。週末當天自身的「Act 行動」框即作為本週總結。
async function renderWeekendActReview() {
  let data;
  try { data = await api('GET', `/users/${state.user.id}/week-acts?date=${state.selectedDate}`); }
  catch (e) { return; }
  // async 回來後再次確認仍停在 PDCA 同一視圖，避免把面板掛到別的畫面。
  const view = document.querySelector('.view');
  if (!view || state.view !== 'pdca') return;
  const old = view.querySelector('.weekend-review');
  const rows = data.days.map((d) => `
    <div class="wk-act-row" data-date="${esc(d.date)}">
      <span class="wk-day">週${esc(d.weekday)}</span>
      <span class="wk-date">${esc(d.date.slice(5))}</span>
      <span class="wk-text ${d.act_content ? '' : 'empty'}">${d.act_content ? esc(d.act_content) : '（這天沒有 Act）'}</span>
    </div>`).join('');
  const panel = el(`<div class="weekend-review">
    <h3><i class="ti ti-list-check"></i> 本週 Act 回顧（週一～週五）</h3>
    <div class="wk-act-list">${rows}</div>
    <p class="wk-hint">把這些行動整理進上方「Act 行動」當作本週總結。點任一列可跳到該日。</p>
  </div>`);
  if (old) old.replaceWith(panel); else view.appendChild(panel);
  panel.querySelectorAll('.wk-act-row').forEach((r) => {
    onActivate(r, () => {
      state.selectedDate = r.dataset.date;
      state.view = 'pdca';
      const di = document.getElementById('dInput'); if (di) di.value = state.selectedDate;
      renderView();
    });
  });
}

// 【待辦本質・刻意設計】Plan 項目僅屬當日，永不跨日帶入（不把昨日 Act 變今日 Plan）。
// 跨日彙整只透過唯讀的「本週 Act 回顧」面板呈現，請勿在此加入跨日複製邏輯。
function renderPlanList() {
  const box = document.getElementById('planItems');
  if (!box) return;
  const items = state.currentLog.plan_items;
  if (items.length === 0) {
    box.innerHTML = '<div class="hint-line">尚無計畫，於下方逐項新增。</div>';
    return;
  }
  box.innerHTML = items.map((it) => `
    <div class="plan-item" data-id="${it.id}">
      <input class="pi-time" value="${esc(it.planned_time)}" placeholder="時間" />
      <input class="pi-text" value="${esc(it.content)}" />
      <button class="pi-del" title="刪除"><i class="ti ti-trash"></i></button>
    </div>`).join('');

  box.querySelectorAll('.plan-item').forEach((row) => {
    const id = row.dataset.id;
    const timeI = row.querySelector('.pi-time');
    const textI = row.querySelector('.pi-text');
    const save = async () => {
      const r = await api('PATCH', `/items/${id}`, { content: textI.value.trim() || '（未命名）', planned_time: timeI.value.trim() });
      applyLogItems(r.plan_items, r.progress);
    };
    timeI.addEventListener('change', save);
    textI.addEventListener('change', save);
    row.querySelector('.pi-del').onclick = async () => {
      const r = await api('DELETE', `/items/${id}`);
      applyLogItems(r.plan_items, r.progress);
    };
  });
}

function renderDoList() {
  const box = document.getElementById('doItems');
  if (!box) return;
  const items = state.currentLog.plan_items;
  if (items.length === 0) {
    box.innerHTML = '<div class="hint-line">請先在 Plan 新增計畫，這裡會出現可勾選的項目。</div>';
    return;
  }
  box.innerHTML = items.map((it) => `
    <label class="do-item" data-id="${it.id}">
      <input type="checkbox" ${it.is_done ? 'checked' : ''} />
      ${it.planned_time ? `<span class="do-time">${esc(it.planned_time)}</span>` : ''}
      <span class="do-text ${it.is_done ? 'done' : ''}">${esc(it.content)}</span>
    </label>`).join('');

  box.querySelectorAll('.do-item').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('input').onchange = async (e) => {
      const checked = e.target.checked;
      const it = (state.currentLog.plan_items || []).find((x) => x.id == id);
      if (!it) return;
      const prev = it.is_done;
      // 樂觀更新：先改本地狀態與 UI（完成度、刪除線、進度條、圖表），再背景送出。
      it.is_done = checked;
      recomputeProgress();
      renderDoList();
      updateCheckProgress();
      scheduleChartRefresh();
      try {
        const r = await api('PATCH', `/items/${id}`, { is_done: checked });
        applyLogItems(r.plan_items, r.progress); // 以伺服器回應校正為真相
      } catch (err) {
        it.is_done = prev;                       // 失敗回滾
        recomputeProgress();
        renderDoList();
        updateCheckProgress();
        scheduleChartRefresh();
        setSaveStatus(`更新失敗：${err.message}`, 'error');
      }
    };
  });
}

function updateCheckProgress() {
  const box = document.getElementById('checkProg');
  if (!box) return;
  const items = state.currentLog.plan_items;
  const done = items.filter((i) => i.is_done).length;
  const total = items.length;
  const p = state.currentLog.progress;
  box.innerHTML = `
    <div class="cp-top"><span>完成度</span><strong>${p}%</strong></div>
    <div class="cp-bar"><div class="cp-fill" style="width:${p}%"></div></div>
    <div class="cp-sub">已完成 ${done} / ${total} 項</div>`;
}

/* ---- Check／Act 自動儲存（取代手動按鈕）---- */
let caTimer = null;    // 停打 debounce 計時器
let caDirty = false;   // 是否有尚未送出的 Check/Act 變更
let caSaving = null;   // 進行中的儲存 Promise（供 flushCheckAct 等待）

// 更新右上角「儲存中…/已儲存 ✓」單一狀態指示
function setSaveStatus(text, cls) {
  const s = document.getElementById('saveStatus');
  if (!s) return;
  s.textContent = text;
  s.className = 'save-status' + (cls ? ' ' + cls : '');
}

// 立即送出 Check／Act（自動儲存核心）；無變更則不打 API
function autoSaveCheckAct() {
  clearTimeout(caTimer);
  caTimer = null;
  const log = state.currentLog;
  const checkEl = document.getElementById('check');
  const actEl = document.getElementById('act');
  if (!log || !checkEl || !actEl || !caDirty) return caSaving || Promise.resolve();
  caDirty = false;
  setSaveStatus('儲存中…', 'saving');
  caSaving = api('PATCH', `/logs/${log.id}`, {
    check_content: checkEl.value,
    act_content: actEl.value,
    updated_at: log.updated_at, // 樂觀鎖（任務 M）：帶上最後看到的 updated_at
  })
    .then((updated) => {
      // 以回應刷新本地狀態（含最新 updated_at），避免同裝置連續儲存自我衝突。
      state.currentLog = updated;
      setSaveStatus('已儲存 ✓', 'saved');
    })
    .catch((e) => {
      if (e.status === 409) { handleLogConflict(e); return; }
      caDirty = true; // 失敗：標回 dirty，下次輸入或 flush 時重試
      setSaveStatus(`儲存失敗：${e.message}`, 'error');
    })
    .finally(() => { caSaving = null; });
  return caSaving;
}

// 樂觀鎖衝突（409）：此日誌在他處被更新。以伺服器最新版重載，
// 但不覆蓋使用者「正在編輯」的欄位（避免吃字）；若已編輯則標回 dirty，下次以新 updated_at 重試（最後寫入者勝）。
function handleLogConflict(e) {
  const latest = e.details && e.details.current;
  if (!latest) { caDirty = true; setSaveStatus('此日誌在他處被更新，請稍候重試', 'error'); return; }
  const checkEl = document.getElementById('check');
  const actEl = document.getElementById('act');
  const ae = document.activeElement;
  let keptEdit = false;
  if (checkEl) {
    if (ae !== checkEl) checkEl.value = latest.check_content || '';
    else if (checkEl.value !== (latest.check_content || '')) keptEdit = true;
  }
  if (actEl) {
    if (ae !== actEl) actEl.value = latest.act_content || '';
    else if (actEl.value !== (latest.act_content || '')) keptEdit = true;
  }
  state.currentLog = latest; // 採用最新 updated_at
  renderPlanList();
  renderDoList();
  updateCheckProgress();
  scheduleChartRefresh();
  if (keptEdit) caDirty = true;
  setSaveStatus('此日誌在他處被更新，已重新載入', 'error');
}

// 切日期/切視圖前呼叫：把待存內容立即 flush 並等待完成，確保不丟字。
async function flushCheckAct() {
  if (caTimer) { clearTimeout(caTimer); caTimer = null; caDirty = true; }
  if (caDirty) autoSaveCheckAct();
  if (caSaving) { try { await caSaving; } catch (e) { /* 已於 autoSaveCheckAct 處理 */ } }
}

async function loadCheckChart() {
  const to = state.selectedDate;
  const fromD = new Date(to + 'T00:00:00');
  fromD.setDate(fromD.getDate() - 6);
  const from = `${fromD.getFullYear()}-${pad(fromD.getMonth() + 1)}-${pad(fromD.getDate())}`;
  let stats;
  try {
    stats = await api('GET', `/users/${state.user.id}/stats?from=${from}&to=${to}`);
  } catch (e) { return; }

  const map = {};
  stats.daily.forEach((d) => { map[d.date] = d.progress; });
  const labels = [], values = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(to + 'T00:00:00');
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    labels.push(i === 0 ? '今日' : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`);
    values.push(map[key] || 0);
  }

  const statRow = document.getElementById('statRow');
  if (statRow) {
    statRow.innerHTML = `
      <div class="stat-card"><div class="label">今日完成度</div><div class="value" style="color:var(--check-strong)">${state.currentLog.progress}%</div></div>
      <div class="stat-card"><div class="label">連續達成</div><div class="value">${stats.streak} 天</div></div>
      <div class="stat-card"><div class="label">7 日平均</div><div class="value">${stats.avg_progress}%</div></div>`;
  }

  const ctx = document.getElementById('checkChart');
  if (!ctx || typeof Chart === 'undefined') return;
  const bg = values.map((_, i) => (i === 6 ? '#ef9f27' : '#fac775'));
  const cc = chartColors();
  if (chart && chart.canvas === ctx) {
    // 圖表仍掛在同一個 canvas：就地更新資料並 chart.update()，不 destroy 重建（避免閃爍）。
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.data.datasets[0].backgroundColor = bg;
    applyChartTheme(chart);
    chart.update();
    return;
  }
  // 版面剛整個重建（canvas 是新的）或尚未建立：銷毀舊圖表並建立新的。
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bg, borderRadius: 4 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y + '%' } } },
      scales: {
        y: { beginAtZero: true, max: 100, ticks: { stepSize: 50, callback: (v) => v + '%', color: cc.tick }, grid: { color: cc.grid } },
        x: { ticks: { color: cc.tick }, grid: { display: false } },
      },
      maintainAspectRatio: false,
    },
  });
}
// 圖表色彩隨深/淺主題（Chart.js 無法直接讀 CSS 變數，這裡依 data-theme 給值）
function chartColors() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return { grid: dark ? 'rgba(255,255,255,0.08)' : '#eef0f3', tick: dark ? '#a3abb8' : '#6b7280' };
}
function applyChartTheme(c) {
  if (!c || !c.options || !c.options.scales) return;
  const cc = chartColors();
  if (c.options.scales.y) { c.options.scales.y.grid.color = cc.grid; c.options.scales.y.ticks.color = cc.tick; }
  if (c.options.scales.x && c.options.scales.x.ticks) { c.options.scales.x.ticks.color = cc.tick; }
}

/* ============ 倒數計時器（純前端）============ */
function timerBarHTML() {
  return `<div class="timer-bar" id="timerBar">
    <i class="ti ti-hourglass" style="color:var(--text-muted)"></i>
    <span class="timer-display" id="timerDisplay">00:25:00</span>
    <span style="font-size:13px;color:var(--text-muted)">設定</span>
    <input id="tH" type="number" min="0" max="23" value="0" /> 時
    <input id="tM" type="number" min="0" max="59" value="25" /> 分
    <input id="tS" type="number" min="0" max="59" value="0" /> 秒
    <div class="timer-btns">
      <button id="tStart" title="開始"><i class="ti ti-player-play"></i></button>
      <button id="tPause" title="暫停"><i class="ti ti-player-pause"></i></button>
      <button id="tReset" title="重置"><i class="ti ti-refresh"></i></button>
    </div>
  </div>`;
}
// 清掉計時器的 interval（保留 timerState，供重繪後還原）。
function clearTimerInterval() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}
// 目前剩餘秒數：運行中以「結束時間戳」推算，確保切視圖/分頁回來後仍準確（不會因切換而停滯或卡死）。
function timerRemaining() {
  if (timerState.running) return Math.max(0, Math.round((timerState.endsAt - Date.now()) / 1000));
  return timerState.remaining;
}

function bindTimer() {
  const disp = document.getElementById('timerDisplay');
  const bar = document.getElementById('timerBar');
  if (!disp || !bar) return;
  function setFromInputs() {
    const h = +document.getElementById('tH').value || 0;
    const m = +document.getElementById('tM').value || 0;
    const s = +document.getElementById('tS').value || 0;
    return h * 3600 + m * 60 + s;
  }
  function show(total) {
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    disp.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  // 依 interval tick 更新顯示；歸零則停止並提示。剩餘秒數一律由 timerRemaining() 計算。
  function startInterval() {
    clearTimerInterval();
    timerInterval = setInterval(() => {
      const rem = timerRemaining();
      show(rem);
      if (rem <= 0) {
        clearTimerInterval();
        timerState.running = false;
        timerState.remaining = 0;
        bar.classList.remove('running'); // 停止呼吸效果
        bar.classList.add('alarm');
        beep();
      }
    }, 250);
  }

  // 還原顯示與運行狀態（切視圖回到 PDCA 時）。
  show(timerRemaining());
  if (timerState.running) { bar.classList.remove('alarm'); bar.classList.add('running'); startInterval(); }

  ['tH', 'tM', 'tS'].forEach((id) => {
    document.getElementById(id).onchange = () => {
      // 僅在「未運行」時才以輸入框數值重設待數秒數。
      if (!timerState.running) { timerState.remaining = setFromInputs(); timerState.total = timerState.remaining; show(timerState.remaining); }
    };
  });
  document.getElementById('tStart').onclick = () => {
    if (timerState.running) return;
    let rem = timerRemaining();
    if (rem <= 0) rem = setFromInputs();
    if (rem <= 0) return;
    timerState.running = true;
    timerState.endsAt = Date.now() + rem * 1000;
    bar.classList.remove('alarm');
    bar.classList.add('running'); // 啟動「會呼吸的計時器」效果
    startInterval();
  };
  document.getElementById('tPause').onclick = () => {
    if (!timerState.running) return;
    timerState.remaining = timerRemaining();
    timerState.running = false;
    clearTimerInterval();
    bar.classList.remove('running');
    show(timerState.remaining);
  };
  document.getElementById('tReset').onclick = () => {
    timerState.running = false;
    clearTimerInterval();
    bar.classList.remove('alarm');
    bar.classList.remove('running');
    timerState.remaining = setFromInputs();
    timerState.total = timerState.remaining;
    show(timerState.remaining);
  };
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; o.start();
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.stop(ctx.currentTime + 0.6);
  } catch (e) { /* 忽略 */ }
}

/* ============ 全螢幕專注時鐘 ============ */
function openFocusClock() {
  const overlay = el(`<div class="focus-clock">
    <div class="time" id="fcTime">00:00:00</div>
    <div class="date" id="fcDate"></div>
    <div class="hint"><i class="ti ti-hand-finger"></i> 點畫面任一處退出</div>
  </div>`);
  document.body.appendChild(overlay);
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  function tick() {
    const n = new Date();
    overlay.querySelector('#fcTime').textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    overlay.querySelector('#fcDate').textContent =
      `${n.getFullYear()} 年 ${n.getMonth() + 1} 月 ${n.getDate()} 日 星期${week[n.getDay()]}`;
  }
  tick();
  const iv = setInterval(tick, 1000);
  overlay.onclick = () => { clearInterval(iv); overlay.remove(); };
}

/* ============ 行事曆視圖 ============ */
async function renderCalendar(main, opts = {}) {
  if (!opts.quiet) main.innerHTML = skeletonCalendar();
  let data;
  try {
    data = await api('GET', `/users/${state.user.id}/calendar?month=${state.calMonth}`);
  } catch (e) {
    main.innerHTML = `<div class="view"><div class="empty-state">${esc(e.message)}</div></div>`;
    return;
  }
  const [y, m] = state.calMonth.split('-').map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay();

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';
  data.days.forEach((day) => {
    const dnum = Number(day.date.slice(-2));
    const isToday = day.date === todayStr();
    let bg = 'var(--surface)', tc = 'var(--text)';
    if (day.progress >= 70) { bg = '#5dcaa5'; tc = '#04342c'; }
    else if (day.progress > 0) { bg = '#fac775'; tc = '#854f0b'; }
    const marks = [];
    if (day.has_diary) marks.push('<i class="ti ti-book" style="color:#185fa5"></i>');
    day.important_dates.forEach((im) => marks.push(`<span style="color:#a32d2d;font-size:9px"><i class="ti ti-flag"></i>${esc(im.title)}</span>`));
    cells += `<div class="cal-cell${isToday ? ' today' : ''}" data-date="${day.date}" style="background:${bg}">
      <span class="d" style="color:${tc}">${dnum}</span>
      ${day.progress > 0 ? `<span class="pct" style="color:${tc}">${day.progress}%</span>` : ''}
      <span class="marks">${marks.join('')}</span>
    </div>`;
  });

  main.innerHTML = `
    <div class="view">
      <div class="cal-head">
        <button id="cPrev"><i class="ti ti-chevron-left"></i></button>
        <span class="month">${y} 年 ${m} 月</span>
        <button id="cNext"><i class="ti ti-chevron-right"></i></button>
      </div>
      <div class="cal-dow"><div>日</div><div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div></div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">
        <span><span class="dot" style="background:#5dcaa5"></span>高完成度</span>
        <span><span class="dot" style="background:#fac775"></span>中完成度</span>
        <span><span class="dot" style="background:var(--bg);border:1px solid var(--border)"></span>無紀錄</span>
        <span><i class="ti ti-book" style="color:#185fa5"></i>有日記</span>
        <span><i class="ti ti-flag" style="color:#a32d2d"></i>重要日期</span>
      </div>
    </div>`;

  document.getElementById('cPrev').onclick = () => { state.calMonth = shiftMonth(state.calMonth, -1); renderView(); };
  document.getElementById('cNext').onclick = () => { state.calMonth = shiftMonth(state.calMonth, 1); renderView(); };
  main.querySelectorAll('.cal-cell[data-date]').forEach((c) => {
    c.setAttribute('aria-label', `${c.dataset.date}，前往該日 PDCA`);
    onActivate(c, () => {
      state.selectedDate = c.dataset.date;
      state.view = 'pdca';
      const di = document.getElementById('dInput'); if (di) di.value = state.selectedDate;
      renderView();
    });
  });
}
function shiftMonth(month, delta) {
  let [y, m] = month.split('-').map(Number);
  m += delta;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  return `${y}-${pad(m)}`;
}

/* ============ 日記視圖（每日可多篇）============ */
async function renderDiary(main, opts = {}) {
  if (!opts.quiet) main.innerHTML = skeletonCards();
  let list;
  try {
    list = await api('GET', `/users/${state.user.id}/diaries?date=${state.selectedDate}`);
  } catch (e) {
    main.innerHTML = `<div class="view"><div class="empty-state">${esc(e.message)}</div></div>`;
    return;
  }
  const cards = list.map((d) => `
    <div class="diary-card">
      <div class="meta">
        <span class="title">${esc(d.title) || '（無標題）'}</span>
        <div class="card-actions">
          <button data-edit="${d.id}"><i class="ti ti-edit"></i></button>
          <button data-del="${d.id}"><i class="ti ti-trash"></i></button>
        </div>
      </div>
      ${d.mood ? `<div class="mood-tag">心情：${esc(d.mood)}</div>` : ''}
      <div class="content">${esc(d.content)}</div>
    </div>`).join('') || '<div class="empty-state">這天還沒有日記，點右上角新增一篇吧。</div>';

  main.innerHTML = `
    <div class="view">
      <div class="diary-head">
        <h2 class="view-title" style="margin:0">日記</h2>
        <input type="date" id="diaryDate" value="${state.selectedDate}" aria-label="選擇日記日期" />
        <div class="spacer" style="flex:1"></div>
        <button class="btn-save" id="addDiary"><i class="ti ti-plus"></i> 新增一篇</button>
      </div>
      <div class="diary-list">${cards}</div>
    </div>`;

  document.getElementById('diaryDate').onchange = (e) => {
    state.selectedDate = e.target.value;
    const di = document.getElementById('dInput'); if (di) di.value = state.selectedDate;
    renderView();
  };
  document.getElementById('addDiary').onclick = () => openDiaryModal();
  main.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openDiaryModal(list.find((x) => x.id == b.dataset.edit));
  });
  main.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => { await api('DELETE', `/diaries/${b.dataset.del}`); renderView(); };
  });
}

function openDiaryModal(diary) {
  const isEdit = !!diary;
  const modal = el(`<div class="modal-mask"><div class="modal">
    <h3>${isEdit ? '編輯日記' : '新增日記'}・${state.selectedDate}</h3>
    <input id="dy-title" placeholder="標題" value="${isEdit ? esc(diary.title) : ''}" aria-label="日記標題" />
    <input id="dy-mood" placeholder="心情（如 開心 / 疲憊）" value="${isEdit ? esc(diary.mood) : ''}" aria-label="心情" />
    <textarea id="dy-content" placeholder="今天的紀錄…" aria-label="日記內文">${isEdit ? esc(diary.content) : ''}</textarea>
    <div class="modal-btns">
      <button class="btn-ghost" id="dy-cancel">取消</button>
      <button class="btn-save" id="dy-save">儲存</button>
    </div></div></div>`);
  document.body.appendChild(modal);
  modal.querySelector('#dy-cancel').onclick = () => modal.remove();
  modal.querySelector('#dy-save').onclick = async () => {
    const payload = {
      title: modal.querySelector('#dy-title').value.trim(),
      content: modal.querySelector('#dy-content').value,
      mood: modal.querySelector('#dy-mood').value.trim(),
    };
    if (isEdit) await api('PATCH', `/diaries/${diary.id}`, payload);
    else await api('POST', `/users/${state.user.id}/diaries`, { entry_date: state.selectedDate, ...payload });
    modal.remove(); renderView();
  };
}

/* ============ 備忘錄視圖 ============ */
const MEMO_COLORS = ['#ffd54f', '#90caf9', '#a5d6a7', '#f48fb1', '#ce93d8', '#ffab91'];
const MEMO_PAGE = 24;            // 每頁備忘錄數
let memoById = {};              // 已載入備忘錄的 id→物件（供分頁追加後仍能編輯/置頂）
function memoCardHTML(mo) {
  return `<div class="memo-card" style="border-top-color:${esc(mo.color || '#ffd54f')}">
      <div class="meta">
        <span class="title">${esc(mo.title) || '（無標題）'}</span>
        <div class="card-actions">
          <button data-pin="${mo.id}" class="${mo.is_pinned ? 'pin-on' : ''}" title="置頂" aria-label="置頂或取消置頂"><i class="ti ti-pin"></i></button>
          <button data-edit="${mo.id}" aria-label="編輯備忘錄"><i class="ti ti-edit"></i></button>
          <button data-del="${mo.id}" aria-label="刪除備忘錄"><i class="ti ti-trash"></i></button>
        </div>
      </div>
      <div class="content">${esc(mo.content)}</div>
    </div>`;
}
function bindMemoCards(scope) {
  scope.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openMemoModal(memoById[b.dataset.edit]); });
  scope.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => { try { await api('DELETE', `/memos/${b.dataset.del}`); renderView(); } catch (e) { toast(e.message, 'error'); } };
  });
  scope.querySelectorAll('[data-pin]').forEach((b) => {
    b.onclick = async () => {
      const mo = memoById[b.dataset.pin];
      try { await api('PATCH', `/memos/${mo.id}`, { is_pinned: !mo.is_pinned }); renderView(); } catch (e) { toast(e.message, 'error'); }
    };
  });
}
async function renderMemos(main, opts = {}) {
  if (!opts.quiet) main.innerHTML = skeletonCards();
  let data;
  try {
    data = await api('GET', `/users/${state.user.id}/memos?limit=${MEMO_PAGE}&offset=0`);
  } catch (e) {
    main.innerHTML = `<div class="view"><div class="empty-state">${esc(e.message)}</div></div>`;
    return;
  }
  memoById = {};
  data.items.forEach((mo) => { memoById[mo.id] = mo; });
  const cards = data.items.map(memoCardHTML).join('') || '<div class="empty-state">還沒有備忘錄，點右上角新增。</div>';

  main.innerHTML = `
    <div class="view">
      <div class="diary-head">
        <h2 class="view-title" style="margin:0">備忘錄</h2>
        <div class="spacer" style="flex:1"></div>
        <button class="btn-save" id="addMemo"><i class="ti ti-plus"></i> 新增</button>
      </div>
      <div class="memo-grid" id="memoGrid">${cards}</div>
      ${data.has_more ? '<div class="load-more-wrap"><button class="btn-ghost" id="memoMore">載入更多</button></div>' : ''}
    </div>`;

  document.getElementById('addMemo').onclick = () => openMemoModal();
  bindMemoCards(main);

  if (data.has_more) {
    let offset = MEMO_PAGE;
    document.getElementById('memoMore').onclick = (e) => {
      const btn = e.currentTarget;
      withBusy(btn, async () => {
        const next = await api('GET', `/users/${state.user.id}/memos?limit=${MEMO_PAGE}&offset=${offset}`);
        const grid = document.getElementById('memoGrid');
        next.items.forEach((mo) => { memoById[mo.id] = mo; grid.insertAdjacentHTML('beforeend', memoCardHTML(mo)); });
        offset += MEMO_PAGE;
        bindMemoCards(grid);
        if (!next.has_more) { const w = btn.closest('.load-more-wrap'); if (w) w.remove(); }
      });
    };
  }
}

function openMemoModal(memo) {
  const isEdit = !!memo;
  let color = isEdit ? (memo.color || MEMO_COLORS[0]) : MEMO_COLORS[0];
  const swatches = MEMO_COLORS.map((c) =>
    `<span class="sw${c === color ? ' sel' : ''}" data-c="${c}" style="background:${c}"></span>`).join('');
  const modal = el(`<div class="modal-mask"><div class="modal">
    <h3>${isEdit ? '編輯備忘錄' : '新增備忘錄'}</h3>
    <input id="mo-title" placeholder="標題" value="${isEdit ? esc(memo.title) : ''}" aria-label="備忘錄標題" />
    <textarea id="mo-content" placeholder="內容…" aria-label="備忘錄內容">${isEdit ? esc(memo.content) : ''}</textarea>
    <div class="color-row">${swatches}</div>
    <div class="modal-btns">
      <button class="btn-ghost" id="mo-cancel">取消</button>
      <button class="btn-save" id="mo-save">儲存</button>
    </div></div></div>`);
  document.body.appendChild(modal);
  modal.querySelectorAll('.sw').forEach((s) => {
    s.onclick = () => {
      color = s.dataset.c;
      modal.querySelectorAll('.sw').forEach((x) => x.classList.remove('sel'));
      s.classList.add('sel');
    };
  });
  modal.querySelector('#mo-cancel').onclick = () => modal.remove();
  modal.querySelector('#mo-save').onclick = async () => {
    const payload = {
      title: modal.querySelector('#mo-title').value.trim(),
      content: modal.querySelector('#mo-content').value,
      color,
    };
    if (isEdit) await api('PATCH', `/memos/${memo.id}`, payload);
    else await api('POST', `/users/${state.user.id}/memos`, payload);
    modal.remove(); renderView();
  };
}

/* ============ 讀書會視圖（Batch S2：群組管理 + 讀書計時器）============ */
function clearStudyTick() { if (studyTickInterval) { clearInterval(studyTickInterval); studyTickInterval = null; } }

// 秒數 → HH:MM:SS（碼錶顯示）
function fmtClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
// 秒數 → 人類可讀（今日已讀）
function fmtMinutes(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小時 ${m} 分`;
  if (m > 0) return `${m} 分`;
  return `${sec} 秒`;
}

function clearStudyBoard() { if (studyBoardInterval) { clearInterval(studyBoardInterval); studyBoardInterval = null; } }

async function renderStudyGroups(main, opts = {}) {
  if (!opts.quiet) main.innerHTML = skeletonCards(3);
  clearStudyBoard();
  let groups, me, todayLog;
  try {
    [groups, me, todayLog] = await Promise.all([
      api('GET', '/groups'),
      api('GET', `/study/me?date=${todayStr()}`),
      api('GET', `/logs/by-date?date=${todayStr()}`),
    ]);
  } catch (e) {
    main.innerHTML = `<div class="view"><div class="empty-state">${esc(e.message)}</div></div>`;
    return;
  }
  studyActive = me.active;
  studyFinishedSeconds = me.finished_seconds || 0;

  // 科目下拉選項：帶入當天計畫項目（Do 內容）；可自填也可點選
  const subjects = (todayLog && todayLog.plan_items ? todayLog.plan_items : []).map((it) => it.content).filter(Boolean);
  const options = subjects.map((s) => `<option value="${esc(s)}"></option>`).join('');

  // 維持已選群組；失效或未選則預設第一個
  if (!groups.some((g) => g.id === studySelectedGroupId)) studySelectedGroupId = groups.length ? groups[0].id : null;
  const chips = groups
    .map((g) => `<button class="grp-chip${g.id === studySelectedGroupId ? ' active' : ''}" data-chip="${g.id}">
      <span class="grp-chip-dot" style="background:${esc(g.color || '#378add')}"></span>${esc(g.name)}
      <span class="grp-chip-n">${g.member_count}</span></button>`)
    .join('');

  main.innerHTML = `
    <div class="view">
      <h2 class="view-title">讀書會</h2>
      <div class="study-timer" id="studyTimer">
        <div class="st-left">
          <div class="st-display" id="stDisplay">00:00:00</div>
          <div class="st-today">今日已讀 <b id="stToday">0 分</b></div>
        </div>
        <div class="st-right">
          <input id="stSubject" class="st-subject" list="stSubjectList" placeholder="科目（可自填或選計畫）" maxlength="40" autocomplete="off" aria-label="讀書科目" />
          <datalist id="stSubjectList">${options}</datalist>
          <button class="st-toggle" id="stToggle"></button>
        </div>
      </div>
      <div class="grp-head">
        <h3>我的讀書會</h3>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="grpJoin"><i class="ti ti-login-2"></i> 加入</button>
        <button class="btn-save" id="grpCreate"><i class="ti ti-plus"></i> 建立群組</button>
      </div>
      ${groups.length
        ? `<div class="grp-chips">${chips}</div><div class="board-wrap" id="boardWrap"></div>`
        : '<div class="empty-state">還沒有讀書會。建立一個，或用朋友的邀請碼加入。</div>'}
    </div>`;

  document.getElementById('grpCreate').onclick = () => openGroupModal();
  document.getElementById('grpJoin').onclick = openJoinGroupModal;
  document.querySelectorAll('[data-chip]').forEach((b) => {
    b.onclick = () => { studySelectedGroupId = Number(b.dataset.chip); renderStudyGroups(document.getElementById('main')); };
  });
  bindStudyTimer();
  if (studySelectedGroupId) { renderGroupBoard(); startBoardPoll(); }
}

// 選取群組的看板殼（標題 + 操作 + 分頁）；列表由 refreshBoardList 填入並輪詢更新。
async function renderGroupBoard() {
  const wrap = document.getElementById('boardWrap');
  if (!wrap || !studySelectedGroupId) return;
  let g;
  try { g = await api('GET', `/groups/${studySelectedGroupId}`); }
  catch (e) { wrap.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const isOwner = g.role === 'owner';
  wrap.innerHTML = `
    <div class="board-head">
      <div class="board-title">
        <span class="grp-name">${esc(g.name)}</span>
        <span class="grp-role ${isOwner ? 'owner' : ''}">${isOwner ? '擁有者' : '成員'}</span>
      </div>
      <div class="board-sub">${g.member_count} 位成員　・　邀請碼 <code>${esc(g.invite_code)}</code></div>
      <div class="board-acts">
        <button data-copy="${esc(g.invite_code)}"><i class="ti ti-copy"></i> 複製邀請碼</button>
        <button data-members="${g.id}"><i class="ti ti-users"></i> 成員</button>
        ${isOwner
          ? `<button data-edit="${g.id}"><i class="ti ti-edit"></i> 編輯</button><button class="danger" data-delete="${g.id}"><i class="ti ti-trash"></i> 解散</button>`
          : `<button class="danger" data-leave="${g.id}"><i class="ti ti-logout"></i> 離開</button>`}
      </div>
      <div class="board-tabs">
        <button class="board-tab${studyBoardTab === 'today' ? ' active' : ''}" data-tab="today"><i class="ti ti-broadcast"></i> 今日看板</button>
        <button class="board-tab${studyBoardTab === 'week' ? ' active' : ''}" data-tab="week"><i class="ti ti-trophy"></i> 本週排行</button>
      </div>
    </div>
    <div class="board-list" id="boardList">${skeletonBoardRows()}</div>`;
  bindBoardHeader(g);
  wrap.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { studyBoardTab = b.dataset.tab; renderGroupBoard(); }; });
  refreshBoardList();
}

function bindBoardHeader(g) {
  const wrap = document.getElementById('boardWrap');
  if (!wrap) return;
  wrap.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b); });
  wrap.querySelectorAll('[data-members]').forEach((b) => { b.onclick = () => openGroupMembersModal(Number(b.dataset.members)); });
  wrap.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openGroupModal(g); });
  wrap.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmDialog('確定解散此群組？此動作無法復原。', { confirmText: '解散', danger: true }))) return;
      try { await api('DELETE', `/groups/${g.id}`); studySelectedGroupId = null; renderView(); } catch (e) { toast(e.message, 'error'); }
    };
  });
  wrap.querySelectorAll('[data-leave]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmDialog('確定離開此群組？', { confirmText: '離開', danger: true }))) return;
      try { await api('DELETE', `/groups/${g.id}/leave`); studySelectedGroupId = null; renderView(); } catch (e) { toast(e.message, 'error'); }
    };
  });
}

// 只刷新看板列表（供輪詢用，不動標題/分頁，避免閃爍）
async function refreshBoardList() {
  const list = document.getElementById('boardList');
  if (!list || !studySelectedGroupId) return;
  try {
    if (studyBoardTab === 'today') {
      const board = await api('GET', `/groups/${studySelectedGroupId}/board?date=${todayStr()}`);
      list.innerHTML = board.members.length
        ? board.members.map(boardRowHTML).join('')
        : '<div class="empty-state">今天還沒有人讀書，當第一個吧！</div>';
    } else {
      const lb = await api('GET', `/groups/${studySelectedGroupId}/leaderboard?period=week&date=${todayStr()}`);
      list.innerHTML = lb.members.map(lbRowHTML).join('');
    }
  } catch (e) { /* 輪詢失敗靜默，不打擾使用者 */ }
}

function boardRowHTML(m, i) {
  const studying = m.status === 'studying';
  return `<div class="board-row${studying ? ' studying' : ''}">
    <span class="board-rank">${i + 1}</span>
    <span class="board-dot ${studying ? 'on' : ''}"></span>
    <span class="acct-av">${esc((m.display_name || '?').slice(0, 1))}</span>
    <span class="board-name">${esc(m.display_name || '（未命名）')}${studying && m.current_subject ? ` <small>· ${esc(m.current_subject)}</small>` : ''}</span>
    <span class="board-time"><b>${esc(fmtMinutes(m.today_seconds))}</b>${studying ? `<small class="board-live">讀書中 ${esc(fmtClock(m.live_seconds))}</small>` : ''}</span>
  </div>`;
}
function lbRowHTML(m, i) {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
  return `<div class="board-row">
    <span class="board-rank">${medal}</span>
    <span class="acct-av">${esc((m.display_name || '?').slice(0, 1))}</span>
    <span class="board-name">${esc(m.display_name || '（未命名）')}</span>
    <span class="board-time"><b>${esc(fmtMinutes(m.seconds))}</b></span>
  </div>`;
}

// 看板輪詢（~15 秒）：只更新列表；分頁隱藏、非讀書會視圖、或有對話框時跳過。
function startBoardPoll() {
  clearStudyBoard();
  studyBoardInterval = setInterval(() => {
    if (document.hidden || state.view !== 'study' || !studySelectedGroupId) return;
    if (document.querySelector('.modal-mask')) return;
    refreshBoardList();
  }, 15000);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.innerHTML;
    btn.innerHTML = '<i class="ti ti-check"></i> 已複製';
    setTimeout(() => { btn.innerHTML = old; }, 1500);
  } catch (e) { /* 忽略（部分環境不支援 clipboard） */ }
}

/* ---- 讀書計時器（碼錶；開始/結束）---- */
function bindStudyTimer() {
  const display = document.getElementById('stDisplay');
  const todayEl = document.getElementById('stToday');
  const toggle = document.getElementById('stToggle');
  const subject = document.getElementById('stSubject');
  const wrap = document.getElementById('studyTimer');
  if (!display || !toggle) return;
  clearStudyTick();

  function paint() {
    const elapsed = studyActive ? Math.max(0, Math.floor((Date.now() - Date.parse(studyActive.started_at)) / 1000)) : 0;
    display.textContent = fmtClock(elapsed);
    todayEl.textContent = fmtMinutes(studyFinishedSeconds + elapsed);
    if (wrap) wrap.classList.toggle('running', !!studyActive);
  }

  if (studyActive) {
    if (studyActive.subject) subject.value = studyActive.subject;
    subject.disabled = true;
    toggle.innerHTML = '<i class="ti ti-player-stop"></i> 結束';
    toggle.classList.add('stop');
    studyTickInterval = setInterval(paint, 1000);
  } else {
    subject.disabled = false;
    toggle.innerHTML = '<i class="ti ti-player-play"></i> 開始讀書';
    toggle.classList.remove('stop');
  }
  paint();
  toggle.onclick = studyActive ? stopStudy : startStudy;
}

async function startStudy() {
  const subject = (document.getElementById('stSubject').value || '').trim();
  const btn = document.getElementById('stToggle');
  try {
    await withBusy(btn, async () => {
      studyActive = await api('POST', '/study/sessions/start', { subject, date: todayStr() });
      bindStudyTimer();
    });
  } catch (e) { toast(e.message, 'error'); }
}
async function stopStudy() {
  if (!studyActive) return;
  const btn = document.getElementById('stToggle');
  try {
    await withBusy(btn, async () => {
      const done = await api('POST', `/study/sessions/${studyActive.id}/stop`);
      studyFinishedSeconds += (done.duration_seconds || 0);
      studyActive = null;
      bindStudyTimer();
    });
  } catch (e) { toast(e.message, 'error'); }
}

/* ---- 群組對話框 ---- */
const GROUP_COLORS = ['#378add', '#1d9e75', '#d85a30', '#a23bbd', '#e24b4a', '#854f0b'];
function openGroupModal(group) {
  const isEdit = !!(group && group.id);
  let color = isEdit ? (group.color || GROUP_COLORS[0]) : GROUP_COLORS[0];
  const swatches = GROUP_COLORS.map((c) => `<span class="sw${c === color ? ' sel' : ''}" data-c="${c}" style="background:${c}"></span>`).join('');
  const modal = el(`<div class="modal-mask"><div class="modal">
    <h3>${isEdit ? '編輯群組' : '建立讀書會'}</h3>
    <input id="g-name" placeholder="群組名稱" value="${isEdit ? esc(group.name) : ''}" maxlength="40" aria-label="群組名稱" />
    <input id="g-desc" placeholder="描述（可留空）" value="${isEdit ? esc(group.description) : ''}" maxlength="120" aria-label="群組描述" />
    <div class="color-row">${swatches}</div>
    <div class="err-msg" id="g-err"></div>
    <div class="modal-btns">
      <button class="btn-ghost" id="g-cancel">取消</button>
      <button class="btn-save" id="g-save">${isEdit ? '儲存' : '建立'}</button>
    </div></div></div>`);
  document.body.appendChild(modal);
  modal.querySelectorAll('.sw').forEach((s) => {
    s.onclick = () => { color = s.dataset.c; modal.querySelectorAll('.sw').forEach((x) => x.classList.remove('sel')); s.classList.add('sel'); };
  });
  modal.querySelector('#g-cancel').onclick = () => modal.remove();
  const gSave = modal.querySelector('#g-save');
  gSave.onclick = async () => {
    const name = modal.querySelector('#g-name').value.trim();
    const description = modal.querySelector('#g-desc').value.trim();
    if (!name) { modal.querySelector('#g-err').textContent = '請輸入群組名稱'; return; }
    try {
      await withBusy(gSave, async () => {
        if (isEdit) await api('PATCH', `/groups/${group.id}`, { name, description, color });
        else await api('POST', '/groups', { name, description, color });
        modal.remove(); renderView();
      });
    } catch (e) { modal.querySelector('#g-err').textContent = e.message; }
  };
}

function openJoinGroupModal() {
  const modal = el(`<div class="modal-mask"><div class="modal">
    <h3>加入讀書會</h3>
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">輸入朋友給你的邀請碼。</p>
    <input id="j-code" placeholder="邀請碼（如 4MB4Z3）" style="text-transform:uppercase;letter-spacing:2px" maxlength="8" aria-label="邀請碼" />
    <div class="err-msg" id="j-err"></div>
    <div class="modal-btns">
      <button class="btn-ghost" id="j-cancel">取消</button>
      <button class="btn-save" id="j-join">加入</button>
    </div></div></div>`);
  document.body.appendChild(modal);
  modal.querySelector('#j-cancel').onclick = () => modal.remove();
  const jBtn = modal.querySelector('#j-join');
  jBtn.onclick = async () => {
    const invite_code = modal.querySelector('#j-code').value.trim();
    if (!invite_code) return;
    try { await withBusy(jBtn, async () => { await api('POST', '/groups/join', { invite_code }); modal.remove(); renderView(); }); }
    catch (e) { modal.querySelector('#j-err').textContent = e.message; }
  };
}

async function openGroupMembersModal(groupId) {
  let g;
  try { g = await api('GET', `/groups/${groupId}`); } catch (e) { toast(e.message, 'error'); return; }
  const isOwner = g.role === 'owner';
  const rows = g.members.map((m) => `
    <div class="mem-row">
      <span class="acct-av">${esc((m.display_name || '?').slice(0, 1))}</span>
      <span class="mem-name">${esc(m.display_name || '（未命名）')}${m.role === 'owner' ? ' <span class="grp-role owner">擁有者</span>' : ''}</span>
      ${isOwner && m.role !== 'owner' ? `<button class="mem-kick" data-kick="${m.user_id}" title="移出群組"><i class="ti ti-user-minus"></i></button>` : ''}
    </div>`).join('');
  const modal = el(`<div class="modal-mask"><div class="modal">
    <h3>${esc(g.name)}・成員（${g.member_count}）</h3>
    <div class="mem-list">${rows}</div>
    <div class="modal-btns"><button class="btn-ghost" id="m-close">關閉</button></div>
  </div></div>`);
  document.body.appendChild(modal);
  modal.querySelector('#m-close').onclick = () => modal.remove();
  modal.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmDialog('將此成員移出群組？', { confirmText: '移除', danger: true }))) return;
      try { await api('DELETE', `/groups/${groupId}/members/${b.dataset.kick}`); modal.remove(); openGroupMembersModal(groupId); }
      catch (e) { toast(e.message, 'error'); }
    };
  });
}

/* ============ 啟動 ============ */
applyTheme(); // 依偏好套用深/淺色（<head> 內聯腳本已先設好，這裡再確保一致）
// 偏好為「系統」時，跟隨作業系統深淺色即時切換
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemePref() === 'system') applyTheme();
  });
}
boot();
startSync(); // 註冊跨裝置同步（聚焦/切回分頁/每 20 秒安靜重抓）；未登入時自動失效
registerCmdk(); // 註冊 ⌘K / Ctrl+K 命令面板快捷鍵（未登入時自動失效）
setupOverlayA11y(); // 浮層（modal/命令面板）焦點鎖、Esc 關閉、焦點還原（D4）

// 註冊 Service Worker（PWA：可安裝到手機 + App 殼離線開啟）；失敗不影響功能。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
