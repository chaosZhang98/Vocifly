// 常驻 Swift 平台助手：原生 AppKit/CGEvent 优先，osascript 只作兜底。
// 指令走 stdin 管道，避免每条操作都新开脚本进程。
// 助手对每条指令回一行 `OK <cmd>` 作为 ACK；sendAck() 会等待该 ACK，
// 保证“剪贴板已写入 + Cmd+V 已触发”后再发下一条，避免多附件互相覆盖剪贴板。
const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { log } = require('../logger')
const paths = require('../paths')

const BIN_PATH = paths.binFile('mac-control')
const SWIFT_PATH = paths.swiftFile('mac-control.swift')
let proc = null
let stdoutBuf = ''
const pendingAcks = [] // { token, resolve, timer }
let permissionDenied = false // 最近一次注入是否因辅助功能权限缺失被拒绝

function failAllAcks() {
  const list = pendingAcks.splice(0)
  for (const item of list) {
    clearTimeout(item.timer)
    item.resolve(false)
  }
}

function ensure() {
  if (proc) return true
  try {
    if (!fs.existsSync(BIN_PATH)) {
      fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true })
      execFileSync('swiftc', ['-O', '-o', BIN_PATH, SWIFT_PATH], { timeout: 120000 })
    }
    proc = spawn(BIN_PATH, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        // NOPERM <cmd>：注入被拒绝（辅助功能权限缺失）；OK <cmd>：注入已触发
        const denied = line.startsWith('NOPERM ')
        if (!denied && !line.startsWith('OK ')) continue
        const token = line.slice(denied ? 7 : 3).trim()
        if (denied) permissionDenied = true
        const i = pendingAcks.findIndex((item) => item.token === token)
        if (i >= 0) {
          const item = pendingAcks.splice(i, 1)[0]
          clearTimeout(item.timer)
          item.resolve(!denied)
        }
        // 无匹配（fire-and-forget 的指令）则忽略
      }
    })
    proc.on('exit', () => { proc = null; failAllAcks() })
    proc.on('error', () => { proc = null; failAllAcks() })
    return true
  } catch (e) {
    log('mac', '启动平台助手失败，回退 osascript:', e.message)
    return false
  }
}

// fire-and-forget：立即写入 stdin，不等待 ACK（鼠标/手势等）
function send(cmd) {
  if (!ensure() || !proc || !proc.stdin?.writable) return false
  try {
    proc.stdin.write(cmd + '\n')
    return true
  } catch {
    return false
  }
}

// 带 ACK 的指令：等待助手回 `OK <cmd>` 后 resolve(true)，超时 resolve(false)
function sendAck(cmd, timeoutMs = 8000) {
  if (!ensure() || !proc || !proc.stdin?.writable) return Promise.resolve(false)
  return new Promise((resolve) => {
    const token = String(cmd).split(/\s+/)[0]
    const item = { token, resolve, timer: null }
    item.timer = setTimeout(() => {
      const i = pendingAcks.indexOf(item)
      if (i >= 0) pendingAcks.splice(i, 1)
      resolve(false)
    }, timeoutMs)
    pendingAcks.push(item)
    try {
      proc.stdin.write(cmd + '\n')
    } catch {
      clearTimeout(item.timer)
      const i = pendingAcks.indexOf(item)
      if (i >= 0) pendingAcks.splice(i, 1)
      resolve(false)
    }
  })
}

module.exports = { send, sendAck, isPermissionDenied: () => permissionDenied }
