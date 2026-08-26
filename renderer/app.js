// PhVoice 手机端：点击说话开关 → PCM 流上行；partial 实时展示；再点结束
const statusEl = document.getElementById('status')
const partialEl = document.getElementById('partial')
const finalsEl = document.getElementById('finals')
const talkBtn = document.getElementById('talk')
const talkText = document.getElementById('talkText')
const enterBtn = document.getElementById('enterBtn')
const deleteBtn = document.getElementById('deleteBtn')
const deleteKeyBtn = document.getElementById('deleteKeyBtn')
const switcherBtn = document.getElementById('switcherBtn')
const switcherText = document.getElementById('switcherText')
const appTray = document.getElementById('appTray')
const appTrayOverlay = document.getElementById('appTrayOverlay')
const missionBtn = document.getElementById('missionBtn')
const launchpadBtn = document.getElementById('launchpadBtn')
const islandCloseBtn = document.getElementById('islandCloseBtn')
const mouseBtn = document.getElementById('mouseBtn')
const quitBtn = document.getElementById('quitBtn')
const recHint = document.getElementById('recHint')
const recHintText = document.getElementById('recHintText')
const resultArea = document.querySelector('.result-area')
const touchCanvas = document.getElementById('touchCanvas')
const touchCtx = touchCanvas ? touchCanvas.getContext('2d') : null
const trackpointEl = document.getElementById('trackpoint')
const trackpointBadgeEl = document.getElementById('trackpointBadge')
const toolsBtn = document.getElementById('toolsBtn')
const controlIsland = document.getElementById('controlIsland')
const mouseSub = document.getElementById('mouseSub')
const resultPanels = document.getElementById('resultPanels')
const panelDialog = document.getElementById('panelDialog')
const panelTrackpad = document.getElementById('panelTrackpad')
const edgeIndicators = panelTrackpad ? {
  up: panelTrackpad.querySelector('.edge-up'),
  down: panelTrackpad.querySelector('.edge-down'),
  left: panelTrackpad.querySelector('.edge-left'),
  right: panelTrackpad.querySelector('.edge-right'),
} : {}
const quitModal = document.getElementById('quitModal')
const quitCancel = document.getElementById('quitCancel')
const quitConfirm = document.getElementById('quitConfirm')
const quitModalTitle = document.getElementById('quitModalTitle')
const quitModalText = document.getElementById('quitModalText')
const optimizeModal = document.getElementById('optimizeModal')
const optimizeList = document.getElementById('optimizeList')
const optimizeCancel = document.getElementById('optimizeCancel')
const asrErrorModal = document.getElementById('asrErrorModal')
const asrErrorTitle = document.getElementById('asrErrorTitle')
const asrErrorText = document.getElementById('asrErrorText')
const asrErrorOk = document.getElementById('asrErrorOk')
const pageSwitch = document.getElementById('pageSwitch')
const rollerDots = document.getElementById('rollerDots')
const toastEl = document.getElementById('toast')
const inputModeSwitch = document.getElementById('inputModeSwitch')
const composer = document.getElementById('composer')
const composerChips = document.getElementById('composerChips')
const composerInput = document.getElementById('composerInput')
const composerAttach = document.getElementById('composerAttach')
const composerFile = document.getElementById('composerFile')
const composerSend = document.getElementById('composerSend')

let ws = null
let reconnectAttempt = 0
let heartbeatTimer = null
let heartbeatMissed = 0
let audioCtx = null
let mediaStream = null
let workletNode = null
let audioSourceNode = null // 当前 MediaStreamSource，停止时断开以复用预热管线
let audioWarm = false      // 识别模块与音频上下文已预载（折中方案）；麦克风按下时才打开
let holding = false   // 手指仍按住：作为“权限/音频初始化期间若松手则中止”的护栏
let recording = false // 真正在录音中：音频管线就绪且已给后端发 start，决定按钮颜色语义
let lastStartAt = 0   // 上次 startRecording 时间戳：iOS 偶发同一次 tap 派发两次 click，120ms 内防抖
let sentBytes = 0
let recordFromTrackpad = false
let lastFinalText = ''
let deleteArmed = false
let deleteArmTimer = null
let deleteKeyArmed = false
let deleteKeyArmTimer = null
let trayOpen = false
let trayMode = 'switch' // 'switch' | 'launch'
let composing = false
let composeAttachments = [] // { kind, name, mime, size, base64, previewUrl }
// 输入模式三态：cloud(云端·百炼在线ASR) / local(本地·SenseVoice离线ASR) / keyboard(手机输入法，走 compose 通路)。
// 云端/本地仅本手机生效（WS 通知 server 按连接覆盖 provider，不改全局 config）；键盘是纯前端状态。
const INPUT_MODE_KEY = 'phvoice-input-mode'
let inputMode = (function () { try { return localStorage.getItem(INPUT_MODE_KEY) || '' } catch (_) { return '' } })()
let settingsSeen = false // 连接后首个 settings：向 server 断言本机持久化模式；此后外部变更（控制面板/预算降级）以 server 为准
let serverProvider = ''  // 最近一次 settings 下发的本连接 provider（'bailian' | 'sherpa'）
let availability = { cloud: true, offline: true } // settings 下发的引擎可用性；点「说话」前据此拦截不可用模式
let optimizePool = []        // [{id, name}] 来自 settings 消息的 optimize.pool（优化模板选择器数据源）
let optimizeDefaultId = ''   // settings 消息的 optimize.defaultId
// 键盘（compose）上限：默认 5 个 / 单附件 20MB，收到服务端 settings 后用 config.compose 覆盖
let MAX_COMPOSE_FILES = 5
let MAX_COMPOSE_BYTES = 20 * 1024 * 1024
let currentFrontApp = null
let appListCache = []
let mouseMode = true
// 页面循环结构：往滚轮里追加页面名即可扩展（对话 → 触摸板 → …循环）
const PAGES = ['dialog', 'trackpad']
const PAGE_LABELS = { dialog: '对话', trackpad: '触摸板' }
let pageIndex = 1
let mouseLast = null
let mouseLastT = 0 // 上次单指 touchmove 时间戳（加速度曲线算瞬时速度）
let mouseAccum = { x: 0, y: 0 }
let mouseScrollAccum = { x: 0, y: 0 }
let mouseFlushTimer = null
let mouseDownSent = false
let mouseMoved = false
let mouseStartTime = 0
let mouseStartPos = null
let mouseLongPressTimer = null
let twoFinger = false
let threeFinger = false
let threeFingerFired = false
let threeFingerStart = null
const THREE_SWIPE_PX = 50 // 三指滑动触发阈值（px）：质心位移超过此值且方向占优即触发一次系统手势

// —— 双指惯性滚动 —— 松手后按松手速度继续滑行一段再减速停止（模拟 macOS 触摸板 momentum）
const VEL_SAMPLE_MS = 200      // 速度采样窗口（ms）：窗口内取相邻点峰值速度，覆盖整个甩动过程（含甩完停住才抬手的场景）
const MOMENTUM_THRESHOLD = 0.05 // 启动惯性的最小速度（px/ms），低于此值视为慢速拖动、精确停住
const MOMENTUM_UP_GAIN = 2.0    // 上移（vy<0）速度补偿系数：上推行程/速度天然小于下拉，放大后与下拉对齐触发手感
const MOMENTUM_TAU = 400       // 惯性衰减时间常数（ms），越小减速越快
const MOMENTUM_MIN_V = 0.005   // 惯性停止速度阈值（px/ms）
const MOMENTUM_MAX_MS = 3000   // 惯性最长持续时间（ms），安全上限防无限滑行

// —— 单指光标加速度 —— 慢速微动放大（精细操作更跟手），速度升高后指数回落至 1:1
const MOUSE_ACCEL_SLOW = 0.15     // 慢速阈值（px/ms），低于此视为微动
const MOUSE_ACCEL_SLOW_GAIN = 1.5 // 微动增益倍数
let scrollVelSamples = []      // 双指速度采样窗口 [{t,x,y}]
let momentumAnim = null        // 惯性动画 requestAnimationFrame 句柄
let momentumVx = 0
let momentumVy = 0
let momentumLastT = 0
let momentumStartT = 0

// 触控板参数：默认值与 config.json 的 trackpad 一致；服务端在 /ws 连接时随 settings 下发可调配置
const TRACKPAD_DEFAULTS = {
  sensitivity: 1.8, edgeZonePx: 18, edgeDwellMs: 250, edgeStepMs: 30, edgeSpeed: 12, trailMs: 1000,
  tpEnabled: true, tpLongPressMs: 800, tpDeadZoneR: 16, tpMaxRadius: 56, tpMaxSpeed: 1.5, tpIdleMs: 5000, rollGain: 1.0, tpAccel: 0.0,
}
let trackpadCfg = { ...TRACKPAD_DEFAULTS }
function applyTrackpad(cfg) {
  if (!cfg || typeof cfg !== 'object') return
  trackpadCfg = { ...TRACKPAD_DEFAULTS, ...cfg }
}
// ================= 小红点摇杆滚轮 =================
// 触发区：以小红点为中心、TP_HIT_RADIUS 为半径的圆。只有 touchstart 落在触发区内才会进入/恢复滚轮模式；
// 进入后手指停在哪，就按当前偏移持续滚动，直到 touchend。触发区外永远是普通鼠标移动。
let tpActive = false       // 是否处于「滚轮模式/待命状态」（触发区可视、红点亮）
let tpArmed = false        // true: 松手后的待命状态，5s 内按触发区可恢复
let tpArm = null           // 长按候选 { cx, cy, downX, downY, startT }；触发区内按下但未激活
let tpHoldTimer = null     // 长按→激活的定时器
let tpIdleTimer = null     // 无操作→退出的定时器
let tpTouch = null         // 本次触摸 { source:'dot'|'board', startX, startY, startT, lastX, lastY }；滚轮模式中
let tpStartCenter = null   // 每触摸时红点圆心快照
let tpScrollAccum = { x: 0, y: 0 } // 滚轮模式滚动增量（统一走 flushMouseMove 节流）
let tpFlushTimer = null
let tpRafId = null         // requestAnimationFrame 轮询句柄
let tpRopeDirty = false    // 是否需要重绘橡皮箭头
let tpMomentumVx = 0       // 松手惯性：当前速度（px/frame）
let tpMomentumVy = 0
let tpMomentumFrames = 0   // 惯性已滑行帧数（上限保护）
let tpMomentumAnim = null
const TP_HIT_RADIUS = 96   // 触发区半径（px），约 2 倍指尖宽，便于移动设备按准
const TP_DRAG_TOL = 16     // 长按候选期间允许的最大位移，超过视为滑动（放弃 arm）
const TP_MOMENTUM_DECAY = 0.93      // 松手惯性每帧衰减因子（约 60fps 下 ~150ms 半衰期）
const TP_MOMENTUM_MIN = 0.05        // 惯性停止速度阈值（px/frame）
const TP_MOMENTUM_MAX_FRAMES = 75   // 惯性最长帧数（约 1.25s），防无限滑行

// 红点 DOM 中心坐标（触摸开始时快照，避免布局抖动）
function trackpointCenter() {
  if (!trackpointEl) return { x: 0, y: 0 }
  const r = trackpointEl.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}
