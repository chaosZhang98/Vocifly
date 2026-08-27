// Electron 主进程：菜单栏常驻 + 本地 HTTPS/HTTP 服务 + 导航式控制面板
// 启动时不显示主窗口，仅驻留 macOS 系统状态栏（菜单栏）；点击图标弹出下拉菜单，
// 通过菜单项打开控制面板（配置 / 二维码 / 使用帮助）。
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, globalShortcut, systemPreferences } = require('electron')
const { createServer, getLanIp, broadcastSettingsToAll } = require('./server')
const { config, saveSettings } = require('../infrastructure/config')
const { log } = require('../infrastructure/logger')
const path = require('path')

// 全局兜底：任何未捕获异常/未处理的 Promise 拒绝都记录到日志，
// 尽量不让 Electron 主进程直接崩溃。若业务状态受损，由 ws 心跳/重连与
// 控制面板轮询自动恢复，而不是整体退出。
process.on('uncaughtException', (err) => {
  try { log('main', '[未捕获异常]', err && err.stack ? err.stack : String(err)) } catch (_) {}
})
process.on('unhandledRejection', (reason) => {
  try { log('main', '[未处理的 Promise 拒绝]', reason && reason.stack ? reason.stack : (reason && reason.message ? reason.message : String(reason))) } catch (_) {}
})

let win = null
let tray = null
let current = null // 当前运行的服务实例
let isQuitting = false

// 关闭当前服务：先断掉所有手机连接，再关端口，避免新请求挂在旧证书上
async function closeCurrentServer() {
  if (!current) return
  current.wss?.clients.forEach((client) => { try { client.terminate() } catch {} })
  current.httpWss?.clients.forEach((client) => { try { client.terminate() } catch {} })
  // 关闭 WebSocketServer 触发其 'close' 事件：清掉心跳定时器并从 allWss 广播集合摘除，
  // 避免端口/IP 变更重启时旧实例（含每 30s 一次的空心跳）在内存里持续累积。
  for (const wss of [current.wss, current.httpWss]) {
    if (wss) { try { wss.close() } catch {} }
  }
  for (const srv of [current.server, current.setupServer]) {
    if (srv) await new Promise((resolve) => srv.close(() => resolve()))
  }
  current = null
}

// 打开控制面板并聚焦。hash 定位导航页：overview = 概览, settings = 配置, devices = 接入设备（使用帮助已并入此页）, usage = 用量；
// devices 可带子目标 devices/app 或 devices/setup 定位到具体二维码卡片
async function openControl(hash = 'settings', force = false) {
  if (!current || !win || win.isDestroyed()) return
  const base = current.controlUrl
  const target = `${base}#${hash}`
  if (force || win.webContents.getURL() !== target) {
    try { await win.loadURL(target) } catch (error) { log('main', '加载控制面板失败:', error.message) }
  }
  win.show()
  win.focus()
}


