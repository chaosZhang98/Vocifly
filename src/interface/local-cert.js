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

// 私钥只应属主可读写（0600）。mkcert 生成时一般为 0600，但做纵深防御、不依赖时序：
// 在校验/生成路径都显式强制一次，避免异常情况下私钥落到更宽松的权限。
function ensureKeyPerms() {
  try {
    fs.chmodSync(KEY_FILE, 0o600)
  } catch {
    // 私钥尚不存在（首次生成前）或系统不支持 chmod，忽略：该路径随后仍会校验存在性
  }
}

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

// mkcert 可能不在 GUI 进程 PATH（Finder/launchd 默认无 /opt/homebrew/bin），
// 先按常见安装位置 + 打包内 + PATH 兜底找，避免把"找不到可执行文件"误判成"未安装"。
function mkcertCandidatePaths() {
  const candidates = []
  // 打包态：mkcert 随 DMG 一起分发（electron-builder extraResources → Resources/bin/）
  try {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', `mkcert-${process.arch}`))
  } catch { /* 纯 node / dev 模式无 resourcesPath */ }
  // 源码态：bin/ 下的下载产物（scripts/fetch-mkcert.js）
  candidates.push(path.join(__dirname, '..', '..', 'bin', `mkcert-${process.arch}`))
  // Homebrew / 系统常见位置
  candidates.push('/opt/homebrew/bin/mkcert', '/usr/local/bin/mkcert', '/usr/bin/mkcert')
  return candidates
}

function findMkcert() {
  for (const c of mkcertCandidatePaths()) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      return c
    } catch {
      // 继续找下一个
    }
  }
  try {
    execFileSync('mkcert', ['-version'], { stdio: 'ignore' })
    return 'mkcert'
  } catch {
    return null
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

// 检查「服务器证书能否被系统信任链验证通过」= 根 CA 是否已进入系统信任。
// 注意：不能用 verify-cert -c <根CA> 检测（自签根会被当叶子，恒报 NOT_TRUSTED）。
// 正确语义：对服务器(leaf)证书跑 -p ssl 验证系统信任链；通过 ⇒ CA 已被系统信任。
function systemTrustsServerCert() {
  if (!fs.existsSync(CERT_FILE)) return false
  try {
    const out = execFileSync('security', ['verify-cert', '-c', CERT_FILE, '-p', 'ssl'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.includes('verification successful') && !out.includes('NOT_TRUSTED')
  } catch {
    return false
  }
}

// 通过系统授权框信任根 CA：把 CA 写入【用户钥匙串】（login.keychain-db）。
//
// 为什么是用户钥匙串而不是系统钥匙串（System.keychain）：
// - System.keychain 需要 root 写权限，普通进程裸调 security 报 "Write permissions error"
// - osascript `with administrator privileges` 包裹会出现「嵌套二次授权」被 macOS 15 拒绝
//   （"no user interaction was possible"）
// - 用户钥匙串只需一次 GUI 授权（SecurityAgent 弹框），用户输密码即落地，
//   且 Chrome / Safari / 系统同样读取用户钥匙串的信任设置
// - 实测 login.keychain 方案的授权框能正常弹出（此前失败码是 "canceled by the user"，
//   即框弹了但没确认）
//
// 同步阻塞：系统授权框是模态的，首次信任等用户输一次密码是预期体验；非首次不应走到这里。
function trustRootCaViaGuiSync(caFile) {
  const keychain = path.join(require('os').homedir(), 'Library', 'Keychains', 'login.keychain-db')
  return execFileSync('/usr/bin/security', [
    'add-trusted-cert',
    '-r', 'trustRoot', // 信任等级：根证书
    '-k', keychain,
    String(caFile),
  ], { encoding: 'utf8', timeout: 120000 })
}

// 确保根 CA 已进系统信任（幂等：已信任直接返回）。弹授权框失败不致命——
// 只影响 Mac 本机浏览器访问时弹信任警告；手机侧信任由 mobileconfig / CA 安装流程
// 负责（iOS『设置>通用>VPN 与设备管理』/ Android『受信任的凭据』），完全不依赖 Mac 钥匙串。
// 注意：此函数会弹系统授权框（阻塞等用户输密码），只在控制面板显式按钮/菜单触发时调用；
// 启动探测用 macCertTrusted()（不弹框）。
function ensureMacTrust() {
  try {
    if (systemTrustsServerCert()) return { macTrusted: true }
    trustRootCaViaGuiSync(CA_FILE)
    return { macTrusted: systemTrustsServerCert() }
  } catch (error) {
    return { macTrusted: false, reason: error.message }
  }
}

// 非交互探测：当前服务器证书是否已获系统信任（不弹任何框）。
function macCertTrusted() {
  try {
    return systemTrustsServerCert()
  } catch {
    return false
  }
}

function ensureLocalCertificate() {
  const lanIp = getLanIp()
  const localHostname = getLocalHostname()
  const names = ['localhost', '127.0.0.1', '::1', lanIp, localHostname].filter(Boolean)

  // 已有证书且 SAN 覆盖当前网络 → 直接使用，无需 mkcert。
  // mkcert 只在需要新建/重签时才用到；GUI 启动的进程 PATH 常无 homebrew，不应因此强行退 HTTP。
  if (certCoversCurrentNetwork() && fs.existsSync(CA_FILE)) {
    ensureKeyPerms()
    return { ok: true, certFile: CERT_FILE, keyFile: KEY_FILE, caFile: CA_FILE, lanIp, localHostname, names, macTrusted: systemTrustsServerCert() }
  }

  // 没有有效证书 → 需要 mkcert 新建/重签
  const mkcert = findMkcert()
  if (!mkcert) {
    if (process.app && process.app.isPackaged) {
      return { ok: false, reason: '打包内未找到 mkcert，证书初始化失败' }
    }
    return { ok: false, reason: '未安装 mkcert，请先运行 npm run setup:https' }
  }

  // 签发服务器证书。mkcert -cert-file 在 CA 不存在时会自动创建（用户权限即可，
  // 无需系统授权），随后才需要单独的信任步骤（ensureMacTrust）。
  // 上一步不存在 CA 目录时 mkcert 也会创建，这里不预生成 rootCA 文件。
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true })
    execFileSync(mkcert, ['-cert-file', CERT_FILE, '-key-file', KEY_FILE, ...names], { stdio: 'pipe' })
    ensureKeyPerms()
  } catch (error) {
    return { ok: false, reason: `本地证书生成失败: ${error.message}` }
  }

  // 根 CA 就在 mkcert CAROOT 下；复制到 runtime/certs 供手机安装页下发
  let caRoot
  try {
    caRoot = execFileSync(mkcert, ['-CAROOT'], { encoding: 'utf8' }).trim()
    const rootCaFile = path.join(caRoot, 'rootCA.pem')
    if (!fs.existsSync(rootCaFile)) return { ok: false, reason: '未找到 rootCA.pem，证书初始化异常' }
    fs.copyFileSync(rootCaFile, CA_FILE)
  } catch (error) {
    return { ok: false, reason: `无法读取 mkcert CA 目录: ${error.message}` }
  }

  return { ok: true, certFile: CERT_FILE, keyFile: KEY_FILE, caFile: CA_FILE, lanIp, localHostname, names, macTrusted: systemTrustsServerCert() }
}

module.exports = { ensureLocalCertificate, ensureMacTrust, macCertTrusted, findMkcert, getLanIp, getLocalHostname, CERT_FILE, KEY_FILE, CA_FILE }
