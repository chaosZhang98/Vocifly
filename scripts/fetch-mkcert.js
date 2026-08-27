#!/usr/bin/env node
// 下载 mkcert 二进制（用于打包进 DMG，让用户无需 brew install）。
// 只支持 macOS arm64（当前打包目标）。如果已存在且校验通过，跳过下载。
// 用法: node scripts/fetch-mkcert.js [--force]
const fs = require('fs')
const https = require('https')
const path = require('path')
const crypto = require('crypto')

const VERSION = 'v1.4.4'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'
const URL = `https://github.com/FiloSottile/mkcert/releases/download/${VERSION}/mkcert-${VERSION}-darwin-${ARCH}`
const SHA256 = {
  arm64: 'c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6',
  amd64: '8f2ac7e6a13a81609d4a17cf91081c8d4f8d67a3b59d0843d222762ea4dcbaba',
}

const DEST = path.join(__dirname, '..', 'bin', `mkcert-${ARCH}`)
const FORCE = process.argv.includes('--force')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    https.get(url, { headers: { 'User-Agent': 'vocifly-fetch-mkcert' } }, (res) => {
      // GitHub release 会 302 到 S3，必须跟随
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        file.destroy()
        fs.unlinkSync(dest)
        const next = res.headers.location.startsWith('http') ? res.headers.location : `https://github.com${res.headers.location}`
        console.log(`重定向 ${res.statusCode} → ${next}`)
        download(next, dest, redirects + 1).then(resolve, reject)
        res.resume()
        return
      }
      if (res.statusCode !== 200) {
        file.destroy()
        fs.unlinkSync(dest)
        reject(new Error(`HTTP ${res.statusCode}，下载失败: ${url}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', (err) => {
      file.destroy()
      reject(err)
    })
  })
}

async function main() {
  fs.mkdirSync(path.dirname(DEST), { recursive: true })

  if (!FORCE && fs.existsSync(DEST)) {
    const existing = sha256(DEST)
    if (existing === SHA256[ARCH]) {
      console.log(`mkcert 已存在（checksum 通过）: ${DEST}`)
      return
    }
    console.log('已存在但 checksum 不符，重新下载…')
  }

  const expected = SHA256[ARCH]
  console.log(`下载 mkcert ${VERSION} (${ARCH})…`)
  const tmp = DEST + '.tmp'
  await download(URL, tmp)
  const actual = sha256(tmp)
  if (actual !== expected) {
    fs.unlinkSync(tmp)
    console.error(`checksum 校验失败!\n期望: ${expected}\n实际: ${actual}`)
    process.exit(1)
  }
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, DEST)
  console.log(`完成: ${DEST}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