// 是否落在触发区内：进入/恢复滚轮模式的唯一入口
function inTrackpoint(x, y) {
  const c = trackpointCenter()
  return Math.hypot(x - c.x, y - c.y) <= TP_HIT_RADIUS
}
// 多点触摸质心（三指滑动用）：取所有触点的平均坐标，作为滑动方向的参考点
function touchCentroid(touches) {
  let x = 0, y = 0
  const n = touches.length
  for (let i = 0; i < n; i++) { x += touches[i].clientX; y += touches[i].clientY }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 }
}
function setTrackpointActive(on) {
  tpActive = on
  if (!on) {
    tpArmed = false
    tpTouch = null
    stopTrackpointLoop()
    cancelTpMomentum()
  }
  if (trackpointEl) {
    trackpointEl.classList.toggle('active', on && !tpArmed)
    trackpointEl.classList.toggle('armed', on && tpArmed)
  }
  if (trackpointBadgeEl) trackpointBadgeEl.classList.toggle('hidden', !on)
}
function setTrackpointArmed(armed) {
  tpArmed = armed
  if (trackpointEl) {
    trackpointEl.classList.toggle('active', tpActive && !tpArmed)
    trackpointEl.classList.toggle('armed', tpActive && tpArmed)
  }
}
function clearTpIdle() {
  if (tpIdleTimer) { clearTimeout(tpIdleTimer); tpIdleTimer = null }
}
function armTpIdle() {
  clearTpIdle()
  if (!tpActive) return
  setTrackpointArmed(true)
  tpIdleTimer = setTimeout(() => {
    tpIdleTimer = null
    setTrackpointActive(false)
    tpScrollAccum = { x: 0, y: 0 }
    clearTouchCanvas()
    flushMouseMove()
  }, trackpadCfg.tpIdleMs)
}
// 计算当前手指相对红点中心的滚动速度（含死区、满速封顶）
function trackpointScrollVelocity(x, y) {
  const c = tpStartCenter
  if (!c) return { x: 0, y: 0 }
  const dx = x - c.x
  const dy = y - c.y
  const dist = Math.hypot(dx, dy)
  if (dist <= trackpadCfg.tpDeadZoneR) return { x: 0, y: 0 }
  const dirX = dx / dist
  const dirY = dy / dist
  const range = Math.max(1, trackpadCfg.tpMaxRadius - trackpadCfg.tpDeadZoneR)
  const f = Math.min(1, Math.max(0, dist - trackpadCfg.tpDeadZoneR) / range)
  const speed = trackpadCfg.tpMaxSpeed * f * trackpadCfg.rollGain * (1 + (trackpadCfg.tpAccel || 0) * f)
  // 红点滚轮方向取反：原先红点滚轮方向颠倒，对滚轮速度整体取负修正。
  return { x: -dirX * speed, y: -dirY * speed }
}
function trackpointPoll() {
  if (!tpActive || !tpTouch) return
  const t = tpTouch
  const v = trackpointScrollVelocity(t.lastX, t.lastY)
  if (v.x || v.y) {
    tpScrollAccum.x += v.x
    tpScrollAccum.y += v.y
    trackpointFlush()
  }
  if (tpRopeDirty) {
    drawTrackpointRope(t.lastX, t.lastY)
    tpRopeDirty = false
  }
  tpRafId = requestAnimationFrame(trackpointPoll)
}
function startTrackpointLoop() {
  stopTrackpointLoop()
  tpRopeDirty = true
  tpRafId = requestAnimationFrame(trackpointPoll)
}
function stopTrackpointLoop() {
  if (tpRafId) { cancelAnimationFrame(tpRafId); tpRafId = null }
}
function trackpointDrag(x, y) {
  if (!tpTouch) return
  tpTouch.lastX = x
  tpTouch.lastY = y
  tpRopeDirty = true
}
function trackpointFlush() {
  if (tpFlushTimer) return
  tpFlushTimer = setTimeout(() => {
    tpFlushTimer = null
    if (!tpActive) { tpScrollAccum = { x: 0, y: 0 }; return }
    if (tpScrollAccum.x || tpScrollAccum.y) {
      mouseScrollAccum.x += tpScrollAccum.x
      mouseScrollAccum.y += tpScrollAccum.y
      tpScrollAccum = { x: 0, y: 0 }
      scheduleMouseFlush()
    }
  }, 30)
}

// 滚轮模式松手惯性：按松手瞬间红点偏移速度继续滚动一段并衰减（对齐双指惯性手感）。
// 速度单位与按住时一致（px/frame），每帧乘衰减因子；重新按下或退出滚轮模式立即停止。
function startTpMomentum(vx, vy) {
  cancelTpMomentum()
  tpMomentumVx = vx
  tpMomentumVy = vy
  tpMomentumFrames = 0
  tpMomentumAnim = requestAnimationFrame(stepTpMomentum)
}
function stepTpMomentum() {
  if (tpTouch) { cancelTpMomentum(); flushMouseMove(); return } // 又按下则立刻停惯性
  tpMomentumVx *= TP_MOMENTUM_DECAY
  tpMomentumVy *= TP_MOMENTUM_DECAY
  tpMomentumFrames++
  const s = Math.hypot(tpMomentumVx, tpMomentumVy)
  if (s < TP_MOMENTUM_MIN || tpMomentumFrames > TP_MOMENTUM_MAX_FRAMES) {
    cancelTpMomentum()
    flushMouseMove()
    return
  }
  tpScrollAccum.x += tpMomentumVx
  tpScrollAccum.y += tpMomentumVy
  trackpointFlush()
  tpMomentumAnim = requestAnimationFrame(stepTpMomentum)
}
function cancelTpMomentum() {
  if (tpMomentumAnim) { cancelAnimationFrame(tpMomentumAnim); tpMomentumAnim = null }
  tpMomentumVx = 0
  tpMomentumVy = 0
}
// VAD（静音门限）配置，默认与服务端 config.json 的 vad 一致；
// worklet 会在录音时收到此配置，静音帧不再上行（省流量/省费用）。
const VAD_DEFAULTS = { enabled: true, threshold: 0.006, holdMs: 260 }
let vadCfg = { ...VAD_DEFAULTS }
function applyVad(cfg) {
  if (!cfg || typeof cfg !== 'object') return
  vadCfg = { ...VAD_DEFAULTS, ...cfg }
}
// 当前 ASR provider 是否为本地(sherpa)：本地非实时识别没有逐字回显，
// 录音时在 recHint 给出「本地识别中」提示，替代消失的灰字半句反馈。
let isOffline = false
let edgeDirection = null
let edgeDwellTimer = null
let edgeStepTimer = null
let edgeVector = null
let edgeStep = null
let mouseEndPos = null
let edgeHint = null
let mouseSwipeCancel = false
let mouseSwipeStartX = null
let trailPoints = []
let trailTimer = null
const MAX_AUDIO_BUFFERED = 384 * 1024 // 384KB≈12s 音频：WS 上行缓冲超过阈值时临时丢弃音频帧，防弱网下无限堆积。
let droppedAudioBytes = 0
let lastAudioDropLog = 0
let burstDropUntil = 0 // 瞬时突发丢帧退避：持续过载时连续丢一段时间，让缓冲尽快回落到正常水位


// 关键事件上报给 Mac 服务端，集中写入 logs/app.log，方便事后排查
function phoneLog(scope, text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'log', scope, text: String(text) }))
  }
}

// 弱网提示：持续背压丢帧时，给用户一个不打断的提示（3 秒后自动消失）。
let netHintTimer = null
function showNetHint() {
  const el = document.getElementById('netHint')
  if (!el) return
  el.textContent = '网络不稳定，音频已降级'
  el.classList.add('show')
  clearTimeout(netHintTimer)
  netHintTimer = setTimeout(() => el.classList.remove('show'), 3000)
}

// 设备身份：localStorage 里的稳定 deviceId + 可选的自定义名称，连接时通过 identify 上报，
// 服务端据此在控制面板按设备记住自定义名称（离线也不丢）。
function getDeviceId() {
  let id = localStorage.getItem('phvoice-device-id')
  if (!id) {
    id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    try { localStorage.setItem('phvoice-device-id', id) } catch (_) {}
  }
  return id
}
function devicePlatform() {
  const ua = navigator.userAgent || ''
  if (/android|miui|xiaomi|hyperos|redmi|pixel|samsung|huawei|oppo|vivo|oneplus/i.test(ua)) return 'Android'
  if (/iphone|ipad|ios/i.test(ua)) return 'iOS'
  return '未知设备'
}

// 配对令牌：首次从配置页经 #token= 传入，存进 localStorage，之后每次连接都凭它鉴权。
// 只在服务端校验映射，本地不存设备之外的秘密；换网/重启后 token 仍有效。
function ingestPairToken() {
  try {
    if (location.hash && location.hash.indexOf('#token=') === 0) {
      const token = decodeURIComponent(location.hash.slice('#token='.length))
      if (token) localStorage.setItem('phvoice-pair-token', token)
      // 清掉 hash，避免把 token 留在地址栏 / 服务端日志 / 分享里
      history.replaceState(null, '', location.pathname + location.search)
    }
  } catch (_) {}
}
function getPairToken() {
  try { return localStorage.getItem('phvoice-pair-token') || '' } catch (_) { return '' }
}

// 服务端拒连(close 4001) → 不进重连循环，在应用内直接弹出重配对表单（showUnpaired）。
function showUnpaired() {
  resultArea.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'unpaired-box'
  box.innerHTML =
    '<div class="unpaired-icon">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
        '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
      '</svg>' +
    '</div>' +
    '<p class="unpaired-title">需要重新配对</p>' +
    '<p class="unpaired-desc">可能是换了浏览器或清除了数据，只需重新输入配对码即可，无需重新安装证书</p>' +
    '<ol class="unpaired-steps">' +
      '<li><span class="unpaired-step-num">1</span><span>打开 Mac 上 PhVoice 的控制面板</span></li>' +
      '<li><span class="unpaired-step-num">2</span><span>进入「接入设备」页面，查看 6 位配对码</span></li>' +
    '</ol>' +
    '<div class="pair-form">' +
      '<input class="pair-input" type="text" inputmode="numeric" maxlength="6" placeholder="输入 6 位配对码" autocomplete="one-time-code" />' +
      '<button class="pair-submit" type="button">确认配对</button>' +
      '<p class="pair-hint">配对码 10 分钟内有效，输错 8 次会自动刷新</p>' +
      '<p class="pair-error hidden"></p>' +
    '</div>'
  const input = box.querySelector('.pair-input')
  const submitBtn = box.querySelector('.pair-submit')
  const errorEl = box.querySelector('.pair-error')
  async function doPair() {
    const code = input.value.trim()
    if (!/^\d{6}$/.test(code)) {
      errorEl.textContent = '请输入 6 位数字'
      errorEl.classList.remove('hidden')
      return
    }
    submitBtn.disabled = true
    submitBtn.textContent = '验证中…'
    errorEl.classList.add('hidden')
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (data.ok && data.token) {
        localStorage.setItem('phvoice-pair-token', data.token)
        phoneLog('ui', '配对成功，正在重新连接…')
        location.reload()
      } else {
        errorEl.textContent = data.error === 'code_invalid' ? '配对码不正确或已过期' : (data.message || data.error || '配对失败')
        errorEl.classList.remove('hidden')
        input.value = ''
        input.focus()
      }
    } catch (e) {
      errorEl.textContent = '网络错误，请检查连接'
      errorEl.classList.remove('hidden')
    } finally {
      submitBtn.disabled = false
      submitBtn.textContent = '确认配对'
    }
  }
  submitBtn.addEventListener('click', doPair)
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair() })
  // 只允许输入数字
  input.addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6) })
  resultArea.appendChild(box)
  input.focus()
  phoneLog('ui', '未配对：需要重新输入配对码')
}

