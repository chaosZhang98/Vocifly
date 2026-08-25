// PhVoice 启动 + 驱动脚本（agent 工具，非产品代码）。
// 用法：node driver.mjs [run|launch|smoke|screenshot|stop]
//   run        默认：launch → smoke → screenshot，全程留 app 运行
//   launch     杀掉旧实例 + 启动，等到 /api/health 就绪
//   smoke      对已运行实例做 HTTP 冒烟（不启动）
//   screenshot 用 CDP 抓控制面板截图到 runtime/debug/control-panel.png
//   stop       杀掉 PhVoice 的 electron 进程
//
// 依赖：Node ≥ 22（用了全局 fetch / WebSocket；本机 v24）。
// 说明：路径全部相对 app/ 根（本文件位于 app/.claude/skills/run-phvoice/）。

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(SKILL_DIR, '..', '..', '..') // app/
const CDP_PORT = Number(process.env.PHVOICE_CDP_PORT || 9222)
const SCREENSHOT = path.join(APP_ROOT, 'runtime', 'debug', 'control-panel.png')
const READY_TIMEOUT_MS = 30000

// 复刻 app 的端口解析：env PHVOICE_HTTP_PORT > config.json httpPort > 9898。
// 控制面板 / /api/* 都在这个 HTTP 端口上（仅 loopback）。
function resolveHttpPort() {
  const env = Number(process.env.PHVOICE_HTTP_PORT)
  if (env) return env
  try {
    const cfg = JSON.parse(readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8'))
    if (cfg.httpPort) return Number(cfg.httpPort)
  } catch {}
  return 9898
}

// 只杀 PhVoice 自己的 electron 进程（full-path 匹配，避免误杀 WorkBuddy 等其它 Electron 应用）。
// 两段分别匹配「electron 主进程（dist 二进制）」和「.bin/electron 包装进程」。
function killExisting() {
  for (const pat of ['PhVoice/app/node_modules/electron', 'PhVoice/app/node_modules/.bin/electron']) {
    try { execFileSync('pkill', ['-f', pat]) } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  killExisting()
  // VSCode/本 shell 预置 ELECTRON_RUN_AS_NODE=1 会让 electron 退化成本地 Node，
  // app 对象为 undefined 直接崩溃。必须删掉这个变量（等价 shell 的 `env -u ELECTRON_RUN_AS_NODE`）。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const bin = path.join(APP_ROOT, 'node_modules', '.bin', 'electron')
  spawn(bin, [`--remote-debugging-port=${CDP_PORT}`, '.'], {
    cwd: APP_ROOT, env, stdio: 'ignore', detached: true,
  }).unref()

  const port = resolveHttpPort()
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return { port }
    } catch {}
    await sleep(500)
  }
  // 超时把日志尾部带出来，方便定位（日志由 logger 写 runtime/logs/app.log，与 stdio 无关）
  let tail = ''
  try {
    const lines = readFileSync(path.join(APP_ROOT, 'runtime', 'logs', 'app.log'), 'utf8').split('\n')
    tail = lines.slice(-20).join('\n')
  } catch {}
  throw new Error(`app 未在 ${READY_TIMEOUT_MS / 1000}s 内就绪（端口 ${port}）。日志尾部:\n${tail}`)
}

async function smoke(port) {
  const results = []

  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  results.push(['GET /api/health', health.status === 200])

  const s = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()
  const key = s?.asr?.bailian?.apiKey ?? ''
  const leaked = typeof key === 'string' && key.startsWith('sk-') && key.length > 10
  results.push([`GET /api/settings（apiKey 未泄露=${!leaked}）`, !leaked])

  const li = await (await fetch(`http://127.0.0.1:${port}/api/login-item`)).json()
  results.push(['GET /api/login-item', li?.ok === true])

  for (const [name, ok] of results) console.log(`${ok ? '✅' : '❌'} ${name}`)
  return results.every(([, ok]) => ok)
}

async function screenshot(out = SCREENSHOT) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && /control/.test(t.url))
  if (!page) throw new Error('未在 CDP targets 里找到 /control 页面')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = {}
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params }))
  })
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id] } }
  await new Promise((r) => { ws.onopen = r })

  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  ws.close()
  console.log(`截图已写: ${out} (${Buffer.from(shot.data, 'base64').length} bytes)`)
}

async function main() {
  const [cmd] = process.argv.slice(2)
  const port = resolveHttpPort()
  if (cmd === 'stop') { killExisting(); console.log('已停止 PhVoice'); return }
  if (cmd === 'launch') { await launch(); console.log(`就绪: http://127.0.0.1:${port}/control`); return }
  if (cmd === 'smoke') { process.exit((await smoke(port)) ? 0 : 1); return }
  if (cmd === 'screenshot') { await screenshot(); return }
  // 默认 run：launch → smoke → screenshot
  await launch()
  const ok = await smoke(port)
  await screenshot()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('❌', e.message); process.exit(1) })
