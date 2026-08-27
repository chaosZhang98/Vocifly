// Vocifly 服务端：手机网页 + WebSocket 音频流 + 本地 HTTPS
// 有证书时：HTTPS 应用跑在 9899，HTTP 证书安装页跑在 9898（默认；均可被 VOCIFLY_*_PORT 覆盖）
// 无证书时：退回 HTTP 开发模式，仅适合 Mac 本机浏览器验证
const http = require('http')
const { X509Certificate } = require('crypto')
const https = require('https')
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { WebSocket, WebSocketServer } = require('ws')
const asr = require('../infrastructure/asr') // AsrPort：离线 sherpa / 在线 bailian 分发
const { config, getSettings, saveSettings, effectiveVad } = require('../infrastructure/config')
const appList = require('../infrastructure/platform/app-switcher') // 前台应用枚举
const paster = require('../infrastructure/paste/mac-paster') // PastePort：mac 上屏
const optimize = require('../infrastructure/optimize/bailian-optimize') // OptimizePort：百炼 qwen 文字优化
const { SessionService } = require('../application/SessionService')
const { ensureLocalCertificate, getLanIp, getLocalHostname } = require('./local-cert')
const { buildMobileConfig } = require('./mobileconfig')
const { log } = require('../infrastructure/logger')
const usage = require('../infrastructure/usage')
const paths = require('../infrastructure/paths')
const pairing = require('../infrastructure/pairing') // 一次性配对码 + 持久设备令牌
const modelDownload = require('../infrastructure/model-download') // 离线模型就绪检测 + 下载

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

// 端口解析：环境变量（VOCIFLY_*_PORT，优先）> config.json（可在控制面板改）> 内置默认。
// 之所以做成函数而非模块级常量，是为了让「改端口→重启服务」时能读到新值，无需退出进程。
function resolveHttpPort() {
  const env = Number(process.env.VOCIFLY_HTTP_PORT)
  if (env) return env
  const cfg = Number(config.httpPort)
  if (cfg) return cfg
  return 9898
}
function resolveHttpsPort() {
  const env = Number(process.env.VOCIFLY_HTTPS_PORT)
  if (env) return env
  const cfg = Number(config.httpsPort)
  if (cfg) return cfg
  return 9899
}
const WEB_DIR = path.join(__dirname, '..', '..', 'renderer')
const ENABLE_PASTE = process.env.VOCIFLY_PASTE !== '0'
// 注：ASR 上下文构造（buildAsrContext）及 CONTEXT_MAX_TURNS/CHARS、PARTIAL_THROTTLE_MS 已随
// A4 迁入 application/SessionService.js，此处不再保留。