// ---------- WebSocket ----------
function startHeartbeat() {
  stopHeartbeat()
  // 每 15s 发一次应用层 ping；连续 2 次收不到 pong 认为连接已不可用，主动断开触发重连
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      heartbeatMissed += 1
      ws.send(JSON.stringify({ type: 'ping' }))
      if (heartbeatMissed >= 2) {
        phoneLog('ws', '心跳超时，主动重连')
        ws.close()
      }
    }
  }, 15000)
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  heartbeatMissed = 0
}
// 刚通过 #token 完成配对落地：盖一层 3 秒圆环“配对成功→正在进入触摸板”，到点自动消失。
// 只服务“刚配对”的首次进入；普通刷新/重连不触发（enteredViaToken 为 false）。
function showEnterSplash() {
  const CIRC = 2 * Math.PI * 28
  const overlay = document.createElement('div')
  overlay.id = 'enterSplash'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(244,246,244,.9);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);pointer-events:auto;'
  overlay.innerHTML =
    '<div style="background:#fff;border-radius:22px;padding:30px 46px;box-shadow:0 16px 50px rgba(37,99,235,.18);' +
    'display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;font-family:-apple-system,\'PingFang SC\',sans-serif;">' +
    '<div style="font-size:15px;color:#16a34a;font-weight:600;">✓ 配对成功</div>' +
    '<div class="splash-ring" style="position:relative;width:64px;height:64px;">' +
      '<svg width="64" height="64" viewBox="0 0 64 64" style="transform:rotate(-90deg)">' +
        '<circle cx="32" cy="32" r="28" fill="none" stroke="#e0e0e0" stroke-width="4"/>' +
        '<circle class="splash-fg" id="splashCircle" cx="32" cy="32" r="28" fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + CIRC + '" stroke-dashoffset="0"/>' +
      '</svg>' +
      '<div id="splashNum" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#2563eb;">3</div>' +
    '</div>' +
    '<div style="font-size:15px;color:#555;font-weight:500;">正在进入触摸板</div>' +
    '<div style="font-size:13px;color:#999;">3 秒后自动开始，可稍作等待</div>' +
    '</div>'
  document.body.appendChild(overlay)
  const num = overlay.querySelector('#splashNum')
  const fg = overlay.querySelector('#splashCircle')
  let remaining = 3
  const iv = setInterval(() => {
    remaining -= 1
    if (remaining <= 0) {
      clearInterval(iv)
      overlay.remove()
      return
    }
    if (num) num.textContent = remaining
    if (fg) fg.style.strokeDashoffset = String(CIRC * (1 - remaining / 3))
  }, 1000)
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onopen = () => {
    reconnectAttempt = 0
    heartbeatMissed = 0
    settingsSeen = false // 每次重连重新对账：首个 settings 时断言本机持久化的输入模式
    startHeartbeat()
    // 首帧必须是 auth：服务端在鉴权前只认这一条，其它任何帧（含 phoneLog 的 log）都会先被拒。
    // 因此 auth 要放在所有 ws.send 之前，连 phoneLog 都别先发。
    ws.send(JSON.stringify({ type: 'auth', token: getPairToken() }))
    phoneLog('ui', 'client v40 loaded')
    statusEl.textContent = '已连接'
    statusEl.className = 'status online'
    talkBtn.disabled = false
    // 上报设备身份：设备 ID + 自定义名（若在控制面板/设置里设过）
    ws.send(JSON.stringify({
      type: 'identify',
      id: getDeviceId(),
      name: (function () { try { return localStorage.getItem('phvoice-device-name') || '' } catch (_) { return '' } })(),
      platform: devicePlatform(),
    }))
    // 握手通过=配对成功。仅“刚通过 #token 落地”的首进：盖 3 秒圆环再显示触摸板；
    // 展示后立刻清空标记，让同会话内后续的重连不再重复亮闪屏。
    if (enteredViaToken) {
      enteredViaToken = false
      showEnterSplash()
    }
  }
  ws.onclose = (event) => {
    statusEl.textContent = '已断开，重连中…'
    statusEl.className = 'status offline'
    talkBtn.disabled = true
    // 断线时强制结束任何“按住/录音中”状态，避免按钮颜色或音频链路卡死
    holding = false
    recording = false
    talkBtn.classList.remove('starting')
    talkBtn.classList.remove('recording')
    talkText.textContent = '点击 说话'
    teardownRecording()
    trayOpen = false
    mouseMode = false
    pageIndex = 0
    switcherBtn.classList.remove('active')
    switcherText.textContent = ''
    if (mouseBtn) mouseBtn.classList.remove('active')
    resultArea.classList.remove('mouse-active')
    appTrayOverlay.classList.add('hidden')
    appTray.innerHTML = ''
    closeToolsSheet()
    toolsBtn.classList.remove('active')
    toolsBtn.classList.remove('trackpad-on')
    if (mouseSub) mouseSub.textContent = ''
    stopRecording()
    stopHeartbeat()
    // 服务端拒连(未配对/令牌无效)：不进重连循环，提示去配对
    if (event && event.code === 4001) {
      showUnpaired()
      return
    }
    // 指数退避：1s → 2s → 4s → 8s → 15s 封顶，避免断网时高频重连
    const delay = Math.min(15000, 1000 * Math.pow(2, reconnectAttempt))
    reconnectAttempt += 1
    phoneLog('ws', '连接断开，' + (delay / 1000).toFixed(0) + 's 后重连（第 ' + reconnectAttempt + ' 次）')
    setTimeout(connect, delay)
  }
  ws.onerror = () => phoneLog('ws', '连接出错')
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'pong') {
      heartbeatMissed = 0
      return
    }
    if (msg.type === 'settings') {
      applyTrackpad(msg.trackpad)
      if (typeof applyVad === 'function') applyVad(msg.vad)
      serverProvider = msg.provider || ''
      isOffline = serverProvider === 'sherpa'
      if (msg.availability) availability = { cloud: !!msg.availability.cloud, offline: !!msg.availability.offline }
      // 优化模板：手机端「优化」按钮的模板选择器数据源（服务端只下发 {id,name}，不含提示词正文）
      if (msg.optimize) {
        optimizePool = Array.isArray(msg.optimize.pool) ? msg.optimize.pool : []
        optimizeDefaultId = msg.optimize.defaultId || (optimizePool[0] && optimizePool[0].id) || ''
      }
      // 键盘（compose）参数：用服务端 config.compose 覆盖本地默认上限
      if (msg.compose) {
        if (Number.isInteger(msg.compose.fileMaxCount) && msg.compose.fileMaxCount > 0) MAX_COMPOSE_FILES = msg.compose.fileMaxCount
        const mb = Number(msg.compose.fileMaxMB)
        if (Number.isFinite(mb) && mb > 0) MAX_COMPOSE_BYTES = mb * 1024 * 1024
      }
      // 云端/本地对账以「本连接生效 provider」为准 —— server 下发的 provider 已含本连接的
      // 每连接覆盖（用户点本地后，server 回推 provider=sherpa）；defaultInputMode 是全局默认，
      // 只用于「无本地偏好的新手机」初次进入的模式，绝不能在切换后拿去反向对账（会把刚选的模式弹回默认）。
      const impliedByProvider = serverProvider === 'bailian' ? 'cloud' : serverProvider === 'sherpa' ? 'local' : ''
      const impliedDefault = (msg.defaultInputMode === 'cloud' || msg.defaultInputMode === 'local' || msg.defaultInputMode === 'keyboard')
        ? msg.defaultInputMode
        : impliedByProvider
      if (!settingsSeen) {
        settingsSeen = true
        // 连接后首个 settings：把本机持久化的云端/本地偏好断言给 server（每连接覆盖，下次识别生效）；
        // 无偏好（首次使用）则跟随服务端 defaultInputMode；键盘模式只上报展示状态，不参与引擎对账。
        if (inputMode === 'keyboard') {
          ws.send(JSON.stringify({ type: 'inputMode', mode: 'keyboard' }))
        } else if ((inputMode === 'cloud' || inputMode === 'local') && impliedByProvider && inputMode !== impliedByProvider) {
          ws.send(JSON.stringify({ type: 'inputMode', mode: inputMode }))
        } else if (!inputMode && impliedDefault) {
          setInputMode(impliedDefault, { silent: true })
        } else {
          updateModeSwitchUI()
        }
      } else if ((inputMode === 'cloud' || inputMode === 'local') && impliedByProvider && inputMode !== impliedByProvider) {
        // 连接期间的外部变更（控制面板改引擎 / 预算自动降级）：以 server 的 provider 为准，切换器跟随
        setInputMode(impliedByProvider, { silent: true })
      }
      return
    }
    if (msg.type === 'partial') {
      // 实时回显分层：已定稿的字用正常色（.finalized-seg），正在识别的半句用灰色虚线（.partial-seg），
      // 一眼分清「哪些字已经不会变了、哪些还在听」，消除「整段字变来变去」带来的忐忑。
      const finalized = msg.finalized || ''
      const partial = msg.partial || ''
      partialEl.innerHTML = ''
      if (finalized) {
        const seg = document.createElement('span')
        seg.className = 'finalized-seg'
        seg.textContent = finalized
        partialEl.appendChild(seg)
      }
      if (partial) {
        const seg = document.createElement('span')
        seg.className = 'partial-seg'
        seg.textContent = partial
        partialEl.appendChild(seg)
      }
      if (finalized || partial) partialEl.classList.remove('hidden')
      else partialEl.classList.add('hidden')
    } else if (msg.type === 'final') {
      lastFinalText = msg.text
      partialEl.classList.add('hidden')
      // 只保留最近一条识别结果：清空历史后仅显示本次，新结果替换旧结果
      // 卡片右下角带「优化 / 重新上屏」两个按钮：优化=纠错润色后替换原文；重新上屏=贴错位置重贴
      finalsEl.innerHTML = ''
      const div = document.createElement('div')
      div.className = 'final-line'
      const txt = document.createElement('span')
      txt.className = 'final-text'
      txt.textContent = msg.text
      const actions = document.createElement('div')
      actions.className = 'final-actions'
      const optBtn = document.createElement('button')
      optBtn.className = 'optimize-btn'
      optBtn.type = 'button'
      optBtn.textContent = '优化'
      const btn = document.createElement('button')
      btn.className = 'repaste-btn'
      btn.type = 'button'
      btn.textContent = '重新上屏'
      actions.appendChild(optBtn)
      actions.appendChild(btn)
      div.appendChild(txt)
      div.appendChild(actions)
      finalsEl.appendChild(div)
    } else if (msg.type === 'optimizing') {
      // 优化进行中：按钮进入「优化中…」态并禁用，避免连点并发
      const optBtn = finalsEl.querySelector('.optimize-btn')
      if (optBtn) {
        optBtn.textContent = '优化中…'
        optBtn.disabled = true
        optBtn.classList.add('optimizing')
      }
    } else if (msg.type === 'optimized') {
      // 优化完成：替换卡片文本与 lastFinalText，后续「重新上屏/再优化/发送」都作用在优化后的文本上
      lastFinalText = msg.text || lastFinalText
      const txt = finalsEl.querySelector('.final-text')
      if (txt) txt.textContent = lastFinalText
      resetOptimizeBtn()
      flashStatus('已优化')
    } else if (msg.type === 'optimizeError') {
      resetOptimizeBtn()
    } else if (msg.type === 'sent') {
      if (msg.source === 'compose') {
        // 输入态上屏：不触发“执行”的闪光，也不回弹到触摸板
        flashStatus('已上屏')
      } else {
        flashStatus('已执行')
        // 保留 lastFinalText 与「重新上屏」入口：用户可能执行后才发现贴错位置。
        // 记录直到下一次语音输入产生新结果（final 整体替换卡片）时才消失。
        partialEl.classList.add('hidden')
        enterBtn.classList.remove('flash')
        void enterBtn.offsetWidth
        enterBtn.classList.add('flash')
        // 执行完成后回弹到触摸板（触摸板是默认首页，无论说话前在哪一页）
        recordFromTrackpad = false
        setPage('trackpad')
      }
    } else if (msg.type === 'repasted') {
      flashStatus('已重新上屏')
    } else if (msg.type === 'deleted') {
      deleteArmed = false
      if (deleteArmTimer) clearTimeout(deleteArmTimer)
      deleteKeyArmed = false
      if (deleteKeyArmTimer) clearTimeout(deleteKeyArmTimer)
      const wasBackspace = msg.mode === 'backspace'
      flashStatus(wasBackspace
        ? '已删除'
        : (msg.remaining ? `已回退，还可回退 ${msg.remaining} 步` : '已回退'))
      const flashBtn = wasBackspace ? deleteKeyBtn : deleteBtn
      flashBtn.classList.remove('flash')
      void flashBtn.offsetWidth
      flashBtn.classList.add('flash')
      lastFinalText = ''
      partialEl.classList.add('hidden')
      // 回退：页面只保留最近一条，直接将其移除
      if (finalsEl.firstElementChild) finalsEl.firstElementChild.remove()
    } else if (msg.type === 'windowSwitched') {
      flashStatus('已切换窗口')
    } else if (msg.type === 'apps' || msg.type === 'launchpad') {
      appListCache = msg.apps || []
      renderApps(appListCache)
    } else if (msg.type === 'appActivated') {
      const app = appListCache.find((a) => a.bundleId === msg.bundleId)
      if (app) currentFrontApp = app
      flashStatus('已切换')
    } else if (msg.type === 'frontApp') {
      currentFrontApp = msg.app || null
      updateQuitModal()
    } else if (msg.type === 'gestureDone') {
      flashStatus(msg.action === 'launchpad' ? '已打开启动台' : msg.action === 'expose' ? '已打开窗口总览' : '已打开任务控制')
    } else if (msg.type === 'appQuit') {
      flashStatus('已退出应用')
    } else if (msg.type === 'toast') {
      flashStatus(msg.text)
      nudgeBtn(msg.target === 'delete' ? deleteBtn : enterBtn)
    } else if (msg.type === 'asrUnavailable') {
      // 服务端兜底拦截：即便手机端 availability 信息过期，也在真正 start 时回弹框。
      // 此刻多半已开麦并置为「录音中」，先按取消收尾再弹框，避免停在半启动态。
      if (holding) cancelRecording()
      showAsrUnavailableDialog(msg.provider, msg.cloud, msg.offline)
    }
  }
}
// 是否通过设置向导的 #token= 新进来（而非普通刷新/重连）。
// 只有这种“刚完成配对”的落地才显示 3 秒进入动效；用一个 let 承载并在展示后立即清空，
// 这样同一页面会话内后续的 WS 断线重连不会再重复亮闪屏（否则每次重连都挡 3 秒）。
let enteredViaToken = !!(location.hash && location.hash.indexOf('#token=') === 0)
// 先处理 #token（存入 localStorage 并清地址栏），再建立 WebSocket
ingestPairToken()
// 恢复本机持久化的输入模式（键盘模式会立即展开输入区并置灰说话按钮；
// 云端/本地在此只刷新切换器选中态，与 server 引擎的对账等首个 settings 再做）
if (inputMode) setInputMode(inputMode, { silent: true })
else updateModeSwitchUI()
connect()

