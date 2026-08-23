// 把 mkcert 根证书包装成 iPhone 更容易识别的 .mobileconfig 描述文件
const { createHash } = require('crypto')
const fs = require('fs')

function stableUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function pemToBase64Der(pem) {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
}

function buildMobileConfig(caFile) {
  const pem = fs.readFileSync(caFile, 'utf8')
  const certBase64 = pemToBase64Der(pem)
  const payloadUuid = stableUuid(`phvoice-payload:${certBase64}`)
  const profileUuid = stableUuid(`phvoice-profile:${certBase64}`)

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>phvoice-ca.cer</string>
      <key>PayloadContent</key>
      <data>${certBase64}</data>
      <key>PayloadDescription</key>
      <string>允许这台 iPhone 信任 PhVoice 的局域网 HTTPS 服务。</string>
      <key>PayloadDisplayName</key>
      <string>PhVoice 本地根证书</string>
      <key>PayloadIdentifier</key>
      <string>com.phvoice.local-ca.certificate</string>
      <key>PayloadOrganization</key>
      <string>PhVoice</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${payloadUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>用于 iPhone 通过局域网安全连接这台 Mac 上的 PhVoice。</string>
  <key>PayloadDisplayName</key>
  <string>PhVoice 本地证书</string>
  <key>PayloadIdentifier</key>
  <string>com.phvoice.local-ca</string>
  <key>PayloadOrganization</key>
  <string>PhVoice</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`
}

module.exports = { buildMobileConfig }