// 全局快捷键动作：切换控制面板窗口的显示/隐藏（Ctrl/Cmd+Shift+Space）。
// 手机/平板上"按住说话"不适合作为全局快捷键（需要长按监听），这里仅负责唤起/收起控制面板。
function toggleControl() {
  if (!win || win.isDestroyed()) return
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

async function renderWindow() {
  if (!current) return
  try { await win.loadURL(current.controlUrl + '#settings') } catch (error) { log('main', '加载控制面板失败:', error.message) }
}

async function startServices() {
  await closeCurrentServer()
  // createServer 内部会检查证书 SAN 是否覆盖当前 IP，不覆盖则自动重签
  current = await createServer({
    onStatus: (status) => log('main', `手机状态: ${status}`),
    onQuit: () => { isQuitting = true; app.quit() },
    onServicesChanged: restartAfterPortChange,
    onLaunchAtLogin: apiSetLaunchAtLogin,
    getLaunchAtLoginState,
  })
  await renderWindow()
  log('main', `服务已就绪: ${current.ipUrl || current.url}`)
}

// 端口在控制面板被改好后重新启动：监听新端口、刷新控制面板地址/二维码。
// 若新端口被占用会失败并报错，用户改回后即可恢复。
async function restartAfterPortChange() {
  try {
    await startServices()
    log('main', `端口已生效，服务已重启: ${current.ipUrl || current.url}`)
  } catch (error) {
    log('main', '按新端口重启服务失败:', error.message)
    // 回退到内置默认端口，避免应用因端口冲突而停摆
    dialog.showErrorBox('切换端口失败', `未能切换到新端口: ${error.message}\n已回退到默认端口 9898 / 9899。`)
    try { saveSettings({ httpPort: 9898, httpsPort: 9899 }) } catch (_) {}
    await startServices().catch((e) => {
      log('main', '回退默认端口仍失败:', e.message)
      dialog.showErrorBox('启动失败', `无法启动服务: ${e.message}`)
    })
  }
}

// 读取 macOS 实际登录项状态（以系统为准，而非我们以为的状态）。
function getLaunchAtLoginState() {
  try { return !!app.getLoginItemSettings().openAtLogin } catch (_) { return false }
}

// 「注册/取消 macOS 登录项」的核心：调 setLoginItemSettings 后用 getLoginItemSettings 复核，
// 未真正生效就把 config 回退到系统真实状态（避免「勾了却没自启」的假象）。
// 返回 { ok, actual }：ok=false 表示 macOS 未接受（未签名开发态常见）。
function applyLoginItem(on) {
  try { app.setLoginItemSettings({ openAtLogin: on }) } catch (_) { /* 用 get 复核兜底 */ }
  const actual = getLaunchAtLoginState()
  if (actual !== on) {
    try { saveSettings({ launchAtLogin: actual }) } catch (_) {}
  }
  return { ok: actual === on, actual }
}

// 勾选/取消「开机自启」：写回 macOS 登录项 + config.json，立即生效。
// checkbox 菜单项点击后 item.checked 即为新的目标状态。
function setLaunchAtLogin(enable) {
  const on = !!enable
  // 开发态（未打包/未签名）下 app.setLoginItemSettings 会把「Electron」这个开发二进制注册成
  // 登录项（而非 Vocifly），且 macOS 返回“成功”造成假象。这里在开发态直接拒绝“开启”。
  if (on && !app.isPackaged) {
    log('main', '开机自启: 开发态（未打包）不注册登录项，避免把 Electron 二进制当登录项')
    dialog.showErrorBox('开发态暂不支持', '当前是未打包/未签名的开发运行，注册“开机自启”会把开发用的 Electron 二进制当作登录项，而不是 Vocifly。\n\n请先打包/签名（npm run build:mac）再开启。')
    setupTray()
    return
  }
  const { ok, actual } = applyLoginItem(on)
  if (!ok) {
    log('main', `开机自启: 设置未生效（macOS 当前=${actual}）。开发态未签名常被拒，打包/签名后即可正常。`)
    dialog.showErrorBox('设置失败', `未能设置开机自启（macOS 未生效）。\n\n已签名/打包的 Vocifly 可以正常设置；当前是未签名的开发运行，系统不允许注册登录项。`)
    setupTray() // 重建菜单，让勾选框回到真实状态
    return
  }
  try { saveSettings({ launchAtLogin: on }) } catch (e) { log('main', '保存开机自启设置失败:', e.message) }
  log('main', `开机自启: ${on ? '开启' : '关闭'}`)
}

// 启动时把 config 里的「开机自启」偏好应用到 macOS 登录项。默认关闭。
// 打包/签名后的 App 才有实际意义；未签名的开发态设置会被系统拒绝，这里仅记录，不阻塞启动。
function applyLaunchAtLogin() {
  const want = !!config.launchAtLogin
  // 仅在「确实要开且已打包/签名」时才注册登录项；默认关闭时跳过，避免开发态
  // setLoginItemSettings(openAtLogin:false) 触发「Operation not permitted」噪声日志。
  if (want && app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true }) } catch (_) { /* 见下，用 get 复核 */ }
  }
  const actual = getLaunchAtLoginState()
  log('main', `开机自启: ${actual ? '开启' : '关闭'}${actual !== want ? '（未打包/未签名开发态常见，已跳过注册）' : ''}`)
}