// 页面加载即预热音频管线，让“按下即录”生效、避免前几秒语音丢失
window.addEventListener('load', warmupAudio)

// PWA：注册 Service Worker（仅 HTTPS 生效，HTTP 开发模式跳过，避免缓存旧版干扰调试）。
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      phoneLog('pwa', 'Service Worker 已注册，可添加到主屏幕')
    }).catch((err) => {
      phoneLog('pwa', 'Service Worker 注册失败: ' + (err && err.message ? err.message : String(err)))
    })
  })
}



// ---------- 对话页：回显态 <-> 输入态（文字 / 图片 / 文件 compose） ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
function formatComposeSize(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'M'
  if (b >= 1024) return (b / 1024).toFixed(0) + 'K'
  return b + 'B'
}
async function addComposeFiles(fileList) {
  const files = Array.from(fileList || [])
  for (const f of files) {
    if (composeAttachments.length >= MAX_COMPOSE_FILES) {
      flashStatus('最多 5 个附件')
      break
    }
    if (f.size > MAX_COMPOSE_BYTES) {
      flashStatus('单个文件不能超过 20MB')
      continue
    }
    const kind = (f.type && f.type.startsWith('image/')) ? 'image' : 'file'
    const base64 = await fileToBase64(f)
    const item = { kind, name: f.name || 'file', mime: f.type || '', size: f.size, base64, previewUrl: '' }
    if (kind === 'image') item.previewUrl = URL.createObjectURL(f)
    composeAttachments.push(item)
  }
  composerFile.value = ''
  renderComposeChips()
  updateComposeSend()
}
function renderComposeChips() {
  composerChips.innerHTML = ''
  composeAttachments.forEach((a, i) => {
    const chip = document.createElement('div')
    chip.className = 'composer-chip'
    if (a.kind === 'image' && a.previewUrl) {
      const img = document.createElement('img')
      img.src = a.previewUrl
      img.alt = ''
      chip.appendChild(img)
    } else {
      const icon = document.createElement('span')
      icon.className = 'chip-file'
      icon.setAttribute('aria-hidden', 'true')
      icon.innerHTML = '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
      chip.appendChild(icon)
    }
    const name = document.createElement('span')
    name.className = 'chip-name'
    name.textContent = a.name
    chip.appendChild(name)
    const size = document.createElement('span')
    size.className = 'chip-size'
    size.textContent = formatComposeSize(a.size)
    chip.appendChild(size)
    const rm = document.createElement('button')
    rm.className = 'chip-remove'
    rm.type = 'button'
    rm.setAttribute('aria-label', '移除 ' + a.name)
    rm.innerHTML = '<svg class="ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    rm.addEventListener('click', () => removeComposeAttachment(i))
    chip.appendChild(rm)
    composerChips.appendChild(chip)
  })
}
function removeComposeAttachment(idx) {
  const a = composeAttachments[idx]
  if (a && a.previewUrl) URL.revokeObjectURL(a.previewUrl)
  composeAttachments.splice(idx, 1)
  renderComposeChips()
  updateComposeSend()
}
function updateComposeSend() {
  const hasText = composerInput.value.trim().length > 0
  composerSend.disabled = !(hasText || composeAttachments.length > 0)
}
function autoGrowCompose() {
  composerInput.style.height = 'auto'
  composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + 'px'
}
// ---------- 输入模式：云端 / 本地 / 键盘 ----------
// 云端(cloud→bailian) 本地(local→sherpa)：语音输入，引擎按连接覆盖（仅本手机生效）；
// 键盘(keyboard)：展开输入区用手机自带输入法（含其语音输入），说话按钮置灰。
function updateModeSwitchUI() {
  if (!inputModeSwitch) return
  inputModeSwitch.querySelectorAll('.mode-seg').forEach((b) => {
    const on = b.dataset.mode === inputMode
    b.classList.toggle('on', on)
    b.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}

function setInputMode(mode, opts = {}) {
  if (mode !== 'cloud' && mode !== 'local' && mode !== 'keyboard') return
  // 用户主动切换输入模式时若正在录音，直接中断本次识别（丢弃，避免「模式已切、却仍在录音」的错乱）；
  // silent 对账（服务器 settings 推来）不中断，沿用「进行中会话不切引擎」的语义。
  if (!opts.silent && holding) cancelRecording()
  inputMode = mode
  try { localStorage.setItem(INPUT_MODE_KEY, mode) } catch (_) {}
  updateModeSwitchUI()
  if (mode === 'keyboard') {
    enterCompose()
    // 键盘也上报（仅作展示模式，server 不动 provider 覆盖）：让控制面板设备列表能显示「键盘」
    if (!opts.silent && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'inputMode', mode: 'keyboard' }))
    }
  } else {
    exitCompose()
    // 用户主动切换（非 settings 对账）：通知 server 按连接覆盖 provider，下次识别生效
    if (!opts.silent && ws && ws.readyState === WebSocket.OPEN) {
      const implied = serverProvider === 'bailian' ? 'cloud' : serverProvider === 'sherpa' ? 'local' : ''
      if (mode !== implied) ws.send(JSON.stringify({ type: 'inputMode', mode }))
    }
  }
  phoneLog('ui', '输入模式：' + ({ cloud: '云端', local: '本地', keyboard: '键盘' }[mode] || mode))
}

function enterCompose() {
  if (composing) return
  composing = true
  panelDialog.classList.add('composing')
  composer.classList.remove('hidden')
  autoGrowCompose()
  updateComposeSend()
  setTimeout(() => composerInput.focus(), 60)
  phoneLog('ui', '进入输入态')
}
function exitCompose() {
  if (!composing) return
  composing = false
  panelDialog.classList.remove('composing')
  composer.classList.add('hidden')
  phoneLog('ui', '退回回显态')
}
function sendCompose() {
  const text = composerInput.value
  if (!text.trim() && composeAttachments.length === 0) {
    flashStatus('输入内容为空')
    return
  }
  if (!(ws && ws.readyState === WebSocket.OPEN)) {
    flashStatus('未连接')
    return
  }
  ws.send(JSON.stringify({
    type: 'compose',
    text,
    attachments: composeAttachments.map((a) => ({ kind: a.kind, name: a.name, mime: a.mime, base64: a.base64 })),
  }))
  phoneLog('ui', 'compose 已发送')
  // 让「执行」按钮在键盘上屏后可用：语音路径由 final 消息设置 lastFinalText，
  // compose 路径在这里本地记录（server 的 pasteHistory 已在 compose 时压栈，send 会正常模拟回车）。
  lastFinalText = text.trim() || (composeAttachments.length ? '[附件]' : '')
  composerInput.value = ''
  composeAttachments.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
  composeAttachments = []
  composerChips.innerHTML = ''
  composerInput.style.height = 'auto'
  updateComposeSend()
  // 键盘是常驻模式：上屏后保持输入区展开，可连续输入（不再退回回显态）
}

// 事件绑定
if (inputModeSwitch) {
  inputModeSwitch.querySelectorAll('.mode-seg').forEach((b) => {
    b.addEventListener('click', () => setInputMode(b.dataset.mode))
  })
}
composerAttach.addEventListener('click', () => composerFile.click())
composerFile.addEventListener('change', (e) => addComposeFiles(e.target.files))
composerSend.addEventListener('click', sendCompose)
composerInput.addEventListener('input', () => { autoGrowCompose(); updateComposeSend() })
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendCompose()
  }
})

// ---------- 控制面板（灵动岛式横向展开） ----------
function openToolsSheet() {
  controlIsland.classList.remove('hidden')
  toolsBtn.classList.add('active')
  toolsBtn.setAttribute('aria-expanded', 'true')
}
function closeToolsSheet() {
  controlIsland.classList.add('hidden')
  toolsBtn.classList.remove('active')
  toolsBtn.setAttribute('aria-expanded', 'false')
}
function toggleToolsSheet() {
  if (controlIsland.classList.contains('hidden')) openToolsSheet()
  else closeToolsSheet()
}
toolsBtn.addEventListener('click', toggleToolsSheet)
// 一次性的工具动作（切换/任务/窗口/退出）执行后收起面板；触摸板模式开关保留面板便于再次切换
controlIsland.addEventListener('click', (e) => {
  const item = e.target.closest('.island-item')
  if (!item) return
  // 任何工具动作（含模式开关）执行后都收起面板，避免悬浮岛挡住中间的触控区；
  // 触摸板开启状态由工具按钮绿点 + 面板内"已开启"标记体现。
  closeToolsSheet()
})
document.addEventListener('click', (e) => {
  if (controlIsland.classList.contains('hidden')) return
  if (controlIsland.contains(e.target)) return
  if (toolsBtn.contains(e.target)) return
  closeToolsSheet()
})

// ---------- 回车执行 ----------
enterBtn.addEventListener('click', () => {
  if (lastFinalText && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'send', text: lastFinalText }))
    phoneLog('ui', '点击执行')
  } else {
    nudgeBtn(enterBtn)
    flashStatus('先点击说话')
  }
})

deleteBtn.addEventListener('click', () => {
  if (!deleteArmed) {
    deleteArmed = true
    flashStatus('再点一次确认回退')
    deleteArmTimer = setTimeout(() => { deleteArmed = false }, 1500)
    return
  }
  deleteArmed = false
  if (deleteArmTimer) clearTimeout(deleteArmTimer)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'delete' }))
    phoneLog('ui', '点击回退')
  } else {
    nudgeBtn(deleteBtn)
    flashStatus('未连接')
  }
})

// 删除键：等效键盘删除键（Backspace），用于终端等 Cmd+Z 不撤销粘贴内容的场景。
// 1.5 秒内连续按两次才生效（第一次「武装」，第二次执行），防止误触。
deleteKeyBtn.addEventListener('click', () => {
  if (!deleteKeyArmed) {
    deleteKeyArmed = true
    flashStatus('再点一次确认删除')
    deleteKeyArmTimer = setTimeout(() => { deleteKeyArmed = false }, 1500)
    return
  }
  deleteKeyArmed = false
  if (deleteKeyArmTimer) clearTimeout(deleteKeyArmTimer)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'delete', mode: 'backspace' }))
    phoneLog('ui', '点击删除键')
  } else {
    nudgeBtn(deleteKeyBtn)
    flashStatus('未连接')
  }
})

// 重置「优化」按钮回初始态（成功或失败后都调），供 optimizeError/optimized 复用。
function resetOptimizeBtn() {
  const optBtn = finalsEl.querySelector('.optimize-btn')
  if (!optBtn) return
  optBtn.textContent = '优化'
  optBtn.disabled = false
  optBtn.classList.remove('optimizing')
}

// 回显卡片右下角两个按钮：
//   「重新上屏」识别结果贴错位置时，先把 Mac 光标移到正确位置，再重贴最后一次识别结果（不回车、不丢历史）。
//   「优化」对最近一条结果纠错/润色，服务端「删旧文 + 上优化文」替换。
finalsEl.addEventListener('click', (e) => {
  const optBtn = e.target.closest('.optimize-btn')
  if (optBtn) {
    if (!lastFinalText) {
      flashStatus('没有可优化的内容')
      return
    }
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      nudgeBtn(optBtn)
      flashStatus('未连接')
      return
    }
    if (optBtn.disabled) return
    // 优化模板有多个时先弹选择器（临时选）；仅一条（或空）时直接按默认优化。
    if (optimizePool.length > 1) {
      openOptimizePicker()
    } else {
      ws.send(JSON.stringify({ type: 'optimize' }))
    }
    phoneLog('ui', '点击优化')
    return
  }
  const btn = e.target.closest('.repaste-btn')
  if (!btn) return
  if (!lastFinalText) {
    flashStatus('没有可重新上屏的内容')
    return
  }
  if (!(ws && ws.readyState === WebSocket.OPEN)) {
    nudgeBtn(btn)
    flashStatus('未连接')
    return
  }
  ws.send(JSON.stringify({ type: 'repaste', text: lastFinalText }))
  phoneLog('ui', '点击重新上屏')
})

