// 统一日志：控制台 + logs/app.log 文件
// 手机端关键事件也通过 WebSocket 上报到这里集中记录，
// 排查问题时直接看 logs/app.log 即可还原完整链路。
const fs = require('fs')
const path = require('path')
const paths = require('./paths')

const LOG_DIR = paths.logsDir
const LOG_FILE = path.join(LOG_DIR, 'app.log')
const MAX_BYTES = 5 * 1024 * 1024 // 超过 5MB 滚动一次，避免无限增长

let stream = null

function getStream() {
  if (!stream) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    // 启动时检查大小，超限就把旧日志改名存档，重新开始
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, `app-${Date.now()}.log`))
      }
    } catch {}
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
  }
  return stream
}

function timestamp() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function stringify(arg) {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.message}\n${arg.stack}`
  try { return JSON.stringify(arg) } catch { return String(arg) }
}

function log(scope, ...args) {
  const line = `[${timestamp()}] [${scope}] ${args.map(stringify).join(' ')}`
  console.log(line)
  try { getStream().write(line + '\n') } catch {}
}

module.exports = { log }
