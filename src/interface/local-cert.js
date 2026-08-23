// 本地 HTTPS 证书管理：检查 SAN，网络环境变化时自动重签服务端证书
const { execFileSync } = require('child_process')
const { X509Certificate } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const paths = require('../infrastructure/paths')

const CERT_DIR = paths.certsDir
const CERT_FILE = path.join(CERT_DIR, 'phvoice-local.pem')
const KEY_FILE = path.join(CERT_DIR, 'phvoice-local-key.pem')
const CA_FILE = path.join(CERT_DIR, 'phvoice-ca.pem')

// 是否为“真实局域网”私网地址（192.168.x / 10.x / 172.16-31.x）
function isPrivateIPv4(ip) {
  const o = String(ip).split('.').map(Number)
  if (o.length !== 4 || o.some(Number.isNaN)) return false
  const [a, b] = o
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

// 保留段 / 代理伪地址：手机无法路由到这些地址，绝不能当作 LAN IP 下发
function isReservedIPv4(ip) {
  const o = String(ip).split('.').map(Number)
  if (o.length !== 4 || o.some(Number.isNaN)) return true
  const [a, b] = o
  if (a === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true // Benchmarking / Clash、Surge 等代理的假 IP
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // Link-local
  return false
}

// 隧道 / 虚拟 / 辅助网卡：VPN、TUN/TAP、AWDL、Bridge、点对点等，手机通常连不上
function isVirtualIface(name) {
  return /^(utun|tun|tap|ppp|ipsec|awdl|llw|bridge|anpi|gif|stf|lo)/i.test(name || '')
}

function getLanIp() {
  const list = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const item of addrs || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const address = item.address
      if (isReservedIPv4(address)) continue
      list.push({ name, address, private: isPrivateIPv4(address), virtual: isVirtualIface(name) })
    }
  }
  // 真实网卡 > 虚拟隧道；私网 > 公网；其余稳定排序
  list.sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1
    if (a.private !== b.private) return a.private ? -1 : 1
    return 0
  })
  return list.length ? list[0].address : null
}

function getLocalHostname() {
  try {
    return `${execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`
  } catch {
    return `${os.hostname()}.local`
  }
}

function commandExists(command) {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function certCoversCurrentNetwork() {
  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) return false
  try {
    const san = new X509Certificate(fs.readFileSync(CERT_FILE)).subjectAltName || ''
    const required = [getLanIp(), getLocalHostname()].filter(Boolean)
    return required.every((name) => san.includes(name))
  } catch {
    return false
  }
}

function ensureLocalCertificate() {
  if (!commandExists('mkcert')) {
    return { ok: false, reason: '未安装 mkcert，请先运行 brew install mkcert' }
  }

  let caRoot
  try {
    caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim()
  } catch (error) {
    return { ok: false, reason: `无法读取 mkcert CA 目录: ${error.message}` }
  }

  const rootCaFile = path.join(caRoot, 'rootCA.pem')
  if (!fs.existsSync(rootCaFile)) {
    return { ok: false, reason: '本地 CA 尚未创建，请先运行 npm run setup:https' }
  }

  const lanIp = getLanIp()
  const localHostname = getLocalHostname()
  const names = ['localhost', '127.0.0.1', '::1', lanIp, localHostname].filter(Boolean)

  try {
    fs.mkdirSync(CERT_DIR, { recursive: true })
    if (!certCoversCurrentNetwork()) {
      execFileSync('mkcert', ['-cert-file', CERT_FILE, '-key-file', KEY_FILE, ...names], { stdio: 'pipe' })
    }
    fs.copyFileSync(rootCaFile, CA_FILE)
  } catch (error) {
    return { ok: false, reason: `本地证书生成失败: ${error.message}` }
  }

  return { ok: true, certFile: CERT_FILE, keyFile: KEY_FILE, caFile: CA_FILE, lanIp, localHostname, names }
}

module.exports = { ensureLocalCertificate, getLanIp, getLocalHostname, CERT_FILE, KEY_FILE, CA_FILE }
