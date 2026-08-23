// PhVoice 手机端：点击说话开关 → PCM 流上行；partial 实时展示；再点结束
const statusEl = document.getElementById('status')
const partialEl = document.getElementById('partial')
const finalsEl = document.getElementById('finals')
const talkBtn = document.getElementById('talk')
const talkText = document.getElementById('talkText')
const enterBtn = document.getElementById('enterBtn')
const deleteBtn = document.getElementById('deleteBtn')
const switcherBtn = document.getElementById('switcherBtn')
const switcherText = document.getElementById('switcherText')
const appTray = document.getElementById('appTray')
const appTrayOverlay = document.getElementById('appTrayOverlay')
const missionBtn = document.getElementById('missionBtn')
const exposeBtn = document.getElementById('exposeBtn')
const launchpadBtn = document.getElementById('launchpadBtn')
const islandCloseBtn = document.getElementById('islandCloseBtn')
const mouseBtn = document.getElementById('mouseBtn')
const quitBtn = document.getElementById('quitBtn')
const recHint = document.getElementById('recHint')
const recHintText = document.getElementById('recHintText')
const resultArea = document.querySelector('.result-area')
const touchCanvas = document.getElementById('touchCanvas')
const touchCtx = touchCanvas ? touchCanvas.getContext('2d') : null
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
const pageSwitch = document.getElementById('pageSwitch')
const rollerDots = document.getElementById('rollerDots')
const toastEl = document.getElementById('toast')
const composeToggle = document.getElementById('composeToggle')
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
let trayOpen = false
let trayMode = 'switch' // 'switch' | 'launch'
let composing = false
let composeAttachments = [] // { kind, name, mime, size, base64, previewUrl }
const MAX_COMPOSE_FILES = 5
const MAX_COMPOSE_BYTES = 20 * 1024 * 1024
let currentFrontApp = null
let appListCache = []
let mouseMode = true
// 页面循环结构：往滚轮里追加页面名即可扩展（对话 → 触摸板 → …循环）
const PAGES = ['dialog', 'trackpad']
const PAGE_LABELS = { dialog: '对话', trackpad: '触摸板' }
let pageIndex = 1
let mouseLast = null
let mouseAccum = { x: 0, y: 0 }
let mouseScrollAccum = { x: 0, y: 0 }
let mouseFlushTimer = null
let mouseDownSent = false
let mouseMoved = false
let mouseStartTime = 0
let mouseStartPos = null
let mouseLongPressTimer = null
let twoFinger = false
// 触控板参数：默认值与 config.json 的 trackpad 一致；服务端在 /ws 连接时随 settings 下发可调配置
const TRACKPAD_DEFAULTS = { sensitivity: 1.8, edgeZonePx: 18, edgeDwellMs: 250, edgeStepMs: 30, edgeSpeed: 12, trailMs: 1000 }
let trackpadCfg = { ...TRACKPAD_DEFAULTS }
function applyTrackpad(cfg) {
  if (!cfg || typeof cfg !== 'object') return
  trackpadCfg = { ...TRACKPAD_DEFAULTS, ...cfg }
}
// VAD（静音门限）配置，默认与服务端 config.json 的 vad 一致；
// worklet 会在录音时收到此配置，静音帧不再上行（省流量/省费用）。
const VAD_DEFAULTS = { enabled: true, threshold: 0.006, holdMs: 260 }
let vadCfg = { ...VAD_DEFAULTS }
function applyVad(cfg) {
  if (!cfg || typeof cfg !== 'object') return
  vadCfg = { ...VAD_DEFAULTS, ...cfg }
}
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
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onopen = () => {
    reconnectAttempt = 0
    heartbeatMissed = 0
    startHeartbeat()
    phoneLog('ui', 'client v39 loaded')
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
  }
  ws.onclose = () => {
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
      // 卡片内部右下角带「重新上屏」按钮：首次上屏贴错位置时，把光标移到正确位置后可重新粘贴
      finalsEl.innerHTML = ''
      const div = document.createElement('div')
      div.className = 'final-line'
      const txt = document.createElement('span')
      txt.className = 'final-text'
      txt.textContent = msg.text
      const btn = document.createElement('button')
      btn.className = 'repaste-btn'
      btn.type = 'button'
      btn.textContent = '重新上屏'
      div.appendChild(txt)
      div.appendChild(btn)
      finalsEl.appendChild(div)
    } else if (msg.type === 'sent') {
      if (msg.source === 'compose') {
        // 输入态上屏：不触发“执行”的闪光，也不回弹到触摸板
        flashStatus('已上屏')
      } else {
        flashStatus('已执行')
        lastFinalText = ''
        const rb = finalsEl.querySelector('.repaste-btn')
        if (rb) rb.classList.add('hidden')
        partialEl.classList.add('hidden')
        enterBtn.classList.remove('flash')
        void enterBtn.offsetWidth
        enterBtn.classList.add('flash')
        // 说话前若在触摸板，发送完成后回弹到触摸板
        if (recordFromTrackpad) {
          recordFromTrackpad = false
          setPage('trackpad')
        }
      }
    } else if (msg.type === 'repasted') {
      flashStatus('已重新上屏')
    } else if (msg.type === 'deleted') {
      deleteArmed = false
      if (deleteArmTimer) clearTimeout(deleteArmTimer)
      flashStatus(msg.remaining ? `已回退，还可回退 ${msg.remaining} 步` : '已回退')
      deleteBtn.classList.remove('flash')
      void deleteBtn.offsetWidth
      deleteBtn.classList.add('flash')
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
    }
  }
}
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
function enterCompose() {
  if (composing) return
  composing = true
  panelDialog.classList.add('composing')
  composer.classList.remove('hidden')
  composeToggle.classList.add('on')
  composeToggle.setAttribute('aria-pressed', 'true')
  composeToggle.setAttribute('aria-label', '切回回显')
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
  composeToggle.classList.remove('on')
  composeToggle.setAttribute('aria-pressed', 'false')
  composeToggle.setAttribute('aria-label', '切换到输入')
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
  composerInput.value = ''
  composeAttachments.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
  composeAttachments = []
  composerChips.innerHTML = ''
  composerInput.style.height = 'auto'
  exitCompose()
}

