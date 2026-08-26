// 上屏：剪贴板备份 → 写入 → 模拟 Cmd+V → 还原
// 依赖 macOS 自带 pbcopy/pbpaste/osascript；辅助功能权限挂在宿主进程上
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile, execFileSync, spawn } = require('child_process')
const { log } = require('../logger')
const paths = require('../paths')
const { getFrontmostApp } = require('../platform/app-switcher')
const { resolveSendRule, resolveDeleteRule, keyToOsaScript } = require('../../domain/service/SendRuleService')
const { config } = require('../config')
const macControl = require('../platform/mac-control')

const MOUSE_HELPER = paths.binFile('mouse-helper')
const MOUSE_HELPER_SWIFT = paths.swiftFile('mouse-helper.swift')
let mouseHelper = null

function ensureMouseHelper() {
  if (mouseHelper) return true
  try {
    if (!fs.existsSync(MOUSE_HELPER)) {
      fs.mkdirSync(path.dirname(MOUSE_HELPER), { recursive: true })
      execFileSync('swiftc', ['-O', '-o', MOUSE_HELPER, MOUSE_HELPER_SWIFT], { timeout: 120000 })
    }
    mouseHelper = spawn(MOUSE_HELPER, [], { stdio: ['pipe', 'ignore', 'ignore'] })
    mouseHelper.on('exit', () => { mouseHelper = null })
    mouseHelper.on('error', () => { mouseHelper = null })
    return true
  } catch (e) {
    log('paste', '启动鼠标助手失败，回退 osascript:', e.message)
    return false
  }
}

function mouseWrite(cmd) {
  if (!ensureMouseHelper() || !mouseHelper || !mouseHelper.stdin?.writable) return false
  try {
    mouseHelper.stdin.write(cmd + '\n')
    return true
  } catch {
    return false
  }
}

// ---- 异步子进程辅助 ----
// 主线程同时要转发音频 + 驱动 ASR，任何同步 execFileSync 都会让识别“卡住”。
// 这里统一改成异步，避免阻塞唯一 Node 主线程。
function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout || ''))
    })
  })
}

// 带 stdin 输入的异步子进程（pbcopy 需要写入内容）
function execInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let errOut = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { errOut += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(errOut || `exit ${code}`))
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

async function readClipboard() {
  try { return await execAsync('pbpaste', []) }
  catch { return null }  // 剪贴板为空或含非文本内容
}

async function writeClipboard(text) {
  await execInput('pbcopy', [], text)
}

function simulatePaste() {
  return execAsync('osascript', [
    '-e', 'tell application "System Events" to keystroke "v" using command down',
  ])
}

// 回车：优先复用常驻 mac-control helper，否则用 System Events 的 key code 36
function simulateEnter() {
  if (macControl.send('ENTER')) return Promise.resolve()
  return execAsync('osascript', ['-e', 'tell application "System Events" to key code 36'])
}

function send() {
  const app = getFrontmostApp()
  const rule = resolveSendRule(app, config.sendRules)
  const script = keyToOsaScript(rule.key)
  const helperCmd = { enter: 'ENTER', 'cmd-enter': 'ENTER_CMD', 'ctrl-enter': 'ENTER_CTRL' }[rule.key]
  if (!script) {
    log('paste', `前台 ${app?.name || '未知 App'} 配置为不发送，跳过回车`)
    return
  }
  // 稍等片刻再回车，确保目标应用已接收完粘贴内容
  setTimeout(() => {
    const runSend = () => {
      if (helperCmd && macControl.send(helperCmd)) return Promise.resolve()
      return execAsync('osascript', ['-e', script])
    }
    runSend()
      .then(() => log('paste', `已模拟 ${rule.key} 发送（${app?.name || '未知 App'} / ${rule.source}）`))
      .catch((e) => log('paste', '模拟回车失败（检查辅助功能权限）:', e.message))
  }, config.sendDelayMs || 120)
}

function countGraphemes(text) {
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text)).length
  } catch {
    return Array.from(text).length
  }
}

