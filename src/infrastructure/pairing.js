// 一次性配对码 + 持久设备令牌管理
// 配对码：6 位数字、短时效、用后即换、失败限速，只在 Mac 本机控制面板展示，扫描二维码拿不到。
// 令牌：配对成功签发，持久化到 pairing.json（只存 sha256）。手机保存原始 token，
//       之后 Mac 重启 / 换网仍凭它鉴权，免重输码。token 与 IP 无关。
const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const paths = require('./paths')

const CODE_TTL_MS = 10 * 60 * 1000 // 配对码有效期：10 分钟
const CODE_MAX_ATTEMPTS = 8        // 当前码连续失败达此数即强制换码（反暴力破解）
const TOKEN_MAX = 20               // 最多记住的已配对设备数；超出淘汰最旧
const PAIR_FILE = path.join(paths.dataDir, 'pairing.json')

let code = null // { value, expiresAt }
let attempts = 0
let tokens = new Map() // sha256hex -> { createdAt }

function loadTokens() {
  try {
    const raw = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'))
    tokens = new Map(Object.entries(raw.tokens || {}))
  } catch {
    tokens = new Map()
  }
}

function saveTokens() {
  const obj = {}
  for (const [hash, meta] of tokens) obj[hash] = meta
  fs.mkdirSync(path.dirname(PAIR_FILE), { recursive: true })
  fs.writeFileSync(PAIR_FILE, JSON.stringify({ tokens: obj }, null, 2), { mode: 0o600 })
}

function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function ensureCode() {
  const now = Date.now()
  if (!code || code.expiresAt <= now) {
    code = { value: randomCode(), expiresAt: now + CODE_TTL_MS }
    attempts = 0
  }
  return code
}

function rotateCode() {
  code = { value: randomCode(), expiresAt: Date.now() + CODE_TTL_MS }
  attempts = 0
}

// 当前可用的配对码（供 Mac 控制面板展示）
function getCode() {
  const c = ensureCode()
  return { code: c.value, expiresInSec: Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 1000)) }
}

// 常量时间比较，避免时序侧信道
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// 校验并消费一次配对码；成功则签发令牌并旋转配对码
function useCode(input) {
  if (input == null || String(input).trim() === '') {
    return { ok: false, error: '请输入 6 位配对码' }
  }
  const c = ensureCode()
  if (timingSafeEqualStr(String(input).trim(), c.value)) {
    const token = issueToken()
    rotateCode() // 用后即换，防止已用过/被截获的码复用
    return { ok: true, token }
  }
  attempts += 1
  if (attempts >= CODE_MAX_ATTEMPTS) rotateCode() // 连续暴力尝试→锁死并换新码
  // 返回机器可读错误码，前端据此映射简洁提示；message 兜底展示完整原因。
  return { ok: false, error: 'code_invalid', message: '配对码不正确或已过期，请查看 Mac 上的配对码' }
}

// 签发一个持久令牌（原始值返回给手机；本地只存哈希）
function issueToken() {
  const raw = crypto.randomBytes(32).toString('hex')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  tokens.set(hash, { createdAt: Date.now() })
  if (tokens.size > TOKEN_MAX) {
    const oldest = [...tokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    tokens.delete(oldest[0])
  }
  saveTokens()
  return raw
}

function validateToken(token) {
  if (!token) return false
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex')
  return tokens.has(hash)
}

loadTokens()

module.exports = { getCode, useCode, rotateCode, validateToken }