// 控制面板 /api/login-item 用的开关：与托盘共用逻辑，但返回 {ok, launchAtLogin, error} 供 UI 反馈，不弹原生框。
function apiSetLaunchAtLogin(enable) {
  const on = !!enable
  // 开发态（未打包）不注册登录项，理由同 setLaunchAtLogin；这里返回 {ok:false} 供面板反馈，不弹原生框。
  if (on && !app.isPackaged) {
    log('main', '开机自启: 开发态（未打包）不注册登录项')
    return { ok: false, launchAtLogin: getLaunchAtLoginState(), error: '开发态（未打包/未签名）无法注册 Vocifly 登录项；请打包/签名后再开启。' }
  }
  const { ok, actual } = applyLoginItem(on)
  if (!ok) {
    log('main', `开机自启: 设置未生效（macOS 当前=${actual}）。开发态未签名常被拒，打包/签名后即可正常。`)
    return { ok: false, launchAtLogin: actual, error: '开发态（未签名）无法注册登录项；打包/签名后的 Vocifly 即可。' }
  }
  try { saveSettings({ launchAtLogin: on }) } catch (e) { log('main', '保存开机自启设置失败:', e.message) }
  setupTray() // 托盘勾选与本次保持一致
  log('main', `开机自启: ${on ? '开启' : '关闭'}`)
  return { ok: true, launchAtLogin: actual }
}

// 从菜单栏直接切换 ASR 引擎（与设置页共享同一 config，立即生效）。
// 注意：切的是全局默认引擎——各手机可在对话页单独覆盖（云端/本地/键盘），
// 覆盖的手机不受影响；跟随全局的手机通过广播 settings 即时生效。
function switchProvider(provider) {
  try {
    saveSettings({ asr: { provider } })
    broadcastSettingsToAll()
    log('main', `已切换识别服务: ${provider}`)
    openControl('settings', true)
  } catch (error) {
    log('main', '切换识别服务失败:', error.message)
    dialog.showErrorBox('切换失败', `${error.message}\n\n请在控制面板「配置」中完善后再试。`)
  }
}

// 菜单栏下拉菜单（参考系统菜单栏应用样式，但内容为 Vocifly 自身功能）
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => openControl('settings') },
    { label: '使用帮助', click: () => openControl('devices') },
    { type: 'separator' },
    {
      label: '手机二维码',
      submenu: [
        { label: '正常输入', click: () => openControl('devices/app') },
        { label: '首次配置证书', click: () => openControl('devices/setup') },
      ],
    },
    {
      label: '识别服务',
      submenu: [
        { label: '本地（SenseVoice）', click: () => switchProvider('sherpa') },
        { label: '云端（阿里云百炼）', click: () => switchProvider('bailian') },
      ],
    },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: !!config.launchAtLogin, click: (item) => setLaunchAtLogin(item.checked) },
    { type: 'separator' },
    { label: '退出 Vocifly', click: () => { isQuitting = true; app.quit() } },
  ])
}

function setupTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    log('main', '托盘图标加载失败，使用内置空图标')
  } else {
    // createFromPath 会自动加载同目录的 @2x 变体（Retina），保留模板标记即可
    icon.setTemplateImage(true)
  }
  try {
    tray = new Tray(icon)
  } catch (error) {
    log('main', '创建托盘失败:', error.message)
    return
  }
  tray.setToolTip('Vocifly · 手机当麦克风')
  // macOS 上 setContextMenu 会自动处理左键弹出下拉菜单（与系统菜单栏应用一致）
  tray.setContextMenu(buildTrayMenu())
}