// 回退上次上屏。默认走「规则自适应」：Cmd+Z 撤销（不依赖光标位置）或按规则退格。
// @param text 回退目标文本（用户上屏的那句）
// @param opts.mode 可选。'undo' 强制 Cmd+Z；'backspace' 强制逐字符退格（等效键盘删除键，
//   用于终端等 Cmd+Z 不撤销粘贴内容的场景）；不传则按 deleteRules 自适应。
// @returns {Promise<boolean>} 删除真正执行完成后 resolve(true)；跳过(不删除规则/空文本) resolve(false)。
//   —— 供「优化替换」等需要「先删旧文、再上新文」的用例 await 时序；原有 fire-and-forget 调用方不受影响。
function deleteStep(text, opts = {}) {
  if (!text) return Promise.resolve(false)
  const app = getFrontmostApp()
  const force = opts.mode // 'undo' | 'backspace' | undefined(adaptive)
  const rule = resolveDeleteRule(app, config.deleteRules)
  // 显式删除键（force=backspace）绕过规则，始终执行；自适应路径才受「不删除」规则约束。
  if (!force && rule === 'none') {
    log('paste', `前台 ${app?.name || '未知 App'} 配置为不删除，跳过`)
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    setTimeout(async () => {
      const runDelete = async () => {
        const useUndo = force === 'undo' || (!force && (rule === 'undo' || countGraphemes(text) > 500))
        if (useUndo) {
          // 优先走常驻 helper 并等待 ACK（与 paste 一致）；无权限或 helper 不可用时退回 osascript。
          // 不能用 fire-and-forget send()：它只表示「写进 stdin 成功」，即便 helper 回 NOPERM 也会误报成功。
          if (await macControl.sendAck('UNDO', 8000)) return true
          if (macControl.isPermissionDenied()) throw new Error('缺少「辅助功能」权限')
          await execAsync('osascript', ['-e', 'tell application "System Events" to key code 6 using {command down}'])
          return true
        }
        const n = countGraphemes(text)
        if (await macControl.sendAck(`BACKSPACE ${n}`, 8000)) return true
        if (macControl.isPermissionDenied()) throw new Error('缺少「辅助功能」权限')
        const script = `tell application "System Events"\nrepeat ${n} times\nkey code 51\ndelay 0.008\nend repeat\nend tell`
        await execAsync('osascript', ['-e', script], { timeout: 15000 })
        return true
      }
      try {
        await runDelete()
        log('paste', `已删除上次输入（${force ? force : '自适应'} / ${app?.name || '未知 App'}）`)
        resolve(true)
      } catch (e) {
        log('paste', '模拟删除失败（检查辅助功能权限）:', e.message)
        resolve(false)
      }
    }, config.deleteDelayMs || 120)
  })
}

function switchWindow(dir) {
  const helperCmd = dir === 'prev' ? 'TAB_CMD_SHIFT' : 'TAB_CMD'
  const run = () => {
    if (macControl.send(helperCmd)) return Promise.resolve()
    const script = dir === 'prev'
      ? 'tell application "System Events" to key code 48 using {command down, shift down}'
      : 'tell application "System Events" to key code 48 using {command down}'
    return execAsync('osascript', ['-e', script])
  }
  run()
    .then(() => log('paste', `已切换窗口: ${dir}`))
    .catch((e) => log('paste', '模拟窗口切换失败（检查辅助功能权限）:', e.message))
}

function activateApp(bundleId) {
  const run = () => {
    if (macControl.send(`ACTIVATE ${bundleId}`)) return Promise.resolve()
    return execAsync('osascript', ['-e', `tell application id "${bundleId}" to activate`], { timeout: 3000 })
  }
  run()
    .then(() => log('paste', `已激活应用: ${bundleId}`))
    .catch((e) => log('paste', '激活应用失败:', e.message))
}

function gesture(action) {
  if (action === 'launchpad') {
    // 系统启动台：直接用 LaunchServices 唤起系统级 Launchpad 覆盖层。
    // 不采用 web 端自建 App 网格；也不依赖 F4/媒体键（易受“标准功能键”设置影响）。
    execAsync('open', ['-b', 'com.apple.launchpad.launcher'], { timeout: 3000 })
      .then(() => log('paste', '已触发系统启动台'))
      .catch((e) => log('paste', '触发启动台失败:', e.message))
    return
  }
  // 系统手势（调度中心/App Exposé）走 osascript System Events：
  // 自带的 mac-control 助手用 CGEventPost 合成按键时，macOS 不会把这些系统手势热键真正触发，
  // 而 System Events 实测可靠（不会像 CGEvent 那样被系统吞掉）。
  // 手势 → 快捷键：mission=任务控制(Control+↑) expose=App 窗口(Control+↓) spacesLeft/Right=切换空间(Control+←/→)
  const keyCode = { mission: '126', expose: '125', spacesLeft: '123', spacesRight: '124' }[action]
  if (!keyCode) { log('paste', `未知手势: ${action}`); return }
  execAsync('osascript', ['-e', `tell application "System Events" to key code ${keyCode} using control down`], { timeout: 3000 })
    .then(() => log('paste', `已触发手势: ${action}`))
    .catch((e) => log('paste', '触发手势失败:', e.message))
}

