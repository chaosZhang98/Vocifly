// 下载 SenseVoice 离线模型（model.int8.onnx ~230MB + tokens.txt）到 app/models/
// 一次性脚本；模型文件已存在且非空则跳过。
// 用法: node scripts/download-sensevoice.js
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const BASE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
const DEST = path.join(__dirname, '..', 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17')

fs.mkdirSync(DEST, { recursive: true })

for (const name of ['model.int8.onnx', 'tokens.txt']) {
  const dest = path.join(DEST, name)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`已存在，跳过: ${name}`)
    continue
  }
  console.log(`下载 ${name} …`)
  execSync(`curl -L --fail --progress-bar --output "${dest}" "${BASE}/${name}"`, { stdio: 'inherit' })
}

console.log(`\n完成。模型目录: ${DEST}`)
console.log('验证: npm run test:asr')
