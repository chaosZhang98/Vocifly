#!/usr/bin/env node
// 生成本地局域网 HTTPS 证书。只依赖 mkcert，不访问外部服务。
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CERT_DIR = path.join(__dirname, '..', 'runtime', 'certs')
const CERT_FILE = path.join(CERT_DIR, 'phvoice-local.pem')
const KEY_FILE = path.join(CERT_DIR, 'phvoice-local-key.pem')
const CA_FILE = path.join(CERT_DIR, 'phvoice-ca.pem')

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`)
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

function getLanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const item of addrs || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  throw new Error('没有找到局域网 IP，请确认 Mac 已连接 Wi-Fi')
}

function getLocalHostname() {
  const name = run('scutil', ['--get', 'LocalHostName'])
  return `${name}.local`
}

try {
  run('mkcert', ['-version'])
} catch {
  console.error('未找到 mkcert。请先运行: brew install mkcert')
  process.exit(1)
}

const lanIp = getLanIp()
const localHostname = getLocalHostname()
const names = ['localhost', '127.0.0.1', '::1', lanIp, localHostname]

fs.mkdirSync(CERT_DIR, { recursive: true })

// 尝试把本地 CA 安装到 Mac 钥匙串。失败（通常是等待系统密码）时仍继续：
// iPhone 只需要后面的 rootCA.pem，Mac 端信任可稍后由用户手动完成。
try {
  run('mkcert', ['-install'])
} catch (error) {
  console.warn('\n[提示] Mac 钥匙串信任未完成，通常是系统密码弹窗不可用。')
  console.warn('这不影响生成 iPhone 所需的 CA 文件；稍后可手动运行 mkcert -install。')
}
run('mkcert', ['-cert-file', CERT_FILE, '-key-file', KEY_FILE, ...names])
fs.copyFileSync(path.join(run('mkcert', ['-CAROOT']), 'rootCA.pem'), CA_FILE)

console.log('\n本地 HTTPS 证书已生成:')
console.log(`证书: ${CERT_FILE}`)
console.log(`私钥: ${KEY_FILE}`)
console.log(`手机需要安装的 CA: ${CA_FILE}`)
console.log(`\n已覆盖以下地址:\n- ${names.join('\n- ')}`)