function openTray(mode) {
  if (!(ws && ws.readyState === WebSocket.OPEN)) return false
  trayOpen = true
  trayMode = mode
  switcherBtn.classList.add('active')
  switcherBtn.setAttribute('aria-pressed', 'true')
  switcherText.textContent = '完成'
  appTrayOverlay.classList.remove('hidden')
  appTrayOverlay.setAttribute('aria-label', mode === 'launch' ? '启动台' : '切换应用')
  appTray.innerHTML = ''
  ws.send(JSON.stringify({ type: mode === 'launch' ? 'launchpad' : 'apps' }))
  phoneLog('ui', mode === 'launch' ? '启动台: 打开' : '切换面板: 打开')
  flashStatus('加载应用…')
  return true
}

switcherBtn.addEventListener('click', () => {
  if (trayOpen) { closeTray(); return }
  if (!openTray('switch')) {
    nudgeBtn(switcherBtn)
    flashStatus('未连接')
  }
})

launchpadBtn.addEventListener('click', () => {
  if (trayOpen) { closeTray(); return }
  sendGesture('launchpad', '启动台')
})

// 控制岛最左的收回箭头：误触后可一键收起
islandCloseBtn.addEventListener('click', closeToolsSheet)

function sendGesture(action, label) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'gesture', action }))
    phoneLog('ui', label)
    flashStatus('正在打开' + label)
  } else {
    nudgeBtn(action === 'launchpad' ? launchpadBtn : missionBtn)
    flashStatus('未连接')
  }
}

// 三指滑动 → 系统手势（上=任务控制、下=App 窗口、左右=切空间）。与按钮共用 server 的 gesture 通路。
function threeFingerGesture(action, label) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'gesture', action }))
    phoneLog('ui', '三指：' + label)
    flashStatus(label)
  } else {
    flashStatus('未连接')
  }
}

missionBtn.addEventListener('click', () => sendGesture('mission', '任务控制'))
function openQuitModal() { if (quitModal) quitModal.classList.remove('hidden') }
function closeQuitModal() { if (quitModal) quitModal.classList.add('hidden') }
// 退出确认弹窗：明确告诉用户将退出的是哪个应用 App
function updateQuitModal() {
  if (!quitModalTitle || !quitModalText) return
  const name = currentFrontApp && (currentFrontApp.name || currentFrontApp.bundleId)
  if (name) {
    quitModalTitle.textContent = `退出「${name}」？`
    quitModalText.textContent = `将关闭并退出 ${name}。`
  } else {
    quitModalTitle.textContent = '退出当前应用？'
    quitModalText.textContent = '将关闭当前正在使用的应用窗口。'
  }
}
function doQuitApp() {
  closeQuitModal()
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'quitApp' }))
    phoneLog('ui', '确认退出当前应用: ' + (currentFrontApp && currentFrontApp.name ? currentFrontApp.name : '前台应用'))
    flashStatus('正在退出应用')
  }
}
quitBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // 打开确认框前，先向服务端询问当前前台应用，用于明确将要退出的是哪个 App；
    // 未拿到服务端结果时，回退到最近一次从面板激活/点击的应用名。
    updateQuitModal()
    ws.send(JSON.stringify({ type: 'getFrontApp' }))
    openQuitModal()
  } else { nudgeBtn(quitBtn); flashStatus('未连接') }
})
quitCancel.addEventListener('click', closeQuitModal)
quitConfirm.addEventListener('click', doQuitApp)
quitModal.addEventListener('click', (e) => { if (e.target === quitModal) closeQuitModal() })

// 优化模板选择器：手机端点「优化」时，若优化模板有多条则弹此选择器（临时选），
// 未选/选「默认」则服务端按 defaultId 兜底。列表只渲染 {id,name}，提示词正文在服务端。
function closeOptimizePicker() { if (optimizeModal) optimizeModal.classList.add('hidden') }
function optimizeChoiceBtn(promptId, label) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'optimize-choice'
  b.textContent = label
  b.addEventListener('click', () => {
    closeOptimizePicker()
    ws.send(JSON.stringify(promptId ? { type: 'optimize', promptId } : { type: 'optimize' }))
    phoneLog('ui', '选择优化模板: ' + label)
  })
  return b
}
function openOptimizePicker() {
  if (!optimizeModal || !optimizeList) return
  optimizeList.innerHTML = ''
  const defaultName = (optimizePool.find((e) => e.id === optimizeDefaultId) || {}).name || '默认'
  optimizeList.appendChild(optimizeChoiceBtn('', '默认（' + defaultName + '）'))
  for (const e of optimizePool) {
    if (e.id === optimizeDefaultId) continue // 默认那条已在「默认」入口体现，避免重复
    optimizeList.appendChild(optimizeChoiceBtn(e.id, e.name))
  }
  optimizeModal.classList.remove('hidden')
}
if (optimizeCancel) optimizeCancel.addEventListener('click', closeOptimizePicker)
if (optimizeModal) optimizeModal.addEventListener('click', (e) => { if (e.target === optimizeModal) closeOptimizePicker() })

// 语音识别不可用弹框：云端未配 Key / 本地未下载模型时，点「说话」被拦截并说明原因与操作。
function closeAsrErrorModal() { if (asrErrorModal) asrErrorModal.classList.add('hidden') }
function showAsrUnavailableDialog(provider, cloud, offline) {
  if (!asrErrorModal) return
  let title = '语音识别暂不可用'
  let text
  if (!cloud && !offline) {
    text = '云端识别未配置 API Key，本地识别未下载离线模型，两种方式目前都无法使用。请在 Mac 控制面板「识别服务」中配置 API Key，或点击「下载离线模型」。'
  } else if (provider === 'sherpa') {
    title = '本地识别未就绪'
    text = '本地识别需要先下载离线模型。请在 Mac 控制面板「识别服务」点击「下载离线模型」，或切换到「云端」模式。'
  } else {
    title = '云端识别未就绪'
    text = '云端识别需要先配置百炼 API Key。请在 Mac 控制面板「识别服务」填写 API Key，或切换到「本地」模式。'
  }
  if (asrErrorTitle) asrErrorTitle.textContent = title
  if (asrErrorText) asrErrorText.textContent = text
  asrErrorModal.classList.remove('hidden')
}
if (asrErrorOk) asrErrorOk.addEventListener('click', closeAsrErrorModal)
if (asrErrorModal) asrErrorModal.addEventListener('click', (e) => { if (e.target === asrErrorModal) closeAsrErrorModal() })

// 对话 <-> 触摸板 页面切换（左右滑动关系，不重叠）
function syncMouseModeUI() {
  if (mouseBtn) mouseBtn.classList.toggle('active', mouseMode)
  toolsBtn.classList.toggle('trackpad-on', mouseMode)
  resultArea.classList.toggle('mouse-active', mouseMode)
  if (mouseSub) mouseSub.textContent = mouseMode ? '已开启' : ''
  if (pageSwitch) {
    pageSwitch.classList.toggle('on-trackpad', mouseMode)
    pageSwitch.setAttribute('aria-checked', String(mouseMode))
    pageSwitch.setAttribute('aria-label', '页面切换')
    pageSwitch.querySelectorAll('.rdot').forEach((d, i) => d.classList.toggle('is-active', i === pageIndex))
  }
}
function setPage(pageName) {
  const idx = PAGES.indexOf(pageName)
  if (idx < 0) return
  const on = pageName === 'trackpad'
  if (on === mouseMode) { pageIndex = idx; syncMouseModeUI(); return }
  pageIndex = idx
  mouseMode = on
  if (!mouseMode) { resetMouseGesture(); setTrackpointActive(false); }
  syncMouseModeUI()
  flashStatus(on ? '已切换到触摸板' : '已回到对话')
  phoneLog('ui', '页面: ' + (on ? '触摸板' : '对话'))
}
function advancePage(dir) {
  const n = PAGES.length
  setPage(PAGES[(pageIndex + dir + n) % n])
}
function renderRollerDots() {
  if (!rollerDots) return
  rollerDots.innerHTML = ''
  PAGES.forEach(() => {
    const d = document.createElement('span')
    d.className = 'rdot'
    rollerDots.appendChild(d)
  })
  syncMouseModeUI()
}
// 顶栏滚轮：点按拨一格；在滚轮上左右轻扫可前进/后退一格（环形循环，后续可加更多页面）
// 统一用 Pointer Events：手机触摸与 PC 鼠标行为一致，避免 touchstart/touchend + click 叠加导致“点了没反应/误触”。
if (pageSwitch) {
  let _sx = 0, _sy = 0, _swiped = false, _ptDown = false
  pageSwitch.addEventListener('pointerdown', (e) => {
    _sx = e.clientX; _sy = e.clientY; _swiped = false; _ptDown = true
    try { pageSwitch.setPointerCapture(e.pointerId) } catch {}
  })
  pageSwitch.addEventListener('pointerup', (e) => {
    if (!_ptDown) return
    _ptDown = false
    const dx = e.clientX - _sx, dy = e.clientY - _sy
    if (Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy)) {
      _swiped = true
      advancePage(dx < 0 ? 1 : -1)
    }
  })
  pageSwitch.addEventListener('pointercancel', () => { _ptDown = false; _swiped = false })
  pageSwitch.addEventListener('click', (e) => {
    if (_swiped) { _swiped = false; return }
    advancePage(1)
  })
}
renderRollerDots()
// 触摸板不再有独立按钮：通过对话页左滑进入、触摸板左边缘右滑返回

function flushMouseMove() {
  if (!mouseMode) return
  if (!(ws && ws.readyState === WebSocket.OPEN)) {
    mouseAccum = { x: 0, y: 0 }
    mouseScrollAccum = { x: 0, y: 0 }
    return
  }
  if (mouseScrollAccum.x || mouseScrollAccum.y) {
    ws.send(JSON.stringify({ type: 'mouseScroll', dx: mouseScrollAccum.x, dy: mouseScrollAccum.y }))
    mouseScrollAccum = { x: 0, y: 0 }
  } else if (mouseAccum.x || mouseAccum.y) {
    ws.send(JSON.stringify({ type: 'mouseMove', dx: mouseAccum.x, dy: mouseAccum.y }))
    mouseAccum = { x: 0, y: 0 }
  }
}

// 单指光标加速度：慢速微动放大，速度升高按指数回落至 1:1
function mouseAccelGain(speed) {
  if (speed <= MOUSE_ACCEL_SLOW) return MOUSE_ACCEL_SLOW_GAIN
  return 1 + (MOUSE_ACCEL_SLOW_GAIN - 1) * Math.exp(-(speed - MOUSE_ACCEL_SLOW) / MOUSE_ACCEL_SLOW)
}

function closeTray() {
  trayOpen = false
  trayMode = 'switch'
  switcherBtn.classList.remove('active')
  switcherBtn.setAttribute('aria-pressed', 'false')
  switcherText.textContent = ''
  appTrayOverlay.classList.add('hidden')
  appTray.innerHTML = ''
  flashStatus('已关闭')
}
// 点击覆盖层背景（面板外侧的模糊区域）即取消，不触发任何应用切换
// 判断更宽松：只要点击落在面板(appTray)之外就收起；同时保证点击面板内部不会误关
appTrayOverlay.addEventListener('click', (e) => {
  if (e.target === appTrayOverlay || !appTray.contains(e.target)) closeTray()
})

function renderApps(apps) {
  appTray.innerHTML = ''
  const isLaunch = trayMode === 'launch'
  if (!apps.length) {
    flashStatus(isLaunch ? '没有可启动的应用' : '没有可切换的应用')
    return
  }
  for (const app of apps) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'app-item'
    const img = document.createElement('img')
    img.src = app.icon || ''
    img.alt = app.name
    const name = document.createElement('span')
    name.textContent = app.name
    item.append(img, name)
    item.addEventListener('click', () => {
      currentFrontApp = app
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'activateApp', bundleId: app.bundleId }))
        phoneLog('ui', (isLaunch ? '启动应用: ' : '激活应用: ') + app.name)
      }
      if (isLaunch) {
        // 启动台：启动单个应用后收回面板
        closeTray()
        flashStatus('已打开 ' + app.name)
      } else {
        // 切换 App：面板保持展开，支持连续切换多个应用；点面板外模糊区域才关闭
        appTray.querySelectorAll('.app-item').forEach((el) => el.classList.remove('selected'))
        item.classList.add('selected')
        void item.offsetWidth
        flashStatus('已切换到 ' + app.name + '，点外部关闭')
      }
    })
    appTray.appendChild(item)
  }
}