// 事件绑定
composeToggle.addEventListener('click', () => { composing ? exitCompose() : enterCompose() })
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
    deleteArmTimer = setTimeout(() => { deleteArmed = false }, 3000)
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

// 重新上屏：识别结果贴错位置时，先把 Mac 光标移到正确位置，再点回显卡片右下角的按钮，
// 把最后一次识别结果重新粘贴到新光标处（不回车、不丢历史）。
finalsEl.addEventListener('click', (e) => {
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
    nudgeBtn(action === 'expose' ? exposeBtn : action === 'launchpad' ? launchpadBtn : missionBtn)
    flashStatus('未连接')
  }
}

missionBtn.addEventListener('click', () => sendGesture('mission', '任务控制'))
exposeBtn.addEventListener('click', () => sendGesture('expose', 'App窗口'))
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
  if (!mouseMode) resetMouseGesture()
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
  // 新一轮说话：在最顶部新起一个实时回显框并随语句增长；页面只保留最近一条结果，新结果会替换旧结果
  partialEl.textContent = ''
  partialEl.classList.add('hidden')
  // 回显框位于面板最顶部：重置滚动位置，确保新回显框在顶部可见且随语句增长
  if (finalsEl.parentElement) finalsEl.parentElement.scrollTop = 0
  showHint('再点一次 结束', false)

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
  if (holding) {
    // 已在录音中 → 结束并回显；仍在初始化中 → 取消本次
    if (recording) stopRecording()
    else cancelRecording()
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
  mouseAccum = { x: 0, y: 0 }
  mouseScrollAccum = { x: 0, y: 0 }
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

resultArea.addEventListener('touchstart', (e) => {
  if (mouseMode) {
    e.preventDefault()
    if (e.touches.length === 2) {
      resetMouseGesture()
      twoFinger = true
      const a = e.touches[0]
      const b = e.touches[1]
      mouseLast = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
      return
    }
    if (e.touches.length === 1) {
      resetMouseGesture()
      const t = e.touches[0]
      mouseLast = { x: t.clientX, y: t.clientY }
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
  // 输入态下，触摸 compose 区域不触发页面左右滑动（避免滑动切页误触）
  if (composing) return
  swipeX = e.touches[0].clientX
  swipeY = e.touches[0].clientY
}, { passive: false })

resultArea.addEventListener('touchmove', (e) => {
  if (mouseMode) {
    e.preventDefault()
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
      mouseAccum.x += t.clientX - mouseLast.x
      mouseAccum.y += t.clientY - mouseLast.y
      mouseLast = { x: t.clientX, y: t.clientY }
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
        resetMouseGesture()
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
    const wasTwoFinger = twoFinger
    const wasMoved = mouseMoved
    const wasDown = mouseDownSent
    const elapsed = Date.now() - mouseStartTime
    const endPos = mouseEndPos
    flushMouseMove()
    resetMouseGesture()
    clearTouchCanvas()
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
    clearTouchCanvas()
    return
  }
  flushMouseMove()
})