function quitApp() {
  const run = () => {
    if (macControl.send('QUIT_APP')) return Promise.resolve()
    return execAsync('osascript', ['-e', 'tell application "System Events" to key code 12 using {command down}'], { timeout: 3000 })
  }
  run()
    .then(() => log('paste', '已退出应用'))
    .catch((e) => log('paste', '退出应用失败:', e.message))
}

function mouseMoveFallback(dx, dy) {
  const x = Math.max(-500, Math.min(500, Number(dx) || 0))
  const y = Math.max(-500, Math.min(500, Number(dy) || 0))
  if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) return
  const script = `ObjC.import('CoreGraphics'); const e=$.CGEventCreate($()); const p=$.CGEventGetLocation(e); const ev=$.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, $.CGPointMake(p.x + ${x}, p.y + ${y}), 0); $.CGEventPost($.kCGHIDEventTap, ev);`
  execAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 })
    .catch((e) => log('paste', '模拟鼠标移动失败:', e.message))
}

function mouseMove(dx, dy) {
  const x = Math.max(-500, Math.min(500, Number(dx) || 0))
  const y = Math.max(-500, Math.min(500, Number(dy) || 0))
  if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) return
  if (mouseWrite(`M ${x} ${y}`)) return
  mouseMoveFallback(x, y)
}

function mouseButtonFallback(type) {
  const script = `ObjC.import('CoreGraphics'); const e=$.CGEventCreate($()); const p=$.CGEventGetLocation(e); const ev=$.CGEventCreateMouseEvent($(), ${type}, $.CGPointMake(p.x, p.y), 0); $.CGEventPost($.kCGHIDEventTap, ev);`
  execAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 })
    .catch((e) => log('paste', '模拟鼠标按键失败:', e.message))
}

function mouseClick() {
  if (!mouseWrite('C')) {
    mouseButtonFallback(1)
    mouseButtonFallback(2)
  }
  log('paste', '已模拟左键点击')
}

function mouseDown() {
  if (!mouseWrite('D')) mouseButtonFallback(1)
  log('paste', '已模拟按下左键')
}

function mouseUp() {
  if (!mouseWrite('U')) mouseButtonFallback(2)
  log('paste', '已模拟松开左键')
}

function mouseRightClick() {
  if (!mouseWrite('R')) {
    mouseButtonFallback(3)
    mouseButtonFallback(4)
  }
  log('paste', '已模拟右键点击')
}

function mouseScrollFallback(dx, dy) {
  const x = Math.max(-500, Math.min(500, Math.round(Number(dx) || 0)))
  const y = Math.max(-500, Math.min(500, Math.round(Number(dy) || 0)))
  if (!x && !y) return
  const script = `ObjC.import('CoreGraphics'); const ev=$.CGEventCreateScrollWheelEvent($(), 0, 1, ${-y}); $.CGEventSetIntegerValueField(ev, 23, ${x}); $.CGEventPost($.kCGHIDEventTap, ev);`
  execAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 })
    .catch((e) => log('paste', '模拟滚动失败:', e.message))
}

function mouseScroll(dx, dy) {
  const x = Math.max(-500, Math.min(500, Math.round(Number(dx) || 0)))
  const y = Math.max(-500, Math.min(500, Math.round(Number(dy) || 0)))
  if (!x && !y) return
  if (mouseWrite(`S ${x} ${y}`)) return
  mouseScrollFallback(x, y)
}


// ---- 图片 / 文件上屏（手机端 compose 输入）----
// 与 paste 不同：这里是“原子单位”，图片/文件字节原样上屏，不读取内容、不转文字。
// 通过 Swift helper 写剪贴板类型（PNG/JPEG / fileURL），再模拟 Cmd+V。
// 不做剪贴板还原——用户主动粘贴的图/文件不应被覆盖掉。
function guessImageExt(data) {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'png'
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'jpg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif'
  return 'png'
}

function cleanTemp(p) {
  try { fs.unlinkSync(p) } catch {}
}