function nudgeBtn(btn) {
  btn.classList.remove('nudge')
  void btn.offsetWidth
  btn.classList.add('nudge')
}

function flashStatus(text) {
  if (!toastEl) return
  toastEl.textContent = text
  toastEl.classList.remove('hidden')
  clearTimeout(toastEl._timer)
  toastEl._timer = setTimeout(() => toastEl.classList.add('hidden'), 1600)
}

// ---------- 录音 ----------
function showHint(text, cancel) {
  recHintText.textContent = text
  recHint.classList.toggle('cancel', cancel)
  recHint.classList.remove('hidden')
}

function hideHint() {
  recHint.classList.add('hidden')
}

// 预热（折中方案）：页面加载时只预载 AudioContext + 识别模块（消掉最贵的下载延迟）。
// 麦克风仍留到按下“说话”时才打开（getUserMedia），说话结束即关，iPhone 指示条只在说话时亮。
async function warmupAudio() {
  if (audioWarm) return
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (!workletNode) {
      await audioCtx.audioWorklet.addModule('recorder-worklet.js')
      workletNode = new AudioWorkletNode(audioCtx, 'pcm-worklet')
    }
    audioWarm = true
    phoneLog('mic', '识别模块与音频上下文已预载，麦克风将在说话时打开')
  } catch (e) {
    phoneLog('mic', '音频预载失败: ' + e.message)
    audioWarm = false
  }
}

// 结束/取消本次录音后的清理：断开本次音频连接、暂停上下文，并关闭麦克风。
// 折中方案下麦克风说话结束即关（iPhone 指示条随之消失），下次按下重新 getUserMedia；
// AudioContext / worklet 模块保留复用，避免重复下载。
function teardownRecording() {
  if (audioSourceNode) { try { audioSourceNode.disconnect() } catch {} audioSourceNode = null }
  if (workletNode) { try { workletNode.disconnect() } catch {} }
  if (audioCtx && audioCtx.state === 'running') { try { audioCtx.suspend() } catch {} }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null }
}

async function startRecording() {
  if (holding) return
  // iOS 偶发同一次点击派发两次 click（间隔 ~19ms），会连发两个 start 造成并发识别会话。
  // 120ms 内忽略第二次，配合服务端会话序号作废，杜绝「旧会话超时错误覆盖新会话成功」。
  const ts = Date.now()
  if (ts - lastStartAt < 120) return
  lastStartAt = ts
  // 点“说话”立即回到对话（回显）页，确保结束后能直接看到识别回显
  recordFromTrackpad = mouseMode
  setPage('dialog')
  exitCompose()
  deleteArmed = false
  if (deleteArmTimer) clearTimeout(deleteArmTimer)
  deleteKeyArmed = false
  if (deleteKeyArmTimer) clearTimeout(deleteKeyArmTimer)
  // 新一轮说话：在最顶部新起一个实时回显框并随语句增长；页面只保留最近一条结果，新结果会替换旧结果
  partialEl.textContent = ''
  partialEl.classList.add('hidden')
  // 回显框位于面板最顶部：重置滚动位置，确保新回显框在顶部可见且随语句增长
  if (finalsEl.parentElement) finalsEl.parentElement.scrollTop = 0
  showHint(isOffline ? '本地识别中…' : '再点一次 结束', false)

  // 先标记“已按下”。此刻录音通道还没就绪，按钮进入「启动中」黄态；
  // 等通道完全打开、后端收到 start 后才切到「录音中」橙红。
  holding = true
  // 「启动中」过渡态：录音通道尚未完全打开，按钮先变黄提示正在准备，不谎报“录音中”
  talkBtn.classList.add('starting')
  talkText.textContent = '启动中…'

  try {
    await warmupAudio()
    if (!audioWarm) throw new Error('识别模块未就绪')
    // 麦克风按下才打开（折中方案）：授权首次在此弹，之后重新取 track 不再弹
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    }
    // iOS 要求 AudioContext.resume() 在用户手势内调用，点击事件即手势
    if (audioCtx.state !== 'running') await audioCtx.resume()
  } catch (e) {
    talkBtn.classList.remove('starting')
    talkText.textContent = '点击 说话'
    flashStatus('麦克风启动失败，请允许麦克风权限后重试')
    phoneLog('mic', '录音启动失败: ' + e.message)
    hideHint()
    holding = false
    return
  }
  // 启动期间若已取消，则中止（保留预载模块不销毁）
  if (!holding) { teardownRecording(); return }
  phoneLog('mic', `麦克风已就绪，AudioContext 采样率=${audioCtx.sampleRate}`)
  if (audioSourceNode) { try { audioSourceNode.disconnect() } catch {} }
  const src = audioCtx.createMediaStreamSource(mediaStream)
  audioSourceNode = src
  // 下发给 worklet 的静音门限配置，静音帧不再上行
  if (typeof vadCfg === 'object') {
    workletNode.port.postMessage({ type: 'vad', enabled: vadCfg.enabled, threshold: vadCfg.threshold, holdMs: vadCfg.holdMs })
  }
  workletNode.port.onmessage = (e) => {
    sentBytes += e.data.byteLength
    if (ws && ws.readyState === WebSocket.OPEN) {
      const now = Date.now()
      const bu = ws.bufferedAmount
      // 自适应背压：缓冲越高越狠。
      //  - bu > 2x 阈值：进入 300ms 突发丢帧退避，连续丢帧让队列尽快回落；
      //  - bu > 阈值：丢当前帧（并发日志）；
      //  - 正常：全量上行。丢帧优先于无限堆积（否则延迟/内存持续上涨）。
      if (bu > MAX_AUDIO_BUFFERED * 2) {
        burstDropUntil = now + 300
      }
      if (now < burstDropUntil || bu > MAX_AUDIO_BUFFERED) {
        droppedAudioBytes += e.data.byteLength
        if (bu > MAX_AUDIO_BUFFERED) {
          if (now - lastAudioDropLog > 2000) {
            lastAudioDropLog = now
            phoneLog('rec', `音频背压丢帧 ${(droppedAudioBytes / 1024).toFixed(0)}KB`)
          }
          if (typeof showNetHint === 'function') showNetHint()
        }
        return
      }
      ws.send(e.data)
    }
  }
  src.connect(workletNode)
  ws.send(JSON.stringify({ type: 'start' }))
  // 录音通道完全打开、后端已收到 start，此刻才从「启动中」切到「录音中」（黄 → 橙红+脉冲）
  recording = true
  talkBtn.classList.remove('starting')
  talkBtn.classList.add('recording')
  talkText.textContent = '点击结束'
  sentBytes = 0
  droppedAudioBytes = 0
  lastAudioDropLog = 0
  phoneLog('rec', '开始录音')
}

// 完全释放音频资源（页面卸载等极端场景；正常结束/取消用 teardownRecording 保留预热复用）
function disposeAudio() {
  if (audioSourceNode) { try { audioSourceNode.disconnect() } catch {} audioSourceNode = null }
  if (workletNode) { try { workletNode.disconnect() } catch {} }
  audioCtx?.close()
  mediaStream?.getTracks().forEach((t) => t.stop())
  workletNode = null
  audioCtx = null
  mediaStream = null
  audioWarm = false
}
window.addEventListener('pagehide', disposeAudio)

function stopRecording() {
  if (!holding) return
  holding = false
  phoneLog('rec', `结束录音，共上行 ${(sentBytes / 1024).toFixed(0)}KB（约 ${(sentBytes / 2 / 16000).toFixed(1)}s）`)
  if (recording && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }))
  teardownRecording()
  recording = false
  talkBtn.classList.remove('starting')
  talkBtn.classList.remove('recording')
  talkText.textContent = '点击 说话'
  hideHint()
}

function cancelRecording() {
  if (!holding) return
  holding = false
  phoneLog('rec', '取消本次识别')
  if (recording && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' }))
  teardownRecording()
  recording = false
  talkBtn.classList.remove('starting')
  talkBtn.classList.remove('recording')
  talkText.textContent = '点击 说话'
  partialEl.classList.add('hidden')
  hideHint()
  // 取消后也回弹到说话前所在页面（若在触摸板）
  if (recordFromTrackpad) {
    recordFromTrackpad = false
    setPage('trackpad')
  }
}

// ---------- 说话：点击开关（点一下开始录音，再点一下结束） ----------
// 交互从“长按说话”改为“点击开始 / 再次点击结束”，适合手机单手点按。
function onTalkToggle() {
  if (talkBtn.disabled) return
  if (inputMode === 'keyboard') {
    // 键盘模式：点「说话」不录音，而是直接唤起手机键盘。
    // 关键：必须在点击手势的同步调用栈内 focus()，iOS 才会弹出键盘；
    // setTimeout 延后会脱离手势上下文，导致切到键盘页后还得手动再点一下输入框。
    if (mouseMode) setPage('dialog')
    enterCompose() // 输入区未展开则展开（已展开是 no-op，其内部延时聚焦无副作用）
    try { composerInput.focus() } catch (_) {}
    return
  }
  if (holding) {
    // 已在录音中 → 结束并回显；仍在初始化中 → 取消本次
    if (recording) stopRecording()
    else cancelRecording()
    return
  }
  // 说话前拦截：本连接生效的引擎不可用（云端缺 Key / 本地缺模型）时，不开麦直接弹框说明。
  const need = serverProvider === 'sherpa' ? 'offline' : 'cloud'
  if (!availability[need]) {
    showAsrUnavailableDialog(serverProvider, availability.cloud, availability.offline)
    return
  }
  startRecording()
}

talkBtn.addEventListener('click', onTalkToggle)

// ---------- 触控板模式（鼠标模拟）与左右滑切窗口 ----------
let swipeX = null
let swipeY = null

function resetMouseGesture() {
  stopEdgeMovement()
  trailPoints = []
  if (trailTimer) cancelAnimationFrame(trailTimer)
  trailTimer = null
  mouseLast = null
  mouseLastT = 0
  mouseAccum = { x: 0, y: 0 }
  mouseScrollAccum = { x: 0, y: 0 }
  scrollVelSamples = []
  cancelMomentum()
  if (mouseLongPressTimer) clearTimeout(mouseLongPressTimer)
  mouseLongPressTimer = null
  if (mouseDownSent && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'mouseUp' }))
  }
  mouseDownSent = false
  mouseMoved = false
  twoFinger = false
  mouseEndPos = null
  mouseStartPos = null
  mouseStartTime = 0
  edgeHint = null
  mouseSwipeCancel = false
  mouseSwipeStartX = null
  setEdgeHighlight(null)
  if (mouseFlushTimer) clearTimeout(mouseFlushTimer)
  mouseFlushTimer = null
  // 小红点摇杆：仅复位长按候选/空闲定时器；滚轮模式是否退出由调用方显式控制
  if (tpHoldTimer) { clearTimeout(tpHoldTimer); tpHoldTimer = null }
  clearTpIdle()
  if (tpFlushTimer) { clearTimeout(tpFlushTimer); tpFlushTimer = null }
  tpArm = null
  tpScrollAccum = { x: 0, y: 0 }
  threeFinger = false
  threeFingerFired = false
  threeFingerStart = null
}

function edgeDirectionAt(x, y) {
  const r = resultArea.getBoundingClientRect()
  const dist = {
    left: x - r.left,
    right: r.right - x,
    top: y - r.top,
    bottom: r.bottom - y,
  }
  const min = Math.min(dist.left, dist.right, dist.top, dist.bottom)
  if (min > trackpadCfg.edgeZonePx) return null
  if (min === dist.left) return 'left'
  if (min === dist.right) return 'right'
  if (min === dist.top) return 'up'
  return 'down'
}

function stopEdgeMovement() {
  if (edgeDwellTimer) clearTimeout(edgeDwellTimer)
  edgeDwellTimer = null
  if (edgeStepTimer) clearInterval(edgeStepTimer)
  edgeStepTimer = null
  edgeDirection = null
  edgeVector = null
  edgeStep = null
  // 退出边缘连续移动时清零累积位移：光标在屏幕边缘被钳制后，
  // 继续喂入的增量不应变成“必须回滑补偿”的累积数据。
  mouseAccum = { x: 0, y: 0 }
  mouseScrollAccum = { x: 0, y: 0 }
  setEdgeHighlight(null)
}