// 后台监控局域网 IP：变化时弹框，用户确认后热更新（重签证书 + 重启端口 + 刷新二维码），
// 应用进程不重启，手机端根证书也不用重装
function watchNetwork() {
  let servingIp = getLanIp()
  let candidate = null
  let prompting = false

  setInterval(async () => {
    if (prompting || !current || !win) return
    const ip = getLanIp()
    if (!ip || ip === servingIp) { candidate = null; return }
    // 防抖：Wi-Fi 切换过程中 IP 可能闪变，连续两轮一致才确认
    if (candidate !== ip) { candidate = ip; return }
    candidate = null
    prompting = true
    log('main', `检测到局域网 IP 变化: ${servingIp} -> ${ip}`)

    const opts = {
      type: 'warning',
      title: '网络环境已变化',
      message: '检测到 Mac 的局域网 IP 变了',
      detail: `旧地址 ${servingIp}\n新地址 ${ip}\n\n手机需要扫描新的二维码才能继续连接。点击“立即更新”重新生成入口（约 1-2 秒），无需重启应用，手机上的证书也不用重装。`,
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }
    // 窗口隐藏在菜单栏，为避免弹窗被隐藏窗口遮挡，这里用应用级模态框而非 sheet
    const result = await dialog.showMessageBox(opts)
    const response = result.response
    prompting = false

    if (response === 0) {
      try {
        await startServices()
        servingIp = ip
        log('main', `服务已切换到新 IP: ${ip}`)
      } catch (error) {
        log('main', '服务切换失败:', error.message)
        await dialog.showErrorBox('更新失败', `服务切换失败: ${error.message}\n请尝试重启 Vocifly。`)
      }
    }
    // 选“稍后”：servingIp 不更新，下一轮检测还会再次提醒
  }, 5000)
}

async function boot() {
  // 上屏（模拟 Cmd+V 注入）依赖「辅助功能」权限，无权限时 CGEvent 会被静默丢弃。
  // 启动即检测：未授权则弹系统授权提示，并记录到日志，避免「日志显示成功但文字没上屏」的静默失败。
  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    log('main', `辅助功能权限: ${trusted ? '已授权' : '未授权（上屏将失效）'}`)
    if (!trusted) {
      // true 参数会触发 macOS 的授权弹窗，引导用户一键开启
      systemPreferences.isTrustedAccessibilityClient(true)
    }
  } catch (error) {
    log('main', '检测辅助功能权限失败:', error.message)
  }

  win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 760,
    minHeight: 480,
    title: 'Vocifly',
    show: false, // 静默启动：不显示主窗口，仅驻留菜单栏
    backgroundColor: '#ececef',
    webPreferences: { nodeIntegration: false },
  })

  applyLaunchAtLogin()

  // 关闭窗口时不退出，而是隐藏到菜单栏
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  await startServices()
  setupTray()
  watchNetwork()
}

// 退出前关闭所有服务
app.on('before-quit', () => { isQuitting = true; try { globalShortcut.unregisterAll() } catch {} })

app.on('window-all-closed', () => {
  // 菜单栏应用：所有窗口关闭后仍常驻，不退出；除非用户明确退出
  if (isQuitting) app.quit()
})

// 单实例锁：重复启动时直接退出，并把已有实例的窗口调到前台。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  log('main', '检测到已有 Vocifly 实例在运行，本次启动退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    log('main', '收到第二实例启动请求，聚焦已有控制面板')
    if (win && !win.isDestroyed()) { win.show(); win.focus() }
  })

  app.whenReady().then(() => {
    // 隐藏 Dock 图标，让 Vocifly 像真正的菜单栏工具一样运行
    try { if (app.dock) app.dock.hide() } catch (error) { log('main', '隐藏 Dock 失败:', error.message) }
    // 注册全局快捷键：唤起/收起控制面板（与系统输入法切换等不冲突的常见组合）
    try {
      globalShortcut.register('CommandOrControl+Shift+Space', toggleControl)
      log('main', '全局快捷键已注册: CommandOrControl+Shift+Space')
    } catch (error) {
      log('main', '注册全局快捷键失败:', error.message)
    }
    return boot().catch((error) => {
      log('main', '启动失败:', error)
      app.quit()
    })
  })
}