async function pasteImage(base64, attachName = 'image') {
  if (!base64) return false
  const viaHelper = await macControl.sendAck('PASTE_IMAGE ' + base64, 15000)
  if (viaHelper) {
    log('paste', '图片上屏成功:', attachName)
    return true
  }
  // 兜底：写临时文件 → osascript 设剪贴板为图片数据
  try {
    const data = Buffer.from(base64, 'base64')
    const ext = guessImageExt(data)
    const tmp = path.join(os.tmpdir(), `phvoice-${Date.now()}-${ext}`)
    fs.writeFileSync(tmp, data)
    const script = (ext === 'jpg')
      ? `set the clipboard to (read POSIX file "${tmp}" as «class JPEG»)`
      : `set the clipboard to (read POSIX file "${tmp}" as «class PNGf»)`
    await execAsync('osascript', ['-e', script], { timeout: 5000 })
    await simulatePaste()
    cleanTemp(tmp)
    log('paste', '图片上屏成功(兜底):', attachName)
    return true
  } catch (e) {
    log('paste', '图片上屏失败:', e.message)
    return false
  }
}

async function pasteFile(filename, base64) {
  if (!base64) return false
  const nameB64 = Buffer.from(filename || 'file', 'utf8').toString('base64')
  const viaHelper = await macControl.sendAck(`PASTE_FILE ${nameB64} ${base64}`, 15000)
  if (viaHelper) {
    log('paste', '文件上屏成功:', filename)
    return true
  }
  // 兜底：写临时文件 → osascript 把 POSIX file 放进剪贴板（可作为文件附件粘贴）
  try {
    const data = Buffer.from(base64, 'base64')
    const safe = path.basename(filename || 'file')
    const tmp = path.join(os.tmpdir(), `phvoice-${Date.now()}-${safe}`)
    fs.writeFileSync(tmp, data)
    const script = `set the clipboard to POSIX file "${tmp}"`
    await execAsync('osascript', ['-e', script], { timeout: 5000 })
    await simulatePaste()
    cleanTemp(tmp)
    log('paste', '文件上屏成功(兜底):', filename)
    return true
  } catch (e) {
    log('paste', '文件上屏失败:', e.message)
    return false
  }
}

async function paste(text, { enter = false } = {}) {
  if (!text) return false
  const original = await readClipboard()
  let usedClipboard = false // 是否真的写过系统剪贴板（走 pbcopy 回退）
  try {
    const viaHelper = await macControl.sendAck('PASTE ' + Buffer.from(text, 'utf8').toString('base64'), 8000)
    if (viaHelper) {
      log('paste', '上屏成功:', text)
      if (enter) {
        // 粘贴后稍等一下再回车，避免目标应用还没处理完粘贴事件
        setTimeout(() => {
          simulateEnter().catch((e) => log('paste', '模拟回车失败（检查辅助功能权限）:', e.message))
        }, config.pasteDelayMs || 150)
      }
      return true
    }
    // helper 未确认：先判断是不是辅助功能权限被拒，再决定是否走 osascript 兜底
    if (macControl.isPermissionDenied()) {
      log('paste', '上屏失败：缺少「辅助功能」权限，请在 系统设置>隐私与安全性>辅助功能 中勾选 PhVoice 后重试')
      return false
    }
    usedClipboard = true
    await writeClipboard(text)
    await simulatePaste()
    if (enter) {
      setTimeout(() => {
        simulateEnter().catch((e) => log('paste', '模拟回车失败（检查辅助功能权限）:', e.message))
      }, config.pasteDelayMs || 150)
    }
    log('paste', '上屏成功(兜底):', text)
    return true
  } catch (e) {
    log('paste', '上屏失败（检查 系统设置>隐私与安全性>辅助功能 中宿主应用的权限）:', e.message)
    return false
  } finally {
    // 只有确实通过 pbcopy 写入过系统剪贴板（helper 不可用的回退路径）才还原；
    // 通过 mac-control helper 上屏时从未改动剪贴板，不还原，避免覆盖用户在 300ms 内的新复制。
    if (usedClipboard && original !== null) {
      setTimeout(async () => {
        try {
          // 还原前再确认剪贴板仍是刚才写入的内容，避免覆盖用户新复制
          const now = await readClipboard()
          if (now === text) await writeClipboard(original)
        } catch {}
      }, config.clipboardRestoreDelayMs || 300)
    }
  }
}

module.exports = {
  paste,
  pasteImage,
  pasteFile,
  send,
  deleteStep,
  switchWindow,
  activateApp,
  gesture,
  quitApp,
  mouseMove,
  mouseClick,
  mouseDown,
  mouseUp,
  mouseRightClick,
  mouseScroll,
}
