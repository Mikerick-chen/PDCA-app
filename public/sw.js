// PDCA Time Master — Service Worker（PWA：可安裝 + App 殼離線開啟）
// 注意：每次更新前端資源（變更 index.html 的 ?v=N）時，請一併把 SHELL_VERSION 加 1，
//       裝置才會重新預快取新版本（並自動清掉舊快取）。
const SHELL_VERSION = 'pdca-shell-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css?v=13',
  '/js/app.js?v=14',
  '/vendor/tabler/tabler-icons.min.css?v=3',
  '/vendor/tabler/fonts/tabler-icons.woff2?v3.5.0',
  '/vendor/chart/chart.umd.min.js?v=1',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_VERSION).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                  // 只處理 GET
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域交給瀏覽器
  if (url.pathname.startsWith('/api/')) return;      // API 一律走網路（不快取使用者資料/憑證）

  // 導覽請求（開 App / 換頁）：先試網路，離線時退回 App 殼
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  // 其餘同源靜態資源：cache-first，順便把成功回應寫入快取
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(SHELL_VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
