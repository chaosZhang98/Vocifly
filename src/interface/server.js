// PhVoice 服务端：手机网页 + WebSocket 音频流 + 本地 HTTPS
// 有证书时：HTTPS 应用跑在 8443，HTTP 证书安装页跑在 8080
// 无证书时：退回 HTTP 开发模式，仅适合 Mac 本机浏览器验证
const http = require('http')
const { X509Certificate } = require('crypto')
const https = require('https')
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { WebSocket, WebSocketServer } = require('ws')
const asr = require('../infrastructure/asr') // AsrPort：离线 sherpa / 在线 bailian 分发
const { config, getSettings, saveSettings } = require('../infrastructure/config')
const appList = require('../infrastructure/platform/app-switcher') // 前台应用枚举
const paster = require('../infrastructure/paste/mac-paster') // PastePort：mac 上屏
const { SessionService } = require('../application/SessionService')
const { ensureLocalCertificate, getLanIp, getLocalHostname } = require('./local-cert')
const { buildMobileConfig } = require('./mobileconfig')
const { log } = require('../infrastructure/logger')
const usage = require('../infrastructure/usage')
const paths = require('../infrastructure/paths')

// ---- 设备命名持久化 ----
// 手机端在 localStorage 里保存一个稳定的 deviceId（UUID），连接时通过 identify 握手上报。
// 控制面板可给设备自定义名称；名称按 deviceId 持久化到 app/data/devices.json，离线也会记住。
const DEVICE_FILE = path.join(paths.dataDir, 'devices.json')
let knownDevices = loadKnownDevices()

function loadKnownDevices() {
  try {
    if (fs.existsSync(DEVICE_FILE)) return JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'))
  } catch (error) {
    log('server', `devices.json 解析失败: ${error.message}`)
  }
  return {}
}

function persistKnownDevices() {
  try {
    fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true })
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(knownDevices, null, 2), { mode: 0o600 })
  } catch (error) {
    log('server', `写 devices.json 失败: ${error.message}`)
  }
}

const HTTP_PORT = Number(process.env.PHVOICE_HTTP_PORT || 8080)
const HTTPS_PORT = Number(process.env.PHVOICE_HTTPS_PORT || 8443)
const WEB_DIR = path.join(__dirname, '..', '..', 'renderer')
const ENABLE_PASTE = process.env.PHVOICE_PASTE !== '0'
// 注：ASR 上下文构造（buildAsrContext）及 CONTEXT_MAX_TURNS/CHARS、PARTIAL_THROTTLE_MS 已随
// A4 迁入 application/SessionService.js，此处不再保留。


usage.init({ broadcastToPhones })


// ---- 手机设备连接跟踪 ----
// 每个 /ws 连接登记一台设备，供控制面板「设备」页展示在线/离线与最近活动。
const devices = new Map()

// 所有 /ws 实例集合：预算自动降级时需要向所有在线手机广播通知。
const allWss = new Set()

function classifyPlatform(ua) {
  const s = String(ua || '').toLowerCase()
  if (/android|miui|xiaomi|hyperos|redmi|pixel|samsung|huawei|oppo|vivo|oneplus/.test(s)) return 'Android'
  if (/iphone|ipad|ios|macintosh|mac os/.test(s)) return 'iOS'
  return '未知设备'
}

function getDevices() {
  return [...devices.values()].map((d) => {
    // 若本次连接未上报名字，但 knownDevices 里有历史名字，则回填，保证重连后名字不丢
    const known = d.deviceId ? knownDevices[d.deviceId] : null
    return {
      ...d,
      name: d.name || (known && known.name) || '',
      platform: d.platform || (known && known.platform) || '未知设备',
    }
  })
}

function getDevicesPayload() {
  const online = getDevices()
  const known = Object.entries(knownDevices).map(([deviceId, v]) => ({
    deviceId,
    name: v.name || '',
    platform: v.platform || '未知设备',
    lastSeenAt: v.lastSeenAt || 0,
  }))
  return { count: online.length, devices: online, known }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pem': 'application/x-pem-file',
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { reject(new Error('JSON 解析失败')) }
    })
    req.on('error', reject)
  })
}