function stepFromVector(dir) {
  if (edgeVector) return { x: edgeVector.x * trackpadCfg.edgeSpeed, y: edgeVector.y * trackpadCfg.edgeSpeed }
  const sp = trackpadCfg.edgeSpeed
  const axis = {
    up: [0, -sp],
    down: [0, sp],
    left: [-sp, 0],
    right: [sp, 0],
  }[dir]
  return { x: axis[0], y: axis[1] }
}

function startEdgeDwell() {
  stopEdgeMovement()
  if (!mouseMode) return
  edgeDwellTimer = setTimeout(() => {
    edgeDwellTimer = null
    if (!mouseMode || !mouseLast) return
    const dir = edgeDirectionAt(mouseLast.x, mouseLast.y)
    if (!dir) return
    edgeDirection = dir
    edgeStep = stepFromVector(dir)
    setEdgeHighlight(dir, true)
    // 边缘连续移动模式下不触发长按拖动
    if (mouseLongPressTimer) clearTimeout(mouseLongPressTimer)
    mouseLongPressTimer = null
    mouseMoved = true
    edgeStepTimer = setInterval(() => {
      if (!mouseMode || !edgeDirection) {
        stopEdgeMovement()
        return
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mouseMove', dx: edgeStep.x, dy: edgeStep.y }))
      }
    }, trackpadCfg.edgeStepMs)
    phoneLog('ui', '边缘连续移动: ' + dir)
  }, trackpadCfg.edgeDwellMs)
}

// 边缘反馈：当手指贴边/进入连续移动状态时，用颜色高亮对应边
function setEdgeHighlight(dir, active) {
  for (const k of ['up', 'down', 'left', 'right']) {
    const el = edgeIndicators[k]
    if (!el) continue
    el.classList.toggle('near', k === dir)
    el.classList.toggle('active', k === dir && !!active)
  }
}

function resizeTouchCanvas() {
  if (!touchCanvas || !touchCtx) return
  const dpr = window.devicePixelRatio || 1
  touchCanvas.width = Math.round(touchCanvas.clientWidth * dpr)
  touchCanvas.height = Math.round(touchCanvas.clientHeight * dpr)
  touchCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function pruneTrail() {
  const now = Date.now()
  trailPoints = trailPoints.filter((p) => now - p.t <= trackpadCfg.trailMs)
}

function ensureTrailLoop() {
  if (trailTimer) return
  // 用 requestAnimationFrame 驱动：跟随屏幕刷新率，触摸结束即停止，避免 setInterval 空转
  const loop = () => {
    if (!mouseMode || !mouseLast) {
      trailPoints = []
      trailTimer = null
      return
    }
    pruneTrail()
    drawTouchVector()
    trailTimer = requestAnimationFrame(loop)
  }
  trailTimer = requestAnimationFrame(loop)
}

function clearTouchCanvas() {
  if (!touchCanvas || !touchCtx) return
  touchCtx.clearRect(0, 0, touchCanvas.clientWidth, touchCanvas.clientHeight)
}

// 橡皮筋画绳：滚轮模式下在画布上画「圆心→手指」的绳，同时显示触发区圆圈与满速圈。
function drawTrackpointRope(x, y) {
  if (!touchCanvas || !touchCtx) return
  clearTouchCanvas()
  if (!tpStartCenter) return
  const rect = resultArea.getBoundingClientRect()
  const cx = tpStartCenter.x - rect.left
  const cy = tpStartCenter.y - rect.top
  const fx = x - rect.left
  const fy = y - rect.top
  const dist = Math.hypot(fx - cx, fy - cy)
  const maxR = Math.max(1, trackpadCfg.tpMaxRadius)
  const hitR = Math.max(1, TP_HIT_RADIUS)
  const tension = Math.min(1, dist / maxR) // 0..1 皮筋拉伸程度

  touchCtx.save()
  touchCtx.lineCap = 'round'

  // 触发区圆圈（淡实线）：提示用户按在这个范围内可继续滚动
  touchCtx.strokeStyle = 'rgba(180, 83, 14, .16)'
  touchCtx.lineWidth = 1.2
  touchCtx.beginPath()
  touchCtx.arc(cx, cy, hitR, 0, Math.PI * 2)
  touchCtx.stroke()

  // 满速同心圆边界（虚线轮廓）
  touchCtx.setLineDash([4, 5])
  touchCtx.strokeStyle = 'rgba(180, 83, 14, .28)'
  touchCtx.lineWidth = 1.4
  touchCtx.beginPath()
  touchCtx.arc(cx, cy, maxR, 0, Math.PI * 2)
  touchCtx.stroke()
  touchCtx.setLineDash([])

  // 绳：圆心 → 手指，拉伸越紧线越实越粗
  touchCtx.strokeStyle = `rgba(180, 83, 14, ${0.35 + 0.45 * tension})`
  touchCtx.lineWidth = 1.8 + 2.6 * tension
  touchCtx.beginPath()
  touchCtx.moveTo(cx, cy)
  touchCtx.lineTo(fx, fy)
  touchCtx.stroke()

  // 圆心锚点
  touchCtx.beginPath()
  touchCtx.arc(cx, cy, 4.5, 0, Math.PI * 2)
  touchCtx.fillStyle = 'rgba(180, 83, 14, .85)'
  touchCtx.fill()

  // 手指端小球
  touchCtx.beginPath()
  touchCtx.arc(fx, fy, 7, 0, Math.PI * 2)
  touchCtx.fillStyle = `rgba(180, 83, 14, ${0.5 + 0.4 * tension})`
  touchCtx.fill()
  touchCtx.beginPath()
  touchCtx.arc(fx, fy, 2.8, 0, Math.PI * 2)
  touchCtx.fillStyle = 'rgba(255, 255, 255, .9)'
  touchCtx.fill()

  touchCtx.restore()
}

function drawTouchVector() {
  clearTouchCanvas()
  if (!touchCtx || !mouseStartPos || !mouseLast) return
  const rect = resultArea.getBoundingClientRect()
  // 只保留最近 1 秒内的移动点，用于手写轨迹
  pruneTrail()
  if (trailPoints.length < 2) return
  const pts = trailPoints.map((p) => ({ x: p.x - rect.left, y: p.y - rect.top }))

  touchCtx.save()
  touchCtx.lineCap = 'round'
  touchCtx.lineJoin = 'round'
  // 去掉 shadowBlur：由宽到窄、由淡到浓叠三层已足够有笔刷墨迹感，阴影是低端安卓平板上主要绘制开销
  strokeSmoothPath(pts, 'rgba(46, 158, 108, .10)', 14)
  strokeSmoothPath(pts, 'rgba(63, 174, 116, .42)', 6)
  strokeSmoothPath(pts, 'rgba(30, 122, 80, .92)', 2.4)

  // 笔尖：当前触点，做一小段墨点 + 高光
  const head = pts[pts.length - 1]
  touchCtx.beginPath()
  touchCtx.arc(head.x, head.y, 3.4, 0, Math.PI * 2)
  touchCtx.fillStyle = '#1e7a50'
  touchCtx.fill()
  touchCtx.beginPath()
  touchCtx.arc(head.x, head.y, 1.4, 0, Math.PI * 2)
  touchCtx.fillStyle = 'rgba(255, 255, 255, .85)'
  touchCtx.fill()

  touchCtx.restore()
}

// 用中点二次贝塞尔把轨迹画成平滑曲线（手写笔刷感）
function strokeSmoothPath(pts, color, width) {
  touchCtx.beginPath()
  touchCtx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    touchCtx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  touchCtx.lineTo(last.x, last.y)
  touchCtx.strokeStyle = color
  touchCtx.lineWidth = width
  touchCtx.stroke()
}

function scheduleMouseFlush() {
  if (mouseFlushTimer) return
  mouseFlushTimer = setTimeout(() => {
    mouseFlushTimer = null
    flushMouseMove()
  }, 30)
}

// ================= 双指惯性滚动 =================
// 手指松开瞬间，按松手前 ~80ms 的平均速度，用指数衰减曲线继续产生递减的滚动增量，
// 直到速度低于停止阈值（或超时）。增量走与手指拖动完全相同的 mouseScrollAccum/节流通道，
// 因此方向约定、灵敏度缩放全部自动保持一致。
function sampleScrollVelocity(x, y) {
  const now = Date.now()
  scrollVelSamples.push({ t: now, x, y })
  const cutoff = now - VEL_SAMPLE_MS
  while (scrollVelSamples.length && scrollVelSamples[0].t < cutoff) scrollVelSamples.shift()
}
function scrollVelocity() {
  if (scrollVelSamples.length < 2) return { x: 0, y: 0 }
  // 取窗口内相邻采样点的峰值速度：捕捉「甩动瞬间」的速度，
  // 避免松手前手指自然减速把两端平均值稀释掉，导致惯性难以触发。
  let vx = 0, vy = 0, maxSpeed = 0
  for (let i = 1; i < scrollVelSamples.length; i++) {
    const a = scrollVelSamples[i - 1]
    const b = scrollVelSamples[i]
    const dt = b.t - a.t
    if (dt <= 0) continue
    const svx = (b.x - a.x) / dt
    const svy = (b.y - a.y) / dt
    const s = Math.hypot(svx, svy)
    if (s > maxSpeed) { maxSpeed = s; vx = svx; vy = svy }
  }
  return { x: vx, y: vy }
}
function startScrollMomentum(vx, vy) {
  // 上移（vy<0）速度补偿：人体「上推」的行程与速度天然小于「下拉」，
  // 同样的甩动意图上推算出的速度偏低，放大后使上移与下移的触发/滑行手感对齐。
  if (vy < 0) vy *= MOMENTUM_UP_GAIN
  if (Math.hypot(vx, vy) < MOMENTUM_THRESHOLD) return
  cancelMomentum()
  momentumVx = vx
  momentumVy = vy
  momentumStartT = performance.now()
  momentumLastT = momentumStartT
  momentumAnim = requestAnimationFrame(stepMomentum)
}
function stepMomentum(now) {
  const dt = Math.max(0, now - momentumLastT)
  momentumLastT = now
  const decay = Math.exp(-dt / MOMENTUM_TAU)
  momentumVx *= decay
  momentumVy *= decay
  const speed = Math.hypot(momentumVx, momentumVy)
  if (speed < MOMENTUM_MIN_V || now - momentumStartT > MOMENTUM_MAX_MS) {
    cancelMomentum()
    flushMouseMove()
    return
  }
  mouseScrollAccum.x += momentumVx * dt
  mouseScrollAccum.y += momentumVy * dt
  scheduleMouseFlush()
  momentumAnim = requestAnimationFrame(stepMomentum)
}
function cancelMomentum() {
  if (momentumAnim) {
    cancelAnimationFrame(momentumAnim)
    momentumAnim = null
  }
  momentumVx = 0
  momentumVy = 0
}

resultArea.addEventListener('touchstart', (e) => {
  if (mouseMode) {
    e.preventDefault()
    if (e.touches.length === 3) {
      // 第三指落下：从双指滚动切换为三指滑动（切 Spaces / 任务控制 / App 窗口）
      setTrackpointActive(false) // 退出滚轮模式（若正按住红点）
      resetMouseGesture()
      threeFinger = true
      threeFingerFired = false
      threeFingerStart = touchCentroid(e.touches)
      return
    }
    if (e.touches.length === 2) {
      resetMouseGesture()
      twoFinger = true
      const a = e.touches[0]
      const b = e.touches[1]
      mouseLast = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
      return
    }
    if (e.touches.length === 1) {
      if (trackpadCfg.tpEnabled) {
        const t = e.touches[0]
        const hitHot = inTrackpoint(t.clientX, t.clientY)
        // —— 滚轮模式已开启 ——
        if (tpActive) {
          if (hitHot) {
            // 触发区内按下 → 继续/恢复滚动
            resetMouseGesture()
            tpTouch = { source: 'dot', startX: t.clientX, startY: t.clientY, startT: Date.now(), lastX: t.clientX, lastY: t.clientY }
            tpStartCenter = trackpointCenter()
            clearTpIdle()
            startTrackpointLoop()
            return
          }
          // 触发区外按下 → 普通鼠标移动，但保持 armed 状态
          clearTpIdle()
          armTpIdle()
          // fall through 到普通光标逻辑
        }
        // —— 未开启：若点在触发区内，进入「长按候选」——
        if (hitHot) {
          resetMouseGesture()
          const c = trackpointCenter()
          tpArm = { cx: c.x, cy: c.y, downX: t.clientX, downY: t.clientY, startT: Date.now() }
          // 预置光标基准，这样若长按失败/滑动则无缝转回光标逻辑
          mouseLast = { x: t.clientX, y: t.clientY }
          mouseStartPos = { x: t.clientX, y: t.clientY }
          mouseStartTime = Date.now()
          mouseEndPos = { x: t.clientX, y: t.clientY }
          mouseSwipeStartX = t.clientX
          if (tpHoldTimer) clearTimeout(tpHoldTimer)
          tpHoldTimer = setTimeout(() => {
            tpHoldTimer = null
            if (tpArm) {
              // 长按达到：激活滚轮模式（红点亮 + 顶部徽标），此时手指仍按在红点上。
              // 必须立刻建立 tpTouch，否则后续 touchmove 进不了滚动分支（这是"激活滚不动"的根因）。
              const ax = tpArm.downX
              const ay = tpArm.downY
              const at = tpArm.startT
              const c0x = tpArm.cx
              const c0y = tpArm.cy
              tpArm = null
              setTrackpointActive(true)
              tpStartCenter = { x: c0x, y: c0y }
              tpTouch = { source: 'dot', startX: ax, startY: ay, startT: at, lastX: ax, lastY: ay }
              drawTrackpointRope(ax, ay) // 立刻画出绳与锚点，手指还在红点上时即有反馈
              mouseAccum = { x: 0, y: 0 }
              mouseScrollAccum = { x: 0, y: 0 }
              tpScrollAccum = { x: 0, y: 0 }
              startTrackpointLoop()
              phoneLog('ui', '滚轮模式')
            }
          }, trackpadCfg.tpLongPressMs)
          return
        }
      }
      // —— 普通光标/双指/边缘（现有逻辑）——
      resetMouseGesture()
      const t = e.touches[0]
      mouseLast = { x: t.clientX, y: t.clientY }
      mouseLastT = Date.now()
      mouseStartPos = { x: t.clientX, y: t.clientY }
      mouseStartTime = Date.now()
      mouseEndPos = { x: t.clientX, y: t.clientY }
      mouseSwipeStartX = t.clientX
      trailPoints = [{ x: t.clientX, y: t.clientY, t: Date.now() }]
      ensureTrailLoop()
      resizeTouchCanvas()
      drawTouchVector()
      startEdgeDwell()
      mouseLongPressTimer = setTimeout(() => {
        mouseLongPressTimer = null
        if (!twoFinger && !mouseMoved && ws && ws.readyState === WebSocket.OPEN) {
          mouseDownSent = true
          ws.send(JSON.stringify({ type: 'mouseDown' }))
          phoneLog('ui', '鼠标长按')
        }
      }, 350)
      return
    }
    return
  }
  if (e.touches.length !== 1) return
  // 键盘模式下，只有从输入区起笔的触摸才不触发页面左右滑动（避免滑动切页误触）；
  // 输入区之外（如面板空白处）仍可正常滑动切页——键盘是常驻模式，不能把用户困在对话页。
  if (composing && e.target.closest && e.target.closest('.composer')) return
  swipeX = e.touches[0].clientX
  swipeY = e.touches[0].clientY
}, { passive: false })

resultArea.addEventListener('touchmove', (e) => {
  if (mouseMode) {
    e.preventDefault()
    // —— 三指滑动：切 Spaces / 任务控制 / App 窗口（一次滑动只触发一次）——
    if (threeFinger && e.touches.length === 3) {
      const c = touchCentroid(e.touches)
      const dx = c.x - threeFingerStart.x
      const dy = c.y - threeFingerStart.y
      if (!threeFingerFired) {
        const ax = Math.abs(dx)
        const ay = Math.abs(dy)
        if (ax > THREE_SWIPE_PX || ay > THREE_SWIPE_PX) {
          if (ax > ay) {
            threeFingerGesture(dx < 0 ? 'spacesRight' : 'spacesLeft', dx < 0 ? '下一个空间' : '上一个空间')
          } else {
            threeFingerGesture(dy > 0 ? 'expose' : 'mission', dy > 0 ? 'App 窗口' : '任务控制')
          }
          threeFingerFired = true
        }
      }
      return
    }
    // —— 红点摇杆/精细滚轮（滚轮模式内）：定时轮询持续滚动 ——
    if (tpActive && tpTouch && e.touches.length === 1) {
      const t = e.touches[0]
      trackpointDrag(t.clientX, t.clientY)
      return
    }
    // —— 长按候选：位移超标即作废臂，转普通光标 ——
    if (tpArm && e.touches.length === 1) {
      const t = e.touches[0]
      if (Math.hypot(t.clientX - tpArm.downX, t.clientY - tpArm.downY) > TP_DRAG_TOL) {
        if (tpHoldTimer) { clearTimeout(tpHoldTimer); tpHoldTimer = null }
        tpArm = null // 放弃长按激活，走普通单指光标/边缘逻辑
      } else {
        return // 仍处臂：不移动光标，等长按或超容忍
      }
    }
    if (twoFinger && e.touches.length === 2) {
      const a = e.touches[0]
      const b = e.touches[1]
      const mx = (a.clientX + b.clientX) / 2
      const my = (a.clientY + b.clientY) / 2
      if (mouseLast) {
        mouseScrollAccum.x += mx - mouseLast.x
        mouseScrollAccum.y += my - mouseLast.y
      }
      mouseLast = { x: mx, y: my }
      sampleScrollVelocity(mx, my)
      scheduleMouseFlush()
      return
    }
    if (e.touches.length === 1 && mouseLast) {
      const t = e.touches[0]
      // 左边缘右滑返回：仅当从很窄的边缘带内开始、水平快速大幅滑动时才触发，
      // 避免与正常鼠标光标移动混淆（误触发返回）。
      if (mouseSwipeStartX !== null && mouseStartTime) {
        const r = resultArea.getBoundingClientRect()
        const ddx = t.clientX - mouseSwipeStartX
        const ddy = mouseStartPos ? t.clientY - mouseStartPos.y : 0
        const elapsed = Date.now() - mouseStartTime
        const startedInEdgeZone = (mouseSwipeStartX - r.left) <= 32
        const dominantHorizontal = Math.abs(ddx) > Math.abs(ddy) * 1.3
        if (startedInEdgeZone && ddx > 90 && dominantHorizontal && elapsed < 650) {
          mouseSwipeCancel = true
          setPage('dialog')
          return
        }
      }
      const atEdge = edgeDirectionAt(t.clientX, t.clientY)
      const vx = t.clientX - mouseStartPos.x
      const vy = t.clientY - mouseStartPos.y
      const vLen = Math.hypot(vx, vy)
      edgeVector = vLen > 4 ? { x: vx / vLen, y: vy / vLen } : null
      // 手指虽在边缘像素带内，但正在“远离”该边缘（向内/向屏幕中心移动）时，
      // 立即退出边缘连续移动并按普通相对位移处理。否则边缘推送的增量会在屏幕
      // 边缘被 macOS 钳制后不断累积，导致必须大量回滑才能让光标恢复移动。
      let movingAway = false
      if (atEdge) {
        movingAway =
          (atEdge === 'right' && t.clientX < mouseLast.x) ||
          (atEdge === 'left' && t.clientX > mouseLast.x) ||
          (atEdge === 'up' && t.clientY > mouseLast.y) ||
          (atEdge === 'down' && t.clientY < mouseLast.y)
      }
      if (atEdge && !movingAway) {
        setEdgeHighlight(atEdge, edgeDirection === atEdge)
        mouseLast = { x: t.clientX, y: t.clientY }
        mouseEndPos = { x: t.clientX, y: t.clientY }
        trailPoints.push({ x: t.clientX, y: t.clientY, t: Date.now() })
        pruneTrail()
        if (edgeDirection) edgeStep = stepFromVector(edgeDirection)
        if (!edgeDirection && !edgeDwellTimer) startEdgeDwell()
        drawTouchVector()
        return
      }
      // 退出边缘模式后先清零累积，再进入普通相对移动
      setEdgeHighlight(null)
      if (edgeDirection || edgeDwellTimer) stopEdgeMovement()
      if (!mouseMoved && mouseStartPos && Math.hypot(t.clientX - mouseStartPos.x, t.clientY - mouseStartPos.y) > 10) {
        mouseMoved = true
      }
      const now = Date.now()
      const mvx = t.clientX - mouseLast.x
      const mvy = t.clientY - mouseLast.y
      const mdt = now - mouseLastT
      const mspeed = mdt > 0 ? Math.hypot(mvx, mvy) / mdt : 0
      const mgain = mouseAccelGain(mspeed)
      mouseAccum.x += mvx * mgain
      mouseAccum.y += mvy * mgain
      mouseLast = { x: t.clientX, y: t.clientY }
      mouseLastT = now
      mouseEndPos = { x: t.clientX, y: t.clientY }
      trailPoints.push({ x: t.clientX, y: t.clientY, t: Date.now() })
      pruneTrail()
      drawTouchVector()
      scheduleMouseFlush()
      return
    }
    return
  }
  if (swipeX === null) return
  if (composing) return
  const t = e.touches[0]
  const dx = t.clientX - swipeX
  const dy = t.clientY - swipeY
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    swipeX = null
    swipeY = null
    // 对话页：手指往左侧轻滑 -> 切换到触摸板
    if (!trayOpen) {
      if (dx < 0) {
        setPage('trackpad')
      }
      return
    }
    // 打开切换面板后，左右滑动切换 App
    if (!(ws && ws.readyState === WebSocket.OPEN)) return
    const dir = dx < 0 ? 'next' : 'prev'
    ws.send(JSON.stringify({ type: 'window', dir }))
    phoneLog('ui', '左右滑动切换窗口: ' + dir)
  }
}, { passive: false })

