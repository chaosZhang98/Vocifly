// 离线自测：用 wav 文件跑当前配置的 ASR provider
// 用法: node scripts/test-asr.js [wav路径]
// 默认走 sherpa（本地 SenseVoice 离线模型）；想测百炼先配好 config.json，再:
//   VOCIFLY_ASR_PROVIDER=bailian node scripts/test-asr.js [wav路径]
const path = require('path')
const fs = require('fs')
const sherpa = require('sherpa-onnx-node')
const asr = require('../src/infrastructure/asr')

// 默认取 SenseVoice 自带的中文测试 wav；也可手动指定: node scripts/test-asr.js <wav路径>
const SENSE_DIR = path.join(__dirname, '..', 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17')
const candidates = [
  process.argv[2],
  path.join(SENSE_DIR, 'test_wavs', 'zh.wav'),
]
const wavFile = candidates.find((p) => p && fs.existsSync(p))
if (!wavFile) {
  console.error('未找到测试 wav，请先下载 SenseVoice 模型，或手动指定: node scripts/test-asr.js <wav路径>')
  process.exit(1)
}

const wave = sherpa.readWave(wavFile)
console.log(`测试音频: ${path.basename(wavFile)}  采样率=${wave.sampleRate}  时长=${(wave.samples.length / wave.sampleRate).toFixed(1)}s`)

if (wave.sampleRate !== 16000) {
  console.error('采样率不是 16kHz，跳过（生产链路中手机端已统一为 16kHz）')
  process.exit(1)
}

// float32 -> Int16 Buffer，模拟手机端上行格式
const pcm = Buffer.alloc(wave.samples.length * 2)
for (let i = 0; i < wave.samples.length; i++) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(wave.samples[i] * 32767))), i * 2)
}

let settled = false
const session = asr.createSession({
  onPartial: (finalized, partial) =>
    console.log(`[partial] finalized=${JSON.stringify(finalized)} partial=${JSON.stringify(partial || '')}`),
  onFinal: (text) => {
    if (settled) return
    settled = true
    console.log(`[final]   ${text}`)
    process.exit(0)
  },
})

setTimeout(() => {
  if (!settled) {
    console.error('[timeout] 等待 final 结果超时（云端 provider 需要外网与有效凭证）')
    process.exit(1)
  }
}, 20000).unref()

session.start()
// 按 0.2s 一块推入，模拟实时上行节奏
const chunkBytes = 16000 * 2 * 0.2
for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
  session.pushAudio(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)))
}
session.finish()