async function renderMacPage(ctx) {
  const phoneUrl = ctx.ipUrl || ctx.url
  const appQr = await QRCode.toDataURL(phoneUrl, { width: 440, margin: 1 })
  const setupQr = ctx.setupUrl ? await QRCode.toDataURL(ctx.setupUrl, { width: 440, margin: 1 }) : null

  const secureContent = `
    <section class="grid">
      <div>
        <h2>正常输入</h2>
        <img src="${appQr}" alt="PhVoice 使用二维码"/>
        <p>已配置过证书的手机扫这里</p>
      </div>
      <div>
        <h2>首次配置</h2>
        ${setupQr ? `<img src="${setupQr}" alt="PhVoice 证书二维码"/>` : ''}
        <p>新手机先扫这里安装本地证书</p>
      </div>
    </section>
    <footer>
      <span>使用地址</span>
      <strong>${phoneUrl}</strong>
      <small>手机和 Mac 保持在同一个局域网</small>
    </footer>`

  const insecureContent = `
    <section class="single">
      <h2>开发模式</h2>
      <img src="${appQr}" alt="PhVoice 开发二维码"/>
      <p>当前没有启用 HTTPS，手机浏览器无法调用麦克风。</p>
      <small>${ctx.certReason || '请先运行 npm run setup:https'}</small>
    </section>`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>PhVoice</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: -apple-system, "PingFang SC", sans-serif; background: #f6f7f9; color: #202124; display: flex; flex-direction: column; }
    header { padding: 26px 32px 10px; display: flex; align-items: flex-start; justify-content: space-between; }
    h1 { margin: 0; font-size: 28px; font-weight: 700; }
    header p { margin: 8px 0 0; color: #666; }
    a.settings { display: inline-block; margin-top: 2px; padding: 8px 14px; border-radius: 6px; background: #202124; color: #fff; text-decoration: none; font-size: 14px; font-weight: 600; }
    .grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 16px 32px 24px; }
    .grid > div, .single { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 22px; text-align: center; }
    .single { width: min(420px, calc(100vw - 64px)); margin: 16px auto 32px; }
    h2 { margin: 0 0 16px; font-size: 18px; }
    img { width: 220px; height: 220px; display: block; margin: 0 auto; }
    p { margin: 14px 0 0; color: #555; }
    small { color: #777; line-height: 1.5; }
    footer { padding: 18px 32px 26px; border-top: 1px solid #e5e7eb; display: grid; gap: 5px; }
    footer span { color: #777; font-size: 13px; }
    footer strong { font-size: 15px; font-weight: 600; }
    .usage { margin: 20px 32px 0; padding: 18px 22px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; }
    .usage h2 { margin: 0 0 14px; font-size: 16px; }
    .usage-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .usage-card { border: 1px solid #eee; border-radius: 8px; padding: 12px 14px; }
    .usage-card .label { display: block; color: #777; font-size: 12px; margin-bottom: 4px; }
    .usage-card strong { display: block; font-size: 16px; font-weight: 650; color: #202124; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .usage-card small { display: block; margin-top: 3px; color: #777; font-size: 12px; }
    .usage-note { margin: 12px 0 0; color: #555; font-size: 13px; }
    @media (max-width: 560px) { .usage-grid { grid-template-columns: 1fr; } .usage { margin-left: 16px; margin-right: 16px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>PhVoice</h1>
      <p>把手机变成 Mac 的语音输入麦克风</p>
    </div>
    <a class="settings" href="/settings">设置</a>
  </header>
  ${ctx.isSecure ? secureContent : insecureContent}

  <section class="usage">
    <h2>识别用量与费用</h2>
    <div class="usage-grid">
      <div class="usage-card">
        <span class="label">最近一次</span>
        <strong id="lastText">—</strong>
        <small id="lastDetail">时长 — · 费用 —</small>
      </div>
      <div class="usage-card">
        <span class="label">今日</span>
        <strong id="todayCost">¥0.00000</strong>
        <small id="todayDetail">0 次 · 0.0 秒</small>
      </div>
      <div class="usage-card">
        <span class="label">累计</span>
        <strong id="totalCost">¥0.00000</strong>
        <small id="totalDetail">0 次 · 0.0 秒</small>
      </div>
    </div>
    <p class="usage-note">当前使用 <strong id="providerName">—</strong>，单价 ¥<span id="pricePerSecond">0.000330</span>/秒，按音频时长计费。</p>
  </section>

  <script>
    async function loadUsage() {
      try {
        const res = await fetch('/api/stats', { cache: 'no-store' })
        if (!res.ok) return
        const s = await res.json()
        document.getElementById('providerName').textContent = s.provider === 'bailian' ? '阿里云百炼（在线）' : 'sherpa（离线，免费）'
        document.getElementById('pricePerSecond').textContent = s.pricePerSecond.toFixed(6)
        const last = s.last
        if (last) {
          document.getElementById('lastText').textContent = last.text || '（未识别到文本）'
          document.getElementById('lastText').title = last.text || '（未识别到文本）'
          const billTxt = (last.billableSeconds && (last.seconds % 1 !== 0)) ? '（计费 ' + last.billableSeconds + ' 秒）' : ''
          document.getElementById('lastDetail').textContent = '时长 ' + last.seconds.toFixed(1) + ' 秒' + billTxt + ' · 费用 ¥' + last.costYuan.toFixed(5)
        } else {
          document.getElementById('lastText').textContent = '—'
          document.getElementById('lastDetail').textContent = '时长 — · 费用 —'
        }
        document.getElementById('todayCost').textContent = '¥' + s.today.costYuan.toFixed(5)
        document.getElementById('todayDetail').textContent = s.today.sessions + ' 次 · ' + s.today.seconds.toFixed(1) + ' 秒'
        document.getElementById('totalCost').textContent = '¥' + s.total.costYuan.toFixed(5)
        document.getElementById('totalDetail').textContent = s.total.sessions + ' 次 · ' + s.total.seconds.toFixed(1) + ' 秒'
      } catch (e) { /* 忽略，下轮再试 */ }
    }
    loadUsage()
    setInterval(loadUsage, 3000)
  </script>
</body>
</html>`
}

const CONTROL_PATHS = ['/mac', '/settings', '/control', '/api/settings', '/api/stats', '/api/mac', '/api/app-quit', '/api/devices', '/api/export', '/api/logs']

// /api/health CORS 收紧：只给白名单内的 Origin 反射跨域头，避免任意站点随意探测。
// 手机首次配置页（setupUrl）需要跨域 fetch /api/health 验证证书，因此必须纳入白名单。
function isAllowedHealthOrigin(origin, ctx) {
  if (!origin) return false
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  // 本机（控制面板 / 常用浏览器）来源：localhost / 127.0.0.1 / ::1，任何端口都放行
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (localHosts.has(parsed.hostname)) return true
  // 证书安装页 / 应用自身暴露的 origin（含 lan IP、域名、HTTP/HTTPS 两种 scheme）
  if (ctx) {
    for (const u of [ctx.url, ctx.ipUrl, ctx.setupUrl, ctx.httpUrl]) {
      if (!u) continue
      try { if (new URL(u).origin === origin) return true } catch { /* 忽略非法 URL */ }
    }
  }
  return false
}


// 把触控板 + VAD 配置推给所有手机端：控制面板保存后，正在连接的手机立即生效（无需刷新重连）。
function broadcastSettings(settings, ctx) {
  const servers = []
  if (ctx) {
    if (ctx.wss) servers.push(ctx.wss)
    if (ctx.httpWss) servers.push(ctx.httpWss)
  }
  const payload = JSON.stringify({ type: 'settings', trackpad: settings.trackpad, vad: settings.vad })
  for (const wss of servers) {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(payload)
    }
  }
}


// ---- 用量导出 / 日志查看 ----
// /api/export：把用量明细导出为 CSV（本机控制面板取用）。type=history 导出识别明细，
// type=daily 导出按日聚合。仅本机 loopback 可访问。

// /api/logs：返回 logs/app.log 尾部若干行（默认 200），仅本机可访问，用于排查问题。
function tailLogFile(lines) {
  const file = path.join(paths.logsDir, 'app.log')
  if (!fs.existsSync(file)) return '（暂无日志文件）'
  let data
  try { data = fs.readFileSync(file, 'utf8') } catch (error) { return `（读取日志失败: ${error.message}）` }
  const arr = data.split(/\r?\n/)
  const n = Math.max(1, Math.min(1000, Number(lines) || 200))
  return arr.slice(-n).join('\n')
}

// 向所有在线手机广播一条消息（用于预算超限等主动提示）
function broadcastToPhones(payload) {
  for (const wss of allWss) {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(payload)
    }
  }
}


async function handleControlRoutes(req, res, ctx) {
  const urlPath = req.url.split('?')[0]
  if (!CONTROL_PATHS.includes(urlPath)) return false
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('该页面仅允许 Mac 本机访问')
    return true
  }

  if (urlPath === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(getSettings()))
    } else if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const settings = saveSettings(body)
        // 触控板/延时等配置改动后实时推给在线手机端，下次操作立即生效
        broadcastSettings(settings, ctx)
        // 手动保存配置视为一次“重新决策”，清除自动降级标记（下一次识别会按新预算重新评估）
        if (usage.resetAutoDowngraded()) { log('server', '已手动保存配置，重置费用自动降级标记') }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, settings }))
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: error.message }))
      }
    } else {
      res.writeHead(405)
      res.end('method not allowed')
    }
    return true
  }

  if (urlPath === '/api/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(usage.getUsageStats()))
    return true
  }

  if (urlPath === '/api/devices') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(getDevicesPayload()))
      return true
    }
    if (req.method === 'POST') {
      // 重命名设备（仅本机 loopback）。支持在线设备（connId/deviceId）与已知设备（deviceId）。
      try {
        const body = await readJsonBody(req)
        const cleanName = String(body.name || '').trim().slice(0, 40)
        const deviceId = String(body.deviceId || '').slice(0, 64)
        if (!deviceId) throw new Error('缺少 deviceId')
        // 更新在线连接
        for (const dev of devices.values()) {
          if (dev.deviceId === deviceId || String(dev.id) === deviceId) {
            dev.name = cleanName
            dev.lastActiveAt = Date.now()
          }
        }
        // 更新持久化的已知设备
        const known = knownDevices[deviceId] || {}
        known.name = cleanName
        known.lastSeenAt = Date.now()
        knownDevices[deviceId] = known
        persistKnownDevices()
        log('server', `设备已重命名: ${deviceId.slice(0, 8)} -> ${cleanName || '(未命名)'}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, payload: getDevicesPayload() }))
        return true
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: error.message }))
        return true
      }
    }
    res.writeHead(405)
    res.end('method not allowed')
    return true
  }

  if (urlPath === '/api/export' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams
    const type = q.get('type') === 'daily' ? 'daily' : 'history'
    const csv = usage.usageExportCsv(type)
    const filename = type === 'daily' ? 'phvoice-usage-daily.csv' : 'phvoice-usage.csv'
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${filename}"`,
    })
    res.end(csv)
    return true
  }

  if (urlPath === '/api/logs' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams
    const body = tailLogFile(q.get('lines'))
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
    return true
  }

  if (urlPath === '/api/mac' && req.method === 'GET') {
    const phoneUrl = ctx.ipUrl || ctx.url
    const appQr = await QRCode.toDataURL(phoneUrl, { width: 440, margin: 1 })
    const setupQr = ctx.setupUrl ? await QRCode.toDataURL(ctx.setupUrl, { width: 440, margin: 1 }) : null
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({
      phoneUrl,
      setupUrl: ctx.setupUrl || '',
      appUrl: ctx.url || '',
      isSecure: !!ctx.isSecure,
      certReason: ctx.certReason || '',
      appQr,
      setupQr,
    }))
    return true
  }

  if (urlPath === '/api/app-quit' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true }))
    // 由 Electron 主进程注入的 onQuit 回调退出应用（node 独立运行时为空实现，仅提示）
    if (typeof ctx.onQuit === 'function') {
      setImmediate(() => ctx.onQuit())
    } else {
      log('server', '收到退出请求，但当前为独立 node 模式，忽略')
    }
    return true
  }

  if (urlPath === '/control') {
    const file = path.join(WEB_DIR, 'control.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      res.end('control.html not found')
      return true
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
    return true
  }

  if (urlPath === '/mac') {
    const html = await renderMacPage(ctx)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return true
  }

  if (urlPath === '/settings') {
    const file = path.join(WEB_DIR, 'settings.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return true
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
    return true
  }

  return true
}

function serveApp(req, res, ctx) {
  const urlPath = req.url.split('?')[0]
  if (urlPath === '/api/health') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    // 仅在发起方 Origin 在白名单内时才反射 CORS；同源请求（控制面板）不携带 Origin，无需处理。
    const origin = req.headers.origin
    if (origin && isAllowedHealthOrigin(origin, ctx)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify({ ok: true, service: 'phvoice' }))
    return
  }

  if (ctx && CONTROL_PATHS.includes(urlPath)) {
    handleControlRoutes(req, res, ctx).catch((error) => {
      log('server', '控制页请求失败:', error.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('控制页请求失败')
      }
    })
    return
  }

  // /assets/* 指向项目根 app/assets（托盘图标 / PWA 图标等），其余从 app/web 提供。
  let filePath = urlPath
  if (filePath === '/') filePath = '/index.html'
  let baseDir = WEB_DIR
  if (filePath.startsWith('/assets/')) baseDir = path.join(__dirname, '..', '..', 'assets')
  const file = path.join(baseDir, filePath.replace(/^\/(assets\/)?/, '/'))
  if (!file.startsWith(baseDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    // 禁缓存：前端迭代期 Safari 可能拿旧 JS，导致代码改了却不生效
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
}

function renderIosSetupPage(ctx) {
  const appUrlLiteral = JSON.stringify(ctx.url)
  const ipUrlLiteral = JSON.stringify(ctx.ipUrl)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>PhVoice 首次配置</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px 20px 40px; font-family: -apple-system, "PingFang SC", sans-serif; background: #f7f7f8; color: #202124; line-height: 1.65; }
    main { max-width: 680px; margin: 0 auto; }
    h1 { font-size: 25px; margin: 0 0 8px; }
    h2 { font-size: 17px; margin: 28px 0 12px; }
    p { margin: 6px 0; }
    .intro { color: #666; margin-bottom: 22px; }
    .step { display: grid; grid-template-columns: 30px 1fr; gap: 12px; margin: 16px 0; }
    .number { width: 28px; height: 28px; border-radius: 50%; background: #202124; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
    .step strong { display: block; margin-bottom: 3px; }
    .step p { color: #5f6368; }
    .path { display: inline-block; margin-top: 5px; padding: 3px 8px; border-radius: 6px; background: #eceff1; color: #202124; font-size: 14px; }
    a.button, button.button { display: block; width: 100%; margin: 18px 0; padding: 14px 16px; border: 0; border-radius: 10px; background: #2563eb; color: white; text-align: center; text-decoration: none; font-size: 16px; font-weight: 650; }
    a.secondary, button.secondary { background: #202124; }
    a.disabled { opacity: .45; pointer-events: none; }
    .verify-status { margin: -8px 0 4px; padding: 11px 12px; border-radius: 8px; background: #eceff1; color: #5f6368; font-size: 14px; }
    .verify-status.success { background: #e8f5ee; color: #137333; }
    .verify-status.error { background: #fce8e6; color: #c5221f; }
    .note { color: #666; font-size: 14px; margin-top: 18px; }
    .note a { color: #2563eb; }
  </style>
</head>
<body>
  <main>
    <h1>PhVoice 首次配置</h1>
    <p class="intro">只需要在这台 iPhone 上配置一次。配置完成后，以后直接使用 PhVoice 的正常输入二维码。</p>

    <h2>第一步：下载安装描述文件</h2>
    <div class="step">
      <span class="number">1</span>
      <div>
        <strong>点击下方按钮</strong>
        <p>Safari 会提示“此网站正尝试下载一个配置描述文件”，请点“允许”。</p>
      </div>
    </div>
    <a class="button" href="/phvoice-ca.mobileconfig">下载安装描述文件</a>

    <h2>第二步：安装描述文件</h2>
    <div class="step">
      <span class="number">2</span>
      <div>
        <strong>进入 iPhone 的“VPN 与设备管理”</strong>
        <span class="path">设置 &gt; 通用 &gt; VPN 与设备管理</span>
        <p>在“已下载的描述文件”下面找到 <strong>PhVoice 本地证书</strong>，点进去并选择“安装”。</p>
      </div>
    </div>

    <h2>第三步：信任根证书</h2>
    <div class="step">
      <span class="number">3</span>
      <div>
        <strong>打开 PhVoice 根证书开关</strong>
        <span class="path">设置 &gt; 通用 &gt; 关于本机 &gt; 证书信任设置</span>
        <p>启用“PhVoice 本地根证书”。如果这里还是空的，说明第二步还没有安装成功。</p>
      </div>
    </div>

    <h2>第四步：验证并进入</h2>
    <div class="step">
      <span class="number">4</span>
      <div>
        <strong>回到本页验证</strong>
        <p>验证通过后，再进入 PhVoice 语音输入。</p>
      </div>
    </div>
    <button id="verifyButton" class="button" type="button">验证安装</button>
    <p id="verifyStatus" class="verify-status">尚未验证。请先完成上面的安装和信任步骤。</p>
    <a id="openApp" class="button secondary disabled" aria-disabled="true" href="${ctx.url}">打开 PhVoice 语音输入</a>

    <p class="note">如果没有看到“已下载的描述文件”，请回到第一步重新下载。也可以<a href="/phvoice-ca.pem">下载 PEM 备用文件</a>。</p>
  </main>
  <script>
    const appUrl = ${appUrlLiteral}
    const ipUrl = ${ipUrlLiteral}
    const verifyButton = document.getElementById('verifyButton')
    const verifyStatus = document.getElementById('verifyStatus')
    const openApp = document.getElementById('openApp')

    // 带超时的探测：mDNS 解析卡住时 fetch 会无限挂起，必须主动掐断
    async function probe(url, timeoutMs) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url + '/api/health', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) return { ok: false, reason: 'HTTP ' + response.status }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error.name === 'AbortError' ? '超时' : '连接失败' }
      } finally {
        clearTimeout(timer)
      }
    }

    async function verifyInstall() {
      verifyButton.disabled = true
      verifyStatus.className = 'verify-status'
      verifyStatus.textContent = '正在验证（最多约 6 秒）…'
      // 域名走 mDNS 广播，在部分网络环境（合盖、路由器组播策略）下会解析失败；
      // IP 直连不依赖 mDNS，证书 SAN 已覆盖，一样受信任
      const results = await Promise.all([
        probe(appUrl, 5000).then((r) => ({ label: '域名', url: appUrl, ...r })),
        probe(ipUrl, 5000).then((r) => ({ label: 'IP 直连', url: ipUrl, ...r })),
      ])
      const okCandidate = results.find((r) => r.ok)
      const detail = results.map((r) => r.label + (r.ok ? ' 成功' : ' ' + r.reason)).join('；')
      if (okCandidate) {
        verifyStatus.className = 'verify-status success'
        verifyStatus.textContent = '验证通过（' + detail + '），可以进入 PhVoice。'
        openApp.href = okCandidate.url
        openApp.classList.remove('disabled')
        openApp.removeAttribute('aria-disabled')
      } else {
        verifyStatus.className = 'verify-status error'
        verifyStatus.textContent = '还没有验证通过（' + detail + '）。请确认描述文件已安装并信任，且手机与 Mac 连接同一 Wi-Fi。'
      }
      verifyButton.disabled = false
    }

    verifyButton.addEventListener('click', verifyInstall)
  </script>
</body>
</html>`
}

function renderAndroidSetupPage(ctx) {
  const appUrlLiteral = JSON.stringify(ctx.url)
  const ipUrlLiteral = JSON.stringify(ctx.ipUrl)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>PhVoice 首次配置</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px 20px 40px; font-family: -apple-system, "PingFang SC", sans-serif; background: #f7f7f8; color: #202124; line-height: 1.65; }
    main { max-width: 680px; margin: 0 auto; }
    h1 { font-size: 25px; margin: 0 0 8px; }
    h2 { font-size: 17px; margin: 28px 0 12px; }
    p { margin: 6px 0; }
    .intro { color: #666; margin-bottom: 22px; }
    .callout { margin: 0 0 20px; padding: 12px 14px; border-radius: 10px; background: #fff7e6; border: 1px solid #f2c94c; color: #7a5a00; font-size: 15px; }
    .callout strong { color: #4a3200; }
    .step { display: grid; grid-template-columns: 30px 1fr; gap: 12px; margin: 16px 0; }
    .number { width: 28px; height: 28px; border-radius: 50%; background: #202124; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
    .step strong { display: block; margin-bottom: 3px; }
    .step p { color: #5f6368; }
    .path { display: inline-block; margin-top: 5px; padding: 3px 8px; border-radius: 6px; background: #eceff1; color: #202124; font-size: 14px; }
    a.button, button.button { display: block; width: 100%; margin: 18px 0; padding: 14px 16px; border: 0; border-radius: 10px; background: #2563eb; color: white; text-align: center; text-decoration: none; font-size: 16px; font-weight: 650; }
    a.secondary, button.secondary { background: #202124; }
    a.disabled { opacity: .45; pointer-events: none; }
    .verify-status { margin: -8px 0 4px; padding: 11px 12px; border-radius: 8px; background: #eceff1; color: #5f6368; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
    .verify-status.success { background: #e8f5ee; color: #137333; }
    .verify-status.error { background: #fce8e6; color: #c5221f; }
    .verify-status.warn { background: #fff7e6; color: #7a5a00; }
    .diag { margin: 8px 0 4px; padding: 10px 12px; border-radius: 8px; background: #f4f5f6; color: #444; font-size: 13px; font-family: ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
    .note { color: #666; font-size: 14px; margin-top: 18px; }
    .note a { color: #2563eb; }
  </style>
</head>
<body>
  <main>
    <h1>PhVoice 首次配置</h1>
    <p class="intro">只需要在这台安卓手机 / 平板上配置一次。配置完成后，以后直接使用 PhVoice 的正常输入二维码。</p>

    <div class="callout">
      <strong>重要：请用「Chrome」浏览器打开本页完成验证。</strong> 安卓系统默认只信任“用户 CA 证书”，部分国产浏览器或应用内嵌页面不会信任它，会导致“证书已装好但验证仍失败”。如果这一步用自带浏览器验证不通过，请装一个 Chrome 并在此重新打开本页。
    </div>

    <h2>第一步：下载证书</h2>
    <div class="step">
      <span class="number">1</span>
      <div>
        <strong>点击下方按钮下载 CA 证书</strong>
        <p>浏览器会下载 <strong>phvoice-ca.crt</strong>，一般会保存在系统的“下载”文件夹。</p>
      </div>
    </div>
    <a class="button" href="/phvoice-ca.crt">下载 CA 证书</a>

    <h2>第二步：安装为 CA 证书</h2>
    <div class="step">
      <span class="number">2</span>
      <div>
        <strong>进入系统设置，安装证书</strong>
        <span class="path">设置 &gt; 安全 &gt; 加密与凭据 &gt; 安装证书 &gt; CA 证书</span>
        <p>不同品牌入口可能不同，部分手机在「设置 &gt; 密码与安全 &gt; 加密与凭据 &gt; 从存储设备安装证书」下。这里务必选择 <strong>“CA 证书”</strong>，不要选“VPN 和应用用户证书”。</p>
      </div>
    </div>

    <h2>第三步：选择刚下载的证书</h2>
    <div class="step">
      <span class="number">3</span>
      <div>
        <strong>选择 phvoice-ca.crt</strong>
        <p>在文件选择器里找到“下载”目录中的 <strong>phvoice-ca.crt</strong> 并打开。若系统提示“可能带来风险”，请选择<strong>仍然安装</strong>。</p>
      </div>
    </div>

    <h2>第四步：确认已被系统信任</h2>
    <div class="step">
      <span class="number">4</span>
      <div>
        <strong>去“受信任的凭据”里确认</strong>
        <span class="path">设置 &gt; 加密与凭据 &gt; 受信任的凭据 &gt; 用户</span>
        <p>应能看到一条以 <strong>“mkcert …”</strong> 命名的证书，且右侧开关处于<strong>打开</strong>状态。如果这里看不到，说明第二步选错了类型，请回到第二步重新选择<strong>“CA 证书”</strong>。</p>
      </div>
    </div>

    <h2>第五步：验证并进入</h2>
    <div class="step">
      <span class="number">5</span>
      <div>
        <strong>回到本页验证</strong>
        <p>验证通过后，再进入 PhVoice 语音输入。</p>
      </div>
    </div>
    <button id="verifyButton" class="button" type="button">验证安装</button>
    <p id="verifyStatus" class="verify-status">尚未验证。请先完成上面的安装和信任步骤。</p>
    <pre id="diag" class="diag" style="display:none"></pre>
    <a id="openApp" class="button secondary" href="${ctx.ipUrl}">打开 PhVoice 语音输入</a>

    <p class="note">本页下载的 <strong>phvoice-ca.crt</strong> 已转换成 Android 安装所需的 <strong>DER</strong> 编码；若浏览器直接显示证书文本，请长按链接选择“下载链接”。如系统仍提示“证书格式无效”，可下载 <a href="/phvoice-ca.pem">phvoice-ca.pem 备用文件</a> 并重命名为 phvoice-ca.cer 再安装（仅个别旧系统）。</p>
  </main>
  <script>
    const appUrl = ${appUrlLiteral}
    const ipUrl = ${ipUrlLiteral}
    const verifyButton = document.getElementById('verifyButton')
    const verifyStatus = document.getElementById('verifyStatus')
    const diag = document.getElementById('diag')
    const openApp = document.getElementById('openApp')

    function classifyFailure(error, elapsedMs) {
      if (error && error.name === 'AbortError') {
        return { kind: 'timeout', reason: '超时（长时间未响应）' }
      }
      const fast = typeof elapsedMs === 'number' && elapsedMs >= 0 && elapsedMs < 2000
      return {
        kind: fast ? 'cert' : 'network',
        reason: fast ? '连接失败（疑似证书未被当前浏览器信任）' : '连接失败'
      }
    }

    async function probe(url, timeoutMs) {
      const controller = new AbortController()
      const start = performance.now()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url + '/api/health', { cache: 'no-store', signal: controller.signal })
        const elapsedMs = Math.round(performance.now() - start)
        if (!response.ok) return { ok: false, kind: 'http', reason: 'HTTP ' + response.status, elapsedMs }
        return { ok: true, kind: 'ok', reason: '成功', elapsedMs }
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - start)
        const f = classifyFailure(error, elapsedMs)
        return { ok: false, kind: f.kind, reason: f.reason + ' (' + elapsedMs + 'ms)', elapsedMs }
      } finally {
        clearTimeout(timer)
      }
    }

    function setStatus(cls, text) {
      verifyStatus.className = 'verify-status' + (cls ? ' ' + cls : '')
      verifyStatus.textContent = text
    }

    function showDiag(lines) {
      diag.textContent = lines.join('\\n')
      diag.style.display = lines.length ? 'block' : 'none'
    }

    async function verifyInstall() {
      verifyButton.disabled = true
      setStatus('', '正在验证（最多约 8 秒）…')
      showDiag([])
      // 本页本身就是通过 HTTP 打开的，能加载出来就说明“设备→Mac”网络是通的。
      const results = await Promise.all([
        probe(appUrl, 6000).then((r) => ({ label: '域名', url: appUrl, ...r })),
        probe(ipUrl, 6000).then((r) => ({ label: 'IP 直连', url: ipUrl, ...r }))
      ])
      const okCandidate = results.find((r) => r.ok)
      const detail = results.map((r) => r.label + (r.ok ? ' 成功' : ' ' + r.reason)).join('；')
      showDiag(results.map((r) => r.label + '  →  ' + r.url + (r.ok ? '  OK' : '  失败: ' + r.reason)))

      if (okCandidate) {
        setStatus('success', '验证通过（' + detail + '），可以进入 PhVoice。')
        openApp.href = okCandidate.url
        return
      }

      // IP 直连是决定性测试（不依赖 mDNS）；.local 域名在安卓上常因组播解析失败，仅作参考
      const ipResult = results[1]

      if (ipResult.kind === 'timeout') {
        setStatus('warn', '能连到 Mac（HTTP 正常），但 IP 直连 HTTPS 超时。这通常不是证书问题，而是路由器 / 防火墙拦截了 https 端口 8443。\\n请检查：\\n· 平板与 Mac 是否在同一个 Wi-Fi；\\n· 路由器是否开启了“访客网络 / AP 隔离”；\\n· Mac 的防火墙是否放行了 Node / Electron。\\n\\n探测详情：' + detail)
      } else if (ipResult.kind === 'cert') {
        setStatus('error', '网络通畅（HTTP 正常），但 HTTPS 证书未被当前浏览器信任。\\n这是问题所在：证书虽然装上了，但这个浏览器不认“用户 CA”。\\n请改用「Chrome」重新打开本页再点验证；并确认证书出现在「受信任的凭据 > 用户」且开关已开。\\n（应急：也可直接点“打开 PhVoice 语音输入”，在浏览器“不安全 / 继续访问”提示里选继续也能进，但证书未真正信任，仍建议按上方用 Chrome 装好。）\\n\\n探测详情：' + detail)
      } else {
        setStatus('error', '还没有验证通过。' + detail + '\\n请确认：已用 Chrome 打开本页、证书安装在「CA 证书」、并出现在「受信任的凭据 > 用户」。如果 IP 直连显示超时，请检查路由器 / 防火墙是否拦截了 8443 端口。')
      }
      verifyButton.disabled = false
    }

    verifyButton.addEventListener('click', verifyInstall)
  </script>
</body>
</html>`
}


// Android 的“CA 证书”安装流程要求 DER（二进制）编码的 X.509 证书，
// 而 mkcert 根证书文件是 PEM（文本）。若直接把 PEM 以 .crt 下发，会出现
// “证书已装上但系统不信任/验证仍失败”。这里在启动后按需一次性转成 DER 并缓存。
let caDerCache = null
let caDerCachePath = null
function getCaDer(caFile) {
  if (caDerCache && caDerCachePath === caFile) return caDerCache
  const cert = new X509Certificate(fs.readFileSync(caFile))
  caDerCache = cert.raw // Buffer，DER 编码
  caDerCachePath = caFile
  return caDerCache
}

function serveCertificateSetup(caFile, ctx) {
  return (req, res) => {
    const urlPath = req.url.split('?')[0]
    if (CONTROL_PATHS.includes(urlPath)) {
      handleControlRoutes(req, res, ctx).catch((error) => {
        log('server', '控制页请求失败:', error.message)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('控制页请求失败')
        }
      })
      return
    }
    if (urlPath === '/phvoice-ca.mobileconfig') {
      res.writeHead(200, {
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': 'attachment; filename="phvoice-ca.mobileconfig"',
      })
      res.end(buildMobileConfig(caFile))
      return
    }

    if (urlPath === '/phvoice-ca.pem') {
      res.writeHead(200, {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename="phvoice-ca.pem"',
      })
      fs.createReadStream(caFile).pipe(res)
      return
    }

    // 安卓无法安装 .mobileconfig，改走 CA 证书（.crt）手动安装。
    // 关键：这里必须下发 DER 编码，Android 的“安装 CA 证书”才信任；PEM 会导致“装上但不被信任”。
    if (urlPath === '/phvoice-ca.crt') {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="phvoice-ca.crt"',
      })
      res.end(getCaDer(caFile))
      return
    }

    const ua = (req.headers['user-agent'] || '').toLowerCase()
    const isAndroid = /android|miui|xiaomi|hyperos|redmi|pixel|samsung|huawei|oppo|vivo|oneplus/i.test(ua)
    const html = isAndroid ? renderAndroidSetupPage(ctx) : renderIosSetupPage(ctx)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }
}

// 本地 HTTP 入口：localhost/127.0.0.1 属于浏览器安全上下文，无需证书即可打开 App；
// 局域网 IP 访问仍走证书安装页（手机首次配置用）。两种请求共用 HTTP 端口。
function serveAppHttp(caFile, ctx) {
  const certSetup = serveCertificateSetup(caFile, ctx)
  return (req, res) => {
    const host = (req.headers.host || '').split(':')[0]
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    if (isLoopback) {
      serveApp(req, res, ctx)
      return
    }
    certSetup(req, res)
  }
}

// 组合根：把 Infrastructure 具体实现装配成端口集合，供 Interface 层（server.js）注入给
// Application 层（SessionService 等）。这是洋葱架构里唯一「知道具体实现」的地方。
// 测试或替换实现时，可用同形状对象覆盖 createServer 的 deps 参数。
function buildDeps() {
  return {
    asr, // AsrPort：离线 sherpa / 在线 bailian 按 config.asr.provider 分发
    paster, // PastePort：mac-paster（剪贴板 + Cmd+V + mac-control 助手）
    appList, // 前台应用枚举（平台面板数据源）
    usage, // 用量/计费统计
    config,
    log,
    enablePaste: ENABLE_PASTE,
  }
}

function attachWebSocket(server, onStatus, deps) {
  // Interface 层依赖注入：端口默认由组合根提供，测试可用 mock 覆盖 createServer 的 deps。
  const { asr, paster, appList, usage, config, log, enablePaste } = deps
  const wss = new WebSocketServer({ server, path: '/ws' })
  allWss.add(wss)
  let nextConnId = 1

  wss.on('connection', (ws, req) => {
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    const connId = nextConnId++
    const peer = req.socket.remoteAddress
    const ua = req.headers['user-agent'] || ''
    devices.set(connId, { id: connId, deviceId: null, name: '', platform: classifyPlatform(ua), ip: peer, connectedAt: Date.now(), lastActiveAt: Date.now() })
    log('ws', `#${connId} 手机已连接 (${peer})`)
    onStatus?.('connected')
    // 手机端无法访问 /api/settings（控制面板仅 loopback），因此把触控板配置随连接下发，
    // 让手机端应用可调的灵敏度/边缘/轨迹常量。
    ws.send(JSON.stringify({ type: 'settings', trackpad: config.trackpad, vad: config.vad }))
    // 会话状态机与识别/上屏用例收敛到 Application 层（SessionService）。
    // Interface 层只做依赖注入 + socket 收发，不再直接操控会话状态。
    const sessionSvc = new SessionService({
      asr,
      paster,
      usage,
      config,
      enablePaste: ENABLE_PASTE,
      log,
      emit: (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)) },
      connId,
    })

    ws.on('message', (data, isBinary) => {
      const dev = devices.get(connId)
      if (dev) dev.lastActiveAt = Date.now()
      if (isBinary) {
        // 二进制帧 = PCM 音频块（Int16, 16kHz, mono）
        sessionSvc.pushAudio(data)
        return
      }

      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (msg.type === 'identify') {
        const dev = devices.get(connId)
        if (dev) {
          if (msg.id) dev.deviceId = String(msg.id).slice(0, 64)
          if (msg.name) dev.name = String(msg.name).slice(0, 40)
          if (msg.platform) dev.platform = String(msg.platform).slice(0, 40)
          if (dev.deviceId) {
            // 回填持久化“已知设备”，并刷新最近活动
            const known = knownDevices[dev.deviceId] || {}
            if (dev.name) known.name = dev.name
            if (dev.platform && dev.platform !== '未知设备') known.platform = dev.platform
            known.lastSeenAt = Date.now()
            knownDevices[dev.deviceId] = known
            persistKnownDevices()
            log('ws', `#${connId} 设备上报: ${dev.name || '(未命名)'} (${dev.platform}) id=${dev.deviceId.slice(0, 8)}`)
          }
        }
        return
      }

      if (msg.type === 'start') {
        sessionSvc.start()
      } else if (msg.type === 'stop') {
        sessionSvc.stop()
      } else if (msg.type === 'cancel') {
        sessionSvc.cancel()
      } else if (msg.type === 'compose') {
        // 手机端 compose：文本 + 附件（图片/文件原子上屏），粘贴后自动回车
        sessionSvc.compose(msg)
      } else if (msg.type === 'send') {
        sessionSvc.send()
      } else if (msg.type === 'repaste') {
        // 重新上屏：首次上屏贴错位置后，用户把 Mac 光标移到正确位置，重新粘贴最后一次结果。
        sessionSvc.repaste(msg)
      } else if (msg.type === 'delete') {
        sessionSvc.removeLast()
      } else if (msg.type === 'window') {
        const dir = msg.dir === 'prev' ? 'prev' : 'next'
        log('ws', `#${connId} 切换窗口: ${dir}`)
        paster.switchWindow(dir)
        ws.send(JSON.stringify({ type: 'windowSwitched', dir }))
      } else if (msg.type === 'apps') {
        const apps = appList.listApps().map((app) => ({
          ...app,
          icon: app.icon ? 'data:image/png;base64,' + app.icon : '',
        }))
        log('ws', `#${connId} 拉取 App 列表（${apps.length} 个）`)
        ws.send(JSON.stringify({ type: 'apps', apps }))
      } else if (msg.type === 'launchpad') {
        // 启动台：列出系统级 + 非系统级全部可启动应用
        // listAllApps 内部带 30s TTL 缓存，仅在真正拉取时才打印日志，便于验证缓存命中
        const apps = appList.listAllApps().map((app) => ({
          ...app,
          icon: app.icon ? 'data:image/png;base64,' + app.icon : '',
        }))
        ws.send(JSON.stringify({ type: 'launchpad', apps }))
      } else if (msg.type === 'activateApp') {
        const bundleId = String(msg.bundleId || '')
        log('ws', `#${connId} 激活应用: ${bundleId}`)
        paster.activateApp(bundleId)
        ws.send(JSON.stringify({ type: 'appActivated', bundleId }))
      } else if (msg.type === 'gesture') {
        const action = ['expose', 'mission', 'launchpad'].includes(msg.action) ? msg.action : 'mission'
        log('ws', `#${connId} 触发手势: ${action}`)
        paster.gesture(action)
        ws.send(JSON.stringify({ type: 'gestureDone', action }))
      } else if (msg.type === 'getFrontApp') {
        const front = appList.getFrontmostApp()
        log('ws', `#${connId} 查询前台应用: ${front ? front.name || front.bundleId : '(无)'}`)
        ws.send(JSON.stringify({ type: 'frontApp', app: front }))
      } else if (msg.type === 'quitApp') {
        log('ws', `#${connId} 退出当前应用`)
        paster.quitApp()
        ws.send(JSON.stringify({ type: 'appQuit' }))
      } else if (msg.type === 'mouseMove') {
        // 手机触控板模式下，按灵敏度换算相对位移（可在控制面板配置）
        const sens = config.trackpad.sensitivity
        paster.mouseMove((msg.dx || 0) * sens, (msg.dy || 0) * sens)
      } else if (msg.type === 'mouseClick') {
        paster.mouseClick()
      } else if (msg.type === 'mouseDown') {
        paster.mouseDown()
      } else if (msg.type === 'mouseUp') {
        paster.mouseUp()
      } else if (msg.type === 'mouseRightClick') {
        paster.mouseRightClick()
      } else if (msg.type === 'mouseScroll') {
        const sens = config.trackpad.sensitivity
        paster.mouseScroll((msg.dx || 0) * sens, (msg.dy || 0) * sens)
      } else if (msg.type === 'log') {
        // 手机端关键事件上报，集中进同一个日志文件
        log(`phone#${connId}`, msg.scope || '-', msg.text || '')
      }
    })

    ws.on('close', () => {
      sessionSvc.dispose()
      log('ws', `#${connId} 连接断开`)
      devices.delete(connId)
      onStatus?.('disconnected')
    })

    ws.on('error', (error) => log('ws', `#${connId} 连接错误:`, error.message))
  })

  // 服务端心跳：每 30s 对每个连接 ping，若上一轮未回 pong（isAlive 仍 false）则终止，
  // 清理因断网/休眠残留下的僵尸连接。浏览器 WS 会在协议层自动回 pong，无需手机端额外处理。
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate()
        continue
      }
      client.isAlive = false
      client.ping()
    }
  }, 30000)
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function createServer({ onStatus, onQuit, deps } = {}) {
  // 组合根：未显式注入时由 buildDeps() 装配真实实现；测试/替换可传 mock。
  const { asr, paster, appList, usage, config, log, enablePaste } = deps || buildDeps()
  log('server', `ASR provider: ${config.asr.provider}`)
  const lanIp = getLanIp() || '127.0.0.1'
  const localHostname = getLocalHostname()
  const forceHttp = process.env.PHVOICE_FORCE_HTTP === '1'
  const cert = forceHttp ? { ok: false, reason: '已通过 PHVOICE_FORCE_HTTP=1 强制使用 HTTP' } : ensureLocalCertificate()

  if (cert.ok) {
    const appUrl = `https://${localHostname}:${HTTPS_PORT}`
    const ipUrl = `https://${lanIp}:${HTTPS_PORT}`
    const setupUrl = `http://${lanIp}:${HTTP_PORT}`
    const ctx = { url: appUrl, ipUrl, setupUrl, isSecure: true, certReason: cert.reason, onQuit }

    const appServer = https.createServer({
      cert: fs.readFileSync(cert.certFile),
      key: fs.readFileSync(cert.keyFile),
    }, (req, res) => serveApp(req, res, ctx))
    const wss = attachWebSocket(appServer, onStatus, deps || buildDeps())
    ctx.wss = wss

    // 本地 HTTP：localhost 无需证书即可用（内置浏览器/桌面浏览器），保留 /mac 与证书安装页
    const setupServer = http.createServer(serveAppHttp(cert.caFile, ctx))
    const httpWss = attachWebSocket(setupServer, onStatus, deps || buildDeps())
    ctx.httpWss = httpWss

    await listen(appServer, HTTPS_PORT)
    await listen(setupServer, HTTP_PORT)

    return { server: appServer, setupServer, wss, httpWss, url: appUrl, ipUrl, setupUrl, httpUrl: `http://localhost:${HTTP_PORT}`, isSecure: true, cert, controlUrl: `http://127.0.0.1:${HTTP_PORT}/control` }
  }

  const url = `http://${lanIp}:${HTTP_PORT}`
  const ctx = { url, ipUrl: url, setupUrl: null, isSecure: false, certReason: cert.reason, onQuit }
  const appServer = http.createServer((req, res) => serveApp(req, res, ctx))
  const wss = attachWebSocket(appServer, onStatus, deps || buildDeps())
  ctx.wss = wss
  await listen(appServer, HTTP_PORT)

  return {
    server: appServer,
    setupServer: null,
    wss,
    url,
    ipUrl: url,
    setupUrl: null,
    isSecure: false,
    cert,
    httpUrl: `http://localhost:${HTTP_PORT}`,
    controlUrl: `http://127.0.0.1:${HTTP_PORT}/control`,
  }
}

if (require.main === module) {
  createServer({ onStatus: (status) => console.log('[status]', status) })
    .then(({ url, setupUrl, isSecure, cert }) => {
      log('server', `PhVoice 服务已启动: ${url}`)
      if (isSecure) log('server', `首次配置手机证书: ${setupUrl}`)
      else log('server', `当前是 HTTP 开发模式，手机浏览器无法调用麦克风。原因: ${cert.reason}`)
    })
    .catch((error) => {
      log('server', '启动失败:', error.message)
      process.exit(1)
    })
}

module.exports = { createServer, getLanIp, getLocalHostname }