resultArea.addEventListener('touchend', (e) => {
  swipeX = null
  swipeY = null
  if (mouseMode) {
    e.preventDefault()
    // —— 红点摇杆/精细滚轮（松手）——
    if (tpActive && tpTouch) {
      const held = Date.now() - tpTouch.startT
      const moved = Math.hypot(tpTouch.lastX - tpTouch.startX, tpTouch.lastY - tpTouch.startY)
      if (tpTouch.source === 'dot' && held < 400 && moved < TP_DRAG_TOL) {
        // 触发区内快速点按 → 退出滚轮模式
        setTrackpointActive(false)
        tpTouch = null
        tpScrollAccum = { x: 0, y: 0 }
        if (tpFlushTimer) { clearTimeout(tpFlushTimer); tpFlushTimer = null }
        clearTouchCanvas()
        return
      }
      // 普通松手：捕获松手瞬间红点偏移速度，进入 armed 状态 5s 并惯性滑行
      const releaseV = trackpointScrollVelocity(tpTouch.lastX, tpTouch.lastY)
      tpTouch = null
      tpScrollAccum = { x: 0, y: 0 }
      if (tpFlushTimer) { clearTimeout(tpFlushTimer); tpFlushTimer = null }
      armTpIdle()
      clearTouchCanvas()
      if (releaseV.x || releaseV.y) startTpMomentum(releaseV.x, releaseV.y)
      return
    }
    // 长按候选未到激活就抬手：当作一次轻点（在红点上），忽略，不作为鼠标点击
    if (tpArm) {
      if (tpHoldTimer) { clearTimeout(tpHoldTimer); tpHoldTimer = null }
      tpArm = null
      return
    }
    const wasTwoFinger = twoFinger
    const wasMoved = mouseMoved
    const wasDown = mouseDownSent
    const elapsed = Date.now() - mouseStartTime
    const endPos = mouseEndPos
    const momentumStart = wasTwoFinger ? scrollVelocity() : null
    flushMouseMove()
    resetMouseGesture()
    clearTouchCanvas()
    if (wasTwoFinger && momentumStart) startScrollMomentum(momentumStart.x, momentumStart.y)
    if (!wasTwoFinger && !wasMoved && !wasDown && elapsed < 350 && ws && ws.readyState === WebSocket.OPEN) {
      const rect = resultArea.getBoundingClientRect()
      const inBottomZone = endPos && rect.bottom - endPos.y <= 58
      const isRight = endPos && endPos.x > rect.left + rect.width / 2
      if (inBottomZone && isRight) {
        ws.send(JSON.stringify({ type: 'mouseRightClick' }))
        phoneLog('ui', '右键点击')
      } else {
        ws.send(JSON.stringify({ type: 'mouseClick' }))
        phoneLog('ui', '鼠标轻点')
      }
    }
    return
  }
  flushMouseMove()
})
resultArea.addEventListener('touchcancel', () => {
  swipeX = null
  swipeY = null
  if (mouseMode) {
    resetMouseGesture()
    setTrackpointActive(false)
    clearTouchCanvas()
    return
  }
  flushMouseMove()
})
