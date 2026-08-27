// Vocifly Service Worker：让手机端可以“添加到主屏幕”并以独立窗口全屏运行（PWA）。
// 仅在 HTTPS（或 localhost）下可用；HTTP 开发模式会跳过注册。
// 策略：静态资源 network-first（在线优先、离线回退缓存）。开发期改动能即时下发，
//       避免“服务器已改、手机仍是旧样式”的缓存不同步；离线时仍可回退到缓存壳。
// 每次发布大版本请递增 CACHE（如 vocifly-v2），以清掉旧缓存。
const CACHE = 'vocifly-v42'
const CORE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {})
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return

  const isStatic = /\.(js|css|png|svg|json|webmanifest)(\?.*)?$/.test(url.pathname) || url.pathname === '/'
  const cacheKey = req.url // 带 query 的资源也能命中同一份缓存

  if (isStatic) {
    // network-first：先取网络最新，成功则回填缓存；失败/离线再回退缓存。
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(cacheKey, copy))
        }
        return res
      }).catch(() => caches.match(cacheKey).then((hit) => hit || caches.match('/index.html')))
    )
    return
  }

  // 其它（index.html / manifest 等）：network-first，失败回退缓存首页
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone()
      if (res.ok) caches.open(CACHE).then((c) => c.put(cacheKey, copy))
      return res
    }).catch(() => caches.match('/index.html'))
  )
})