usage.init({
  broadcastToPhones,
  // 预算超限自动降级是全局的：压过单台手机的「云端」模式选择 —— 清掉所有云端正计费的
  // provider 覆盖（键盘模式的连接不录音不计费，保留其展示模式），并按连接重推 settings
  //（手机端据此把输入模式切换器跳到「本地」）。
  onAutoDowngrade: () => {
    for (const wss of allWss) {
      for (const client of wss.clients) {
        if (client.sessionSvc && client.sessionSvc.providerOverride === 'bailian') {
          client.sessionSvc.setInputMode(null)
        }
        if (client.readyState === 1 /* OPEN */) client.send(settingsPayloadFor(client))
      }
    }
  },
})


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
    const { getMode, ...rest } = d // getMode 是函数访问器，取值后剔除，避免随 payload 下发
    return {
      ...rest,
      name: d.name || (known && known.name) || '',
      platform: d.platform || (known && known.platform) || '未知设备',
      mode: getMode ? getMode() : null, // 该连接当前的输入模式：cloud / local / keyboard
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
        <img src="${appQr}" alt="Vocifly 使用二维码"/>
        <p>已配置过证书的手机扫这里</p>
      </div>
      <div>
        <h2>首次配置</h2>
        ${setupQr ? `<img src="${setupQr}" alt="Vocifly 证书二维码"/>` : ''}
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
      <img src="${appQr}" alt="Vocifly 开发二维码"/>
      <p>当前没有启用 HTTPS，手机浏览器无法调用麦克风。</p>
      <small>${ctx.certReason || '请先运行 npm run setup:https'}</small>
    </section>`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>Vocifly</title>
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
      <h1>Vocifly</h1>
      <p>把手机变成 Mac 的语音输入麦克风</p>
    </div>
    <a class="settings" href="/control">控制面板</a>
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
    <p class="usage-note">默认引擎 <strong id="providerName">—</strong>（各手机可在对话页单独切换），单价 ¥<span id="pricePerSecond">0.000330</span>/秒，按音频时长计费。</p>
  </section>

  <script>
    async function loadUsage() {
      try {
        const res = await fetch('/api/stats', { cache: 'no-store' })
        if (!res.ok) return
        const s = await res.json()
        document.getElementById('providerName').textContent = s.provider === 'bailian' ? '阿里云百炼（云端）' : 'sherpa（本地，免费）'
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

const CONTROL_PATHS = ['/mac', '/control', '/api/settings', '/api/stats', '/api/mac', '/api/app-quit', '/api/devices', '/api/export', '/api/logs', '/api/pair/rotate', '/api/login-item', '/api/model/status', '/api/model/download']

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


// 云端识别是否就绪（只认百炼 API Key 是否填写）。
function cloudAvailable() {
  return !!(config.asr && config.asr.bailian && config.asr.bailian.apiKey)
}

// 某个 provider 是否可用：bailian 看 Key，sherpa 看离线模型文件。供 SessionService 在 start
// 时 fail-fast（手机端点了「说话」却两者都缺时，立即回弹框而非等结束才报错）。
function providerAvailable(provider) {
  return provider === 'bailian' ? cloudAvailable() : modelDownload.isModelAvailable()
}

// 组装一条 settings 消息。vad/provider 按连接计算：手机端「云端/本地」输入模式是
// 每连接覆盖（ws.sessionSvc.effectiveProvider()），无会话（或未鉴权连接）时回退全局。
function settingsPayloadFor(client, settings) {
  const provider = (client && client.sessionSvc) ? client.sessionSvc.effectiveProvider() : config.asr.provider
  const trackpad = (settings && settings.trackpad) || config.trackpad
  // defaultInputMode：新手机（无本地偏好）默认进入的输入模式；compose：键盘通路参数（附件上限等）。
  // optimize：优化模板只下发 {id,name}（手机端选择器用），提示词正文不出 Mac，按 promptId 回传。
  // availability：手机端据此在「说话」前拦截不可用模式并弹框说明原因，避免先开麦再报错。
  const optPool = (config.optimize && Array.isArray(config.optimize.pool)) ? config.optimize.pool : []
  return JSON.stringify({
    type: 'settings',
    trackpad,
    vad: effectiveVad(provider),
    provider,
    defaultInputMode: config.defaultInputMode,
    compose: config.compose,
    availability: { cloud: cloudAvailable(), offline: modelDownload.isModelAvailable() },
    optimize: {
      defaultId: config.optimize && config.optimize.defaultId,
      pool: optPool.map((e) => ({ id: e.id, name: e.name })),
    },
  })
}

// 把触控板 + VAD 配置推给所有手机端：控制面板保存后，正在连接的手机立即生效（无需刷新重连）。
function broadcastSettings(settings, ctx) {
  const servers = []
  if (ctx) {
    if (ctx.wss) servers.push(ctx.wss)
    if (ctx.httpWss) servers.push(ctx.httpWss)
  }
  for (const wss of servers) {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(settingsPayloadFor(client, settings))
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

// 进程内入口（如托盘菜单直接改 provider）改了全局配置后调用：
// 向所有在线手机按连接重推 settings，跟随全局的手机即时生效。
function broadcastSettingsToAll() {
  for (const wss of allWss) {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(settingsPayloadFor(client))
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
      const settings = getSettings()
      // 环境变量（VOCIFLY_*_PORT）覆盖端口时，向面板报告实际生效端口（env > config > 默认），
      // 避免显示值与实际监听端口不一致。
      settings.httpPort = resolveHttpPort()
      settings.httpsPort = resolveHttpsPort()
      res.end(JSON.stringify(settings))
    } else if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const beforeHttp = resolveHttpPort()
        const beforeHttps = resolveHttpsPort()
        const settings = saveSettings(body)
        const portChanged = resolveHttpPort() !== beforeHttp || resolveHttpsPort() !== beforeHttps
        // 触控板/延时等配置改动后实时推给在线手机端，下次操作立即生效
        broadcastSettings(settings, ctx)
        // 手动保存配置视为一次“重新决策”，清除自动降级标记（下一次识别会按新预算重新评估）
        if (usage.resetAutoDowngraded()) { log('server', '已手动保存配置，重置费用自动降级标记') }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, settings, portChanged }))
        // 端口变了：稍等本请求响应完成后，再让主进程重启服务监听新端口
        if (portChanged && ctx.onServicesChanged) {
          log('server', `端口已修改，安排重启服务: http=${resolveHttpPort()} https=${resolveHttpsPort()}`)
          setTimeout(() => ctx.onServicesChanged(), 150)
        }
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

  // 开机自启：读取/切换 macOS 登录项。主进程通过 ctx 回调执行 Electron API（本面板仅 loopback）。
  if (urlPath === '/api/login-item') {
    if (req.method === 'GET') {
      const state = ctx.getLaunchAtLoginState ? ctx.getLaunchAtLoginState() : false
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, launchAtLogin: state }))
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        // enable 允许只传 true/false；接口统一校验成布尔
        const enable = body ? !!body.launchAtLogin : false
        const result = ctx.onLaunchAtLogin ? ctx.onLaunchAtLogin(enable) : { ok: false, error: '主进程未提供开机自启回调' }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(result))
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

  if (urlPath === '/api/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(usage.getUsageStats()))
    return true
  }

  // 离线模型：状态查询（面板轮询进度）+ 触发下载（后台异步，立即返回 running 状态）。
  if (urlPath === '/api/model/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(modelDownload.getDownloadState()))
    return true
  }
  if (urlPath === '/api/model/download' && req.method === 'POST') {
    // fire-and-forget：downloadModel 内部同步置 running，立即回报状态；进度由面板轮询 status。
    modelDownload.downloadModel().catch((error) => log('model', `下载启动异常: ${error.message}`))
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(modelDownload.getDownloadState()))
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
    // 一次性配对码 + 剩余秒数：手机在首次配置页输入。控制面板按 pairCode/pairExpiresIn 读取。
    // 只取一次，避免按过期边界取到两个码（极少见但没必要）。getCode 会惰性生成/续期同一码。
    const pair = pairing.getCode()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({
      phoneUrl,
      setupUrl: ctx.setupUrl || '',
      appUrl: ctx.url || '',
      isSecure: !!ctx.isSecure,
      certReason: ctx.certReason || '',
      appQr,
      setupQr,
      pairCode: pair.code,
      pairExpiresIn: pair.expiresInSec,
    }))
    return true
  }

  if (urlPath === '/api/pair/rotate' && req.method === 'POST') {
    pairing.rotateCode()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, ...pairing.getCode() }))
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

  return true
}

// /api/pair：手机在首次配置页输入一次性配对码，换取持久授权令牌。
// 手机可达（非 loopback），所以挂在 serveApp（强制 HTTP 模式）与 serveCertificateSetup（证书模式 HTTP_PORT）两边，
// 不放进 CONTROL_PATHS（那里会强制 loopback）。
async function handlePairRequest(req, res, ctx) {
  if (req.url.split('?')[0] !== '/api/pair') return false
  // 非 POST（如 GET）此前直接 return false，而调用方已无条件 return，导致连接挂起无响应；这里显式回 405 结束请求。
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'POST' })
    res.end(JSON.stringify({ ok: false, error: '仅支持 POST 请求' }))
    return true
  }
  try {
    const body = await readJsonBody(req)
    const result = pairing.useCode(body && body.code)
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(result))
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: '无效请求: ' + error.message }))
  }
  return true
}

function serveApp(req, res, ctx) {
  const urlPath = req.url.split('?')[0]
  if (urlPath === '/api/pair') {
    handlePairRequest(req, res, ctx).catch((error) => log('server', '/api/pair 失败:', error.message))
    return
  }
  if (urlPath === '/api/health') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    // 仅在发起方 Origin 在白名单内时才反射 CORS；同源请求（控制面板）不携带 Origin，无需处理。
    const origin = req.headers.origin
    if (origin && isAllowedHealthOrigin(origin, ctx)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify({ ok: true, service: 'vocifly' }))
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
  // 把 HTTP 设置页端口注入 app.js（window.VOCIFLY_SETUP_PORT），避免写死端口（默认 9898，可在控制面板改，可被 VOCIFLY_HTTP_PORT 覆盖）。
  // 手机端语音页在同一台 serveApp 上加载 app.js，注入的 window.VOCIFLY_SETUP_PORT 同样生效。
  if (filePath === '/app.js') {
    const content = `window.VOCIFLY_SETUP_PORT = ${ctx.httpPort};\n` + fs.readFileSync(file, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      // 禁缓存：前端迭代期 Safari 可能拿旧 JS，导致代码改了却不生效
      'Cache-Control': 'no-store',
    })
    res.end(content)
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
  <title>Vocifly 首次配置</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, "PingFang SC", sans-serif; background: #f7f7f8; color: #202124; line-height: 1.6; min-height: 100dvh; }
    .container { max-width: 480px; margin: 0 auto; padding: 32px 24px 48px; }

    .progress { display: flex; align-items: center; justify-content: center; margin-bottom: 36px; }
    .progress-dot { width: 36px; height: 36px; border-radius: 50%; background: #e0e0e0; color: #999; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; transition: all .3s ease; flex-shrink: 0; }
    .progress-dot.active { background: #2563eb; color: #fff; box-shadow: 0 0 0 4px rgba(37,99,235,.2); }
    .progress-dot.done { background: #16a34a; color: #fff; }
    .progress-dot.done::after { content: '✓'; font-size: 18px; }
    .progress-dot.done span { display: none; }
    .progress-line { width: 48px; height: 3px; background: #e0e0e0; transition: background .3s ease; }
    .progress-line.done { background: #16a34a; }
    .progress-label { font-size: 12px; color: #999; text-align: center; margin-top: 6px; }
    .progress-label.active { color: #2563eb; font-weight: 600; }
    .progress-label.done { color: #16a34a; }

    .panel { display: none; animation: fadeIn .3s ease; }
    .panel.visible { display: block; }
    /* 倒计时浮层：固定悬浮在配置页上方，内容透出，不替换配置页 */
    #countdownPanel { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(247,247,248,.6); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); z-index: 60; }
    #countdownPanel.visible { display: flex; }
    #countdownPanel .countdown { background: #fff; border-radius: 20px; padding: 26px 40px; box-shadow: 0 12px 40px rgba(37,99,235,.14); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .panel h2 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
    .panel .subtitle { color: #666; font-size: 15px; margin-bottom: 24px; }

    .pair-input { width: 100%; padding: 14px; font-size: 28px; letter-spacing: 10px; text-align: center; border-radius: 12px; border: 2px solid #ddd; background: #fff; outline: none; transition: border-color .2s; }
    .pair-input:focus { border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,.12); }
    .pair-input::placeholder { font-size: 15px; letter-spacing: 0; color: #bbb; }

    .btn { display: block; width: 100%; padding: 15px 16px; border: 0; border-radius: 12px; font-size: 16px; font-weight: 650; cursor: pointer; text-align: center; text-decoration: none; touch-action: manipulation; transition: transform .1s, opacity .2s; }
    .btn:active { transform: scale(.97); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-dark { background: #202124; color: #fff; }
    .btn-green { background: #16a34a; color: #fff; }

    .status { margin-top: 12px; padding: 12px 14px; border-radius: 10px; font-size: 14px; background: #f0f0f0; color: #666; }
    .status.success { background: #e8f5ee; color: #137333; }
    .status.error { background: #fce8e6; color: #c5221f; }

    .cert-steps { margin: 20px 0; }
    .cert-step { display: flex; gap: 14px; padding: 14px 0; }
    .cert-step + .cert-step { border-top: 1px solid #eee; }
    .cert-num { width: 28px; height: 28px; border-radius: 50%; background: #202124; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
    .cert-step-content strong { display: block; font-size: 15px; margin-bottom: 2px; }
    .cert-step-content p { font-size: 14px; color: #666; }
    .path { display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 6px; background: #eceff1; font-size: 13px; color: #333; }
    .note { font-size: 13px; color: #999; margin-top: 20px; }
    .note a { color: #2563eb; }

    /* 倒计时过渡 */
    .countdown { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 32px 0; }
    .countdown-check { font-size: 48px; color: #16a34a; }
    .countdown-text { font-size: 16px; color: #666; }
    .countdown-ring { position: relative; width: 64px; height: 64px; }
    .countdown-ring svg { transform: rotate(-90deg); }
    .countdown-ring circle { fill: none; stroke-width: 4; }
    .countdown-ring .bg { stroke: #e0e0e0; }
    .countdown-ring .fg { stroke: #2563eb; stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
    .countdown-num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; color: #2563eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="progress">
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="progress-dot active" id="prog1"><span>1</span></div>
        <div class="progress-label active" id="progLabel1">配对</div>
      </div>
      <div class="progress-line" id="progLine1"></div>
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="progress-dot" id="prog2"><span>2</span></div>
        <div class="progress-label" id="progLabel2">证书</div>
      </div>
      <div class="progress-line" id="progLine2"></div>
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="progress-dot" id="prog3"><span>3</span></div>
        <div class="progress-label" id="progLabel3">进入</div>
      </div>
    </div>

    <div class="panel visible" id="step1">
      <h2>输入配对码</h2>
      <p class="subtitle">打开 Mac 上 Vocifly 的「接入设备」面板，查看 6 位配对码</p>
      <input class="pair-input" id="pairCode" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]*" placeholder="6 位数字" autocomplete="one-time-code"/>
      <button class="btn btn-primary" id="pairBtn" style="margin-top:16px">验证配对码</button>
      <div class="status" id="pairStatus">输入 Mac 上显示的 6 位配对码</div>
    </div>

    <div class="panel" id="step2">
      <h2>安装证书</h2>
      <p class="subtitle">需要安装本地证书才能使用麦克风，只需一次</p>
      <div class="cert-steps">
        <div class="cert-step">
          <span class="cert-num">1</span>
          <div class="cert-step-content">
            <strong>下载描述文件</strong>
            <p>Safari 会提示下载配置描述文件，点"允许"</p>
          </div>
        </div>
        <div class="cert-step">
          <span class="cert-num">2</span>
          <div class="cert-step-content">
            <strong>安装描述文件</strong>
            <span class="path">设置 → 通用 → VPN 与设备管理</span>
            <p>找到 <strong>Vocifly 本地证书</strong>，点进去安装</p>
          </div>
        </div>
        <div class="cert-step">
          <span class="cert-num">3</span>
          <div class="cert-step-content">
            <strong>信任根证书</strong>
            <span class="path">设置 → 通用 → 关于本机 → 证书信任设置</span>
            <p>启用 <strong>Vocifly 本地根证书</strong> 开关</p>
          </div>
        </div>
      </div>
      <a class="btn btn-primary" href="/phvoice-ca.mobileconfig">下载描述文件</a>
      <button class="btn btn-dark" id="verifyBtn" style="margin-top:10px">我已完成安装，验证</button>
      <div class="status" id="certStatus">完成上面三步后，点击验证</div>
      <p class="note">没看到描述文件？<a href="/phvoice-ca.pem">下载 PEM 备用文件</a></p>
    </div>

    <div class="panel" id="step3">
      <h2>准备就绪</h2>
      <p class="subtitle">配对和证书都已完成</p>
      <a class="btn btn-green" id="openApp" href="#">进入 Vocifly</a>
    </div>

    <!-- 倒计时过渡面板（复用） -->
    <div class="panel" id="countdownPanel">
      <div class="countdown">
        <div class="countdown-check">✓</div>
        <div class="countdown-text" id="countdownText"></div>
        <div class="countdown-ring">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle class="bg" cx="32" cy="32" r="28"/>
            <circle class="fg" id="countdownCircle" cx="32" cy="32" r="28" stroke-dasharray="175.93" stroke-dashoffset="0"/>
          </svg>
          <div class="countdown-num" id="countdownNum">3</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var appUrl = ${appUrlLiteral}
    var ipUrl = ${ipUrlLiteral}
    var pairToken = null
    var CIRC = 2 * Math.PI * 28

    function setProgress(n) {
      for (var i = 1; i <= 3; i++) {
        var dot = document.getElementById('prog' + i)
        var label = document.getElementById('progLabel' + i)
        dot.className = 'progress-dot' + (i < n ? ' done' : i === n ? ' active' : '')
        label.className = 'progress-label' + (i < n ? ' done' : i === n ? ' active' : '')
        if (i < 3) document.getElementById('progLine' + i).className = 'progress-line' + (i < n ? ' done' : '')
      }
    }

    function showPanel(id) {
      var panels = document.querySelectorAll('.panel')
      for (var i = 0; i < panels.length; i++) panels[i].classList.remove('visible')
      document.getElementById(id).classList.add('visible')
    }

    function countdown(seconds, text, onDone) {
      // 防重入：自动探测/配对/证书检查/手动验证等触发点可能在 3 秒窗口内先后到来，
      // 共用一个 #countdownPanel/#countdownNum/#countdownCircle。若已有倒计时在跑，
      // 先清掉旧的，避免数字跳变、圆环闪烁、onDone 重复执行（重复跳转/导航）。
      if (countdown._iv) { clearInterval(countdown._iv); countdown._iv = null }
      var cd = document.getElementById('countdownPanel')
      var num = document.getElementById('countdownNum')
      var circle = document.getElementById('countdownCircle')
      var txt = document.getElementById('countdownText')
      txt.textContent = text
      num.textContent = seconds
      circle.style.strokeDashoffset = '0'
      // 倒计时作为浮层叠在当前配置页上方，不隐藏配置内容：让步骤「停在页面上」等 3 秒
      cd.classList.add('visible')
      var remaining = seconds
      countdown._iv = setInterval(function () {
        remaining--
        if (remaining <= 0) {
          clearInterval(countdown._iv); countdown._iv = null
          cd.classList.remove('visible')
          onDone()
          return
        }
        num.textContent = remaining
        circle.style.strokeDashoffset = String(CIRC * (1 - remaining / seconds))
      }, 1000)
    }

    function enterApp() {
      var href = document.getElementById('openApp').href
      if (href && href !== '#') location.href = href
    }

    function goStep(n) {
      setProgress(n)
      showPanel('step' + n)
      if (n === 3) {
        // 步骤 3「进入」：同样停 3 秒后自动进入触控板页面（按钮仍可手动点）
        document.getElementById('openApp').href = (ipUrl || appUrl) + (pairToken ? '#token=' + encodeURIComponent(pairToken) : '')
        countdown(3, '准备就绪，即将进入 Vocifly', enterApp)
      }
    }

    // 启动：探测证书是否已信任
    ;(function () {
      var target = ipUrl || appUrl
      var ctrl = new AbortController()
      var t = setTimeout(function () { ctrl.abort() }, 3000)
      fetch(target + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); if (r.ok) { setProgress(3); countdown(3, '检测到配置已完成，即将进入 Vocifly', function () { location.href = target }) } })
        .catch(function () { clearTimeout(t) })
    })()

    // 步骤 1：配对
    var pairBtn = document.getElementById('pairBtn')
    var pairInput = document.getElementById('pairCode')
    var pairStatus = document.getElementById('pairStatus')
    pairInput.addEventListener('input', function () { this.value = this.value.replace(/\\D/g, '').slice(0, 6) })
    pairInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair() })
    pairBtn.addEventListener('click', doPair)
    function doPair() {
      var code = pairInput.value.trim()
      if (!/^[0-9]{6}$/.test(code)) { pairStatus.className = 'status error'; pairStatus.textContent = '请输入 6 位数字'; return }
      pairBtn.disabled = true
      pairStatus.className = 'status'
      pairStatus.textContent = '验证中…'
      fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (data.ok && data.token) {
            pairToken = data.token
            pairStatus.className = 'status success'
            pairStatus.textContent = '配对成功 ✓'
            countdown(3, '配对成功，即将进入下一步', function () { goStep(2); checkCert() })
          } else {
            pairStatus.className = 'status error'
            pairStatus.textContent = data.error === 'code_invalid' ? '配对码不正确或已过期' : (data.message || data.error || '配对失败')
            pairInput.value = ''
            pairInput.focus()
          }
        })
        .catch(function (e) {
          pairStatus.className = 'status error'
          pairStatus.textContent = '网络错误：' + e.message
        })
        .finally(function () { pairBtn.disabled = false })
    }

    // 步骤 2：检查证书 + 验证
    function checkCert() {
      var target = ipUrl || appUrl
      var ctrl = new AbortController()
      var t = setTimeout(function () { ctrl.abort() }, 4000)
      fetch(target + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); if (r.ok) return { ok: true }; return { ok: false } })
        .catch(function () { clearTimeout(t); return { ok: false } })
        .then(function (result) {
          if (result.ok) {
            var certStatus = document.getElementById('certStatus')
            certStatus.className = 'status success'
            certStatus.textContent = '证书已安装 ✓'
            document.getElementById('openApp').href = (ipUrl || appUrl) + (pairToken ? '#token=' + encodeURIComponent(pairToken) : '')
            countdown(3, '证书已就绪，即将进入 Vocifly', function () { goStep(3) })
          }
        })
    }

    var verifyBtn = document.getElementById('verifyBtn')
    var certStatus = document.getElementById('certStatus')
    verifyBtn.addEventListener('click', function () {
      verifyBtn.disabled = true
      certStatus.className = 'status'
      certStatus.textContent = '正在验证…'
      var target = ipUrl || appUrl
      var ctrl = new AbortController()
      var t = setTimeout(function () { ctrl.abort() }, 6000)
      fetch(target + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); return r.ok ? { ok: true } : { ok: false, reason: 'HTTP ' + r.status } })
        .catch(function () { clearTimeout(t); return { ok: false, reason: '连接失败' } })
        .then(function (result) {
          if (result.ok) {
            certStatus.className = 'status success'
            certStatus.textContent = '证书验证通过 ✓'
            document.getElementById('openApp').href = (ipUrl || appUrl) + (pairToken ? '#token=' + encodeURIComponent(pairToken) : '')
            countdown(3, '证书验证通过，即将进入 Vocifly', function () { goStep(3) })
          } else {
            certStatus.className = 'status error'
            certStatus.textContent = '验证失败（' + result.reason + '）。请确认描述文件已安装并信任。'
          }
          verifyBtn.disabled = false
        })
    })
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
  <title>Vocifly 首次配置</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, "PingFang SC", sans-serif; background: #f7f7f8; color: #202124; line-height: 1.6; min-height: 100dvh; }
    .container { max-width: 480px; margin: 0 auto; padding: 32px 24px 48px; }

    .progress { display: flex; align-items: center; justify-content: center; margin-bottom: 36px; }
    .progress-dot { width: 36px; height: 36px; border-radius: 50%; background: #e0e0e0; color: #999; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; transition: all .3s ease; flex-shrink: 0; }
    .progress-dot.active { background: #2563eb; color: #fff; box-shadow: 0 0 0 4px rgba(37,99,235,.2); }
    .progress-dot.done { background: #16a34a; color: #fff; }
    .progress-dot.done::after { content: '✓'; font-size: 18px; }
    .progress-dot.done span { display: none; }
    .progress-line { width: 48px; height: 3px; background: #e0e0e0; transition: background .3s ease; }
    .progress-line.done { background: #16a34a; }
    .progress-label { font-size: 12px; color: #999; text-align: center; margin-top: 6px; }
    .progress-label.active { color: #2563eb; font-weight: 600; }
    .progress-label.done { color: #16a34a; }

    .panel { display: none; animation: fadeIn .3s ease; }
    .panel.visible { display: block; }
    /* 倒计时浮层：固定悬浮在配置页上方，内容透出，不替换配置页 */
    #countdownPanel { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(247,247,248,.6); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); z-index: 60; }
    #countdownPanel.visible { display: flex; }
    #countdownPanel .countdown { background: #fff; border-radius: 20px; padding: 26px 40px; box-shadow: 0 12px 40px rgba(37,99,235,.14); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .panel h2 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
    .panel .subtitle { color: #666; font-size: 15px; margin-bottom: 24px; }

    .pair-input { width: 100%; padding: 14px; font-size: 28px; letter-spacing: 10px; text-align: center; border-radius: 12px; border: 2px solid #ddd; background: #fff; outline: none; transition: border-color .2s; }
    .pair-input:focus { border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,.12); }
    .pair-input::placeholder { font-size: 15px; letter-spacing: 0; color: #bbb; }

    .btn { display: block; width: 100%; padding: 15px 16px; border: 0; border-radius: 12px; font-size: 16px; font-weight: 650; cursor: pointer; text-align: center; text-decoration: none; touch-action: manipulation; transition: transform .1s, opacity .2s; }
    .btn:active { transform: scale(.97); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-dark { background: #202124; color: #fff; }
    .btn-green { background: #16a34a; color: #fff; }

    .status { margin-top: 12px; padding: 12px 14px; border-radius: 10px; font-size: 14px; background: #f0f0f0; color: #666; white-space: pre-wrap; word-break: break-word; }
    .status.success { background: #e8f5ee; color: #137333; }
    .status.error { background: #fce8e6; color: #c5221f; }
    .status.warn { background: #fff7e6; color: #7a5a00; }

    .callout { margin: 0 0 20px; padding: 12px 14px; border-radius: 10px; background: #fff7e6; border: 1px solid #f2c94c; color: #7a5a00; font-size: 14px; }
    .callout strong { color: #4a3200; }

    .cert-steps { margin: 20px 0; }
    .cert-step { display: flex; gap: 14px; padding: 14px 0; }
    .cert-step + .cert-step { border-top: 1px solid #eee; }
    .cert-num { width: 28px; height: 28px; border-radius: 50%; background: #202124; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
    .cert-step-content strong { display: block; font-size: 15px; margin-bottom: 2px; }
    .cert-step-content p { font-size: 14px; color: #666; }
    .path { display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 6px; background: #eceff1; font-size: 13px; color: #333; }
    .note { font-size: 13px; color: #999; margin-top: 20px; }
    .note a { color: #2563eb; }

    .countdown { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 32px 0; }
    .countdown-check { font-size: 48px; color: #16a34a; }
    .countdown-text { font-size: 16px; color: #666; }
    .countdown-ring { position: relative; width: 64px; height: 64px; }
    .countdown-ring svg { transform: rotate(-90deg); }
    .countdown-ring circle { fill: none; stroke-width: 4; }
    .countdown-ring .bg { stroke: #e0e0e0; }
    .countdown-ring .fg { stroke: #2563eb; stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
    .countdown-num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; color: #2563eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="progress">
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="progress-dot active" id="prog1"><span>1</span></div>
        <div class="progress-label active" id="progLabel1">配对</div>
      </div>
      <div class="progress-line" id="progLine1"></div>
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="progress-dot" id="prog2"><span>2</span></div>
        <div class="progress-label" id="progLabel2">证书</div>
      </div>
      <div class="progress-line" id="progLine2"></div>
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="progress-dot" id="prog3"><span>3</span></div>
        <div class="progress-label" id="progLabel3">进入</div>
      </div>
    </div>

    <div class="panel visible" id="step1">
      <h2>输入配对码</h2>
      <p class="subtitle">打开 Mac 上 Vocifly 的「接入设备」面板，查看 6 位配对码</p>
      <input class="pair-input" id="pairCode" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]*" placeholder="6 位数字" autocomplete="one-time-code"/>
      <button class="btn btn-primary" id="pairBtn" style="margin-top:16px">验证配对码</button>
      <div class="status" id="pairStatus">输入 Mac 上显示的 6 位配对码</div>
    </div>

    <div class="panel" id="step2">
      <h2>安装证书</h2>
      <p class="subtitle">需要安装本地证书才能使用麦克风，只需一次</p>
      <div class="callout">
        <strong>请用 Chrome 浏览器完成此步骤。</strong> 部分国产浏览器不信任用户 CA 证书，会导致验证失败。
      </div>
      <div class="cert-steps">
        <div class="cert-step">
          <span class="cert-num">1</span>
          <div class="cert-step-content">
            <strong>下载 CA 证书</strong>
            <p>点击下方按钮，浏览器会下载 phvoice-ca.crt</p>
          </div>
        </div>
        <div class="cert-step">
          <span class="cert-num">2</span>
          <div class="cert-step-content">
            <strong>安装为 CA 证书</strong>
            <span class="path">设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书</span>
            <p>务必选择 <strong>"CA 证书"</strong>，不要选"VPN 和应用用户证书"</p>
          </div>
        </div>
        <div class="cert-step">
          <span class="cert-num">3</span>
          <div class="cert-step-content">
            <strong>选择 phvoice-ca.crt</strong>
            <p>在"下载"目录找到文件并打开，提示风险时选"仍然安装"</p>
          </div>
        </div>
        <div class="cert-step">
          <span class="cert-num">4</span>
          <div class="cert-step-content">
            <strong>确认信任</strong>
            <span class="path">设置 → 加密与凭据 → 受信任的凭据 → 用户</span>
            <p>应能看到 “mkcert …” 证书且开关已开</p>
          </div>
        </div>
      </div>
      <a class="btn btn-primary" href="/phvoice-ca.crt">下载 CA 证书</a>
      <button class="btn btn-dark" id="verifyBtn" style="margin-top:10px">我已完成安装，验证</button>
      <div class="status" id="certStatus">完成上面步骤后，点击验证</div>
      <p class="note">格式无效？<a href="/phvoice-ca.pem">下载 PEM 备用文件</a> 并重命名为 .cer</p>
    </div>

    <div class="panel" id="step3">
      <h2>准备就绪</h2>
      <p class="subtitle">配对和证书都已完成</p>
      <a class="btn btn-green" id="openApp" href="#">进入 Vocifly</a>
    </div>

    <div class="panel" id="countdownPanel">
      <div class="countdown">
        <div class="countdown-check">✓</div>
        <div class="countdown-text" id="countdownText"></div>
        <div class="countdown-ring">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle class="bg" cx="32" cy="32" r="28"/>
            <circle class="fg" id="countdownCircle" cx="32" cy="32" r="28" stroke-dasharray="175.93" stroke-dashoffset="0"/>
          </svg>
          <div class="countdown-num" id="countdownNum">3</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var appUrl = ${appUrlLiteral}
    var ipUrl = ${ipUrlLiteral}
    var pairToken = null
    var CIRC = 2 * Math.PI * 28

    function setProgress(n) {
      for (var i = 1; i <= 3; i++) {
        var dot = document.getElementById('prog' + i)
        var label = document.getElementById('progLabel' + i)
        dot.className = 'progress-dot' + (i < n ? ' done' : i === n ? ' active' : '')
        label.className = 'progress-label' + (i < n ? ' done' : i === n ? ' active' : '')
        if (i < 3) document.getElementById('progLine' + i).className = 'progress-line' + (i < n ? ' done' : '')
      }
    }

    function showPanel(id) {
      var panels = document.querySelectorAll('.panel')
      for (var i = 0; i < panels.length; i++) panels[i].classList.remove('visible')
      document.getElementById(id).classList.add('visible')
    }

    function countdown(seconds, text, onDone) {
      // 防重入：自动探测/配对/证书检查/手动验证等触发点可能在 3 秒窗口内先后到来，
      // 共用一个 #countdownPanel/#countdownNum/#countdownCircle。若已有倒计时在跑，
      // 先清掉旧的，避免数字跳变、圆环闪烁、onDone 重复执行（重复跳转/导航）。
      if (countdown._iv) { clearInterval(countdown._iv); countdown._iv = null }
      var cd = document.getElementById('countdownPanel')
      var num = document.getElementById('countdownNum')
      var circle = document.getElementById('countdownCircle')
      var txt = document.getElementById('countdownText')
      txt.textContent = text
      num.textContent = seconds
      circle.style.strokeDashoffset = '0'
      // 倒计时作为浮层叠在当前配置页上方，不隐藏配置内容：让步骤「停在页面上」等 3 秒
      cd.classList.add('visible')
      var remaining = seconds
      countdown._iv = setInterval(function () {
        remaining--
        if (remaining <= 0) {
          clearInterval(countdown._iv); countdown._iv = null
          cd.classList.remove('visible')
          onDone()
          return
        }
        num.textContent = remaining
        circle.style.strokeDashoffset = String(CIRC * (1 - remaining / seconds))
      }, 1000)
    }

    function enterApp() {
      var href = document.getElementById('openApp').href
      if (href && href !== '#') location.href = href
    }

    function goStep(n) {
      setProgress(n)
      showPanel('step' + n)
      if (n === 3) {
        // 步骤 3「进入」：同样停 3 秒后自动进入触控板页面（按钮仍可手动点）
        document.getElementById('openApp').href = (ipUrl || appUrl) + (pairToken ? '#token=' + encodeURIComponent(pairToken) : '')
        countdown(3, '准备就绪，即将进入 Vocifly', enterApp)
      }
    }

    // 启动：探测证书是否已信任
    ;(function () {
      var target = ipUrl || appUrl
      var ctrl = new AbortController()
      var t = setTimeout(function () { ctrl.abort() }, 3000)
      fetch(target + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); if (r.ok) { setProgress(3); countdown(3, '检测到配置已完成，即将进入 Vocifly', function () { location.href = target }) } })
        .catch(function () { clearTimeout(t) })
    })()

    // 步骤 1：配对
    var pairBtn = document.getElementById('pairBtn')
    var pairInput = document.getElementById('pairCode')
    var pairStatus = document.getElementById('pairStatus')
    pairInput.addEventListener('input', function () { this.value = this.value.replace(/\\D/g, '').slice(0, 6) })
    pairInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair() })
    pairBtn.addEventListener('click', doPair)
    function doPair() {
      var code = pairInput.value.trim()
      if (!/^[0-9]{6}$/.test(code)) { pairStatus.className = 'status error'; pairStatus.textContent = '请输入 6 位数字'; return }
      pairBtn.disabled = true
      pairStatus.className = 'status'
      pairStatus.textContent = '验证中…'
      fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (data.ok && data.token) {
            pairToken = data.token
            pairStatus.className = 'status success'
            pairStatus.textContent = '配对成功 ✓'
            countdown(3, '配对成功，即将进入下一步', function () { goStep(2); checkCert() })
          } else {
            pairStatus.className = 'status error'
            pairStatus.textContent = data.error === 'code_invalid' ? '配对码不正确或已过期' : (data.message || data.error || '配对失败')
            pairInput.value = ''
            pairInput.focus()
          }
        })
        .catch(function (e) {
          pairStatus.className = 'status error'
          pairStatus.textContent = '网络错误：' + e.message
        })
        .finally(function () { pairBtn.disabled = false })
    }

    // 步骤 2：检查证书 + 验证
    function checkCert() {
      var target = ipUrl || appUrl
      var ctrl = new AbortController()
      var t = setTimeout(function () { ctrl.abort() }, 4000)
      fetch(target + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); if (r.ok) return { ok: true }; return { ok: false } })
        .catch(function () { clearTimeout(t); return { ok: false } })
        .then(function (result) {
          if (result.ok) {
            var certStatus = document.getElementById('certStatus')
            certStatus.className = 'status success'
            certStatus.textContent = '证书已安装 ✓'
            document.getElementById('openApp').href = (ipUrl || appUrl) + (pairToken ? '#token=' + encodeURIComponent(pairToken) : '')
            countdown(3, '证书已就绪，即将进入 Vocifly', function () { goStep(3) })
          }
        })
    }

    var verifyBtn = document.getElementById('verifyBtn')
    var certStatus = document.getElementById('certStatus')
    verifyBtn.addEventListener('click', function () {
      verifyBtn.disabled = true
      certStatus.className = 'status'
      certStatus.textContent = '正在验证…'
      var target = ipUrl || appUrl
      var ctrl = new AbortController()
      var start = performance.now()
      var t = setTimeout(function () { ctrl.abort() }, 6000)
      fetch(target + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); return r.ok ? { ok: true } : { ok: false, reason: 'HTTP ' + r.status } })
        .catch(function (e) {
          clearTimeout(t)
          var elapsed = Math.round(performance.now() - start)
          if (e.name === 'AbortError') return { ok: false, reason: '超时' }
          return { ok: false, reason: elapsed < 2000 ? '证书未被信任（请用 Chrome）' : '连接失败' }
        })
        .then(function (result) {
          if (result.ok) {
            certStatus.className = 'status success'
            certStatus.textContent = '证书验证通过 ✓'
            document.getElementById('openApp').href = (ipUrl || appUrl) + (pairToken ? '#token=' + encodeURIComponent(pairToken) : '')
            countdown(3, '证书验证通过，即将进入 Vocifly', function () { goStep(3) })
          } else {
            certStatus.className = 'status error'
            certStatus.textContent = '验证失败：' + result.reason + '\\n请确认用 Chrome 打开、证书安装在 CA 证书类型、且受信任凭据中已启用。'
          }
          verifyBtn.disabled = false
        })
    })
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
    if (urlPath === '/api/pair') {
      handlePairRequest(req, res, ctx).catch((error) => log('server', '/api/pair 失败:', error.message))
      return
    }
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
    optimize, // OptimizePort：百炼 qwen 文字优化（纠错/润色/换语气）
    appList, // 前台应用枚举（平台面板数据源）
    usage, // 用量/计费统计
    config,
    log,
    enablePaste: ENABLE_PASTE,
  }
}

function attachWebSocket(server, onStatus, deps) {
  // Interface 层依赖注入：端口默认由组合根提供，测试可用 mock 覆盖 createServer 的 deps。
  const { asr, paster, appList, usage, optimize, config, log, enablePaste } = deps
  const wss = new WebSocketServer({ server, path: '/ws' })
  allWss.add(wss)
  let nextConnId = 1

  wss.on('connection', (ws, req) => {
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    const connId = nextConnId++
    let sessionSvc = null
    let wasConnected = false
    let rejected = false // 一旦预鉴权阶段判了拒绝，就不再允许任何帧（含后续赶到的 auth）再 authorize
    // 首帧鉴权：未配对/令牌无效的连接直接关闭，不建立会话、不收音频、不上屏、不控鼠标。
    const authTimer = setTimeout(() => {
      if (!wasConnected) {
        // 诊断：5s 没收到合法 auth 帧 → 大概率是手机端旧版缓存 app.js（首帧发的 identify 而非 auth）
        log('ws', `#${connId} 鉴权失败：5s 内未收到合法 auth 帧`)
        rejected = true
        ws.close(4001, 'unauthorized')
      }
    }, 5000)

    function authorize() {
      if (wasConnected) return
      wasConnected = true
      clearTimeout(authTimer)
      const peer = req.socket.remoteAddress
      const ua = req.headers['user-agent'] || ''
      devices.set(connId, { id: connId, deviceId: null, name: '', platform: classifyPlatform(ua), ip: peer, connectedAt: Date.now(), lastActiveAt: Date.now() })
      log('ws', `#${connId} 已配对设备已连接 (${peer})`)
      onStatus?.('connected')
      // 会话状态机与识别/上屏用例收敛到 Application 层（SessionService）。
      // Interface 层只做依赖注入 + socket 收发，不再直接操控会话状态。
      sessionSvc = new SessionService({
        asr,
        paster,
        usage,
        optimize,
        config,
        enablePaste: ENABLE_PASTE,
        log,
        emit: (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)) },
        connId,
        // 会话 start 前校验引擎可用性（bailian 看 Key / sherpa 看模型文件），两者都缺时 fail-fast。
        providerAvailable,
      })
      // 挂到 ws 上：broadcastSettings / 预算降级重推时按连接计算 vad/provider（云端/本地模式是每连接覆盖）。
      ws.sessionSvc = sessionSvc
      // 设备记录挂模式访问器：/api/devices 据此显示每台手机的输入模式（云端/本地/键盘）。
      // 函数属性不会被 JSON.stringify 序列化，getDevices 里会显式取值。
      const devEntry = devices.get(connId)
      if (devEntry) devEntry.getMode = () => sessionSvc.displayMode()
      // 手机端无法访问 /api/settings（控制面板仅 loopback），因此把触控板配置随连接下发。
      ws.send(settingsPayloadFor(ws))
    }

    ws.on('message', (data, isBinary) => {
      // 未鉴权：只接受 auth 帧；其它（含二进制音频）一律拒绝。
      if (!wasConnected) {
        if (rejected) return // 已判拒绝，后续帧忽略，避免半连接
        if (isBinary) { rejected = true; log('ws', `#${connId} 鉴权失败：首帧是二进制帧`); ws.close(4001, 'unauthorized'); return }
        let authMsg
        try { authMsg = JSON.parse(data.toString()) } catch { rejected = true; log('ws', `#${connId} 鉴权失败：首帧不是合法 JSON`); ws.close(4001, 'unauthorized'); return }
        if (authMsg.type === 'auth' && pairing.validateToken(authMsg.token)) {
          authorize()
        } else {
          // 诊断：区分「首帧不是 auth」(旧缓存JS) 与「令牌为空/无效」(origin 不匹配或未配对)
          const reason = authMsg.type !== 'auth'
            ? `首帧不是 auth(${authMsg.type})，疑似旧版缓存`
            : (authMsg.token ? '令牌无效' : '令牌为空，疑似源不匹配或未配对')
          rejected = true
          log('ws', `#${connId} 鉴权失败：${reason}`)
          ws.close(4001, 'unauthorized')
        }
        return
      }

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
      } else if (msg.type === 'inputMode') {
        // 手机端三种输入模式：云端(cloud→bailian)/本地(local→sherpa) 仅本连接生效，不改全局 config；
        // 键盘(keyboard) 不改 provider 覆盖，仅记录为展示模式（控制面板设备列表显示「键盘」）。
        sessionSvc.setInputMode(msg.mode)
        if (ws.readyState === WebSocket.OPEN) ws.send(settingsPayloadFor(ws))
      } else if (msg.type === 'send') {
        sessionSvc.send(msg)
      } else if (msg.type === 'repaste') {
        // 重新上屏：首次上屏贴错位置后，用户把 Mac 光标移到正确位置，重新粘贴最后一次结果。
        sessionSvc.repaste(msg)
      } else if (msg.type === 'delete') {
        sessionSvc.removeLast(msg)
      } else if (msg.type === 'optimize') {
        // 文字优化：对最近一条识别结果纠错/润色，删旧文 + 上优化文替换
        sessionSvc.optimize(msg)
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
        const action = ['expose', 'mission', 'launchpad', 'spacesLeft', 'spacesRight'].includes(msg.action) ? msg.action : 'mission'
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
        const sens = config.trackpad.scrollSensitivity
        paster.mouseScroll((msg.dx || 0) * sens, (msg.dy || 0) * sens)
      } else if (msg.type === 'log') {
        // 手机端关键事件上报，集中进同一个日志文件
        log(`phone#${connId}`, msg.scope || '-', msg.text || '')
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (sessionSvc) sessionSvc.dispose()
      log('ws', `#${connId} 连接断开`)
      devices.delete(connId)
      if (wasConnected) onStatus?.('disconnected')
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
  wss.on('close', () => {
    clearInterval(heartbeat)
    allWss.delete(wss) // 服务重启（端口/IP 变更）时从广播集合摘除，避免跨重启累积旧实例
  })

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

async function createServer({ onStatus, onQuit, deps, onServicesChanged, onLaunchAtLogin, getLaunchAtLoginState } = {}) {
  // 组合根：未显式注入时由 buildDeps() 装配真实实现；测试/替换可传 mock。
  // 注意：这三个回调由主进程传入，走顶层参数而不是 deps —— deps 是功能依赖（asr/paster 等），两者不能混。
  const { asr, paster, appList, usage, config, log, enablePaste } = deps || buildDeps()
  // 端口每次调用都重新解析：改端口→重启服务时能读到 config 里的新值，无需退出进程。
  const HTTP_PORT = resolveHttpPort()
  const HTTPS_PORT = resolveHttpsPort()
  log('server', `ASR provider: ${config.asr.provider}`)
  const lanIp = getLanIp() || '127.0.0.1'
  const localHostname = getLocalHostname()
  const forceHttp = process.env.VOCIFLY_FORCE_HTTP === '1'
  const cert = forceHttp ? { ok: false, reason: '已通过 VOCIFLY_FORCE_HTTP=1 强制使用 HTTP' } : ensureLocalCertificate()

  if (cert.ok) {
    const appUrl = `https://${localHostname}:${HTTPS_PORT}`
    const ipUrl = `https://${lanIp}:${HTTPS_PORT}`
    const setupUrl = `http://${lanIp}:${HTTP_PORT}`
    const ctx = { url: appUrl, ipUrl, setupUrl, isSecure: true, certReason: cert.reason, onQuit, httpPort: HTTP_PORT, httpsPort: HTTPS_PORT, onServicesChanged, onLaunchAtLogin, getLaunchAtLoginState }

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
  const ctx = { url, ipUrl: url, setupUrl: null, isSecure: false, certReason: cert.reason, onQuit, httpPort: HTTP_PORT, httpsPort: HTTPS_PORT, onServicesChanged, onLaunchAtLogin, getLaunchAtLoginState }
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
      log('server', `Vocifly 服务已启动: ${url}`)
      if (isSecure) log('server', `首次配置手机证书: ${setupUrl}`)
      else log('server', `当前是 HTTP 开发模式，手机浏览器无法调用麦克风。原因: ${cert.reason}`)
    })
    .catch((error) => {
      log('server', '启动失败:', error.message)
      process.exit(1)
    })
}

module.exports = { createServer, getLanIp, getLocalHostname, broadcastSettingsToAll }
