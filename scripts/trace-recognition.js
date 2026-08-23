// PhVoice · 端到端识别过程动态追踪（step-by-step 日志版）
//
// 目的：把「语音输入 → ASR 实时识别 → 上屏显示」整条链路逐步打印出来，
//       逐帧回放真实音频（sherpa 离线流式），记录每帧上行、每次
//       onPartial(已定稿, 当前半句) 分层、onFinal 定稿、以及最终上屏文本。
//       用于观察前后步骤是否一致，定位丢字/滞后/misalignment/错字等问题。
//
// 用法：
//   node app/debug/trace-recognition.js [wav] [帧延时ms]
//   默认用 debug/session-2026-08-23T13-21-38-796Z.wav，帧延时 40ms（模拟实时上行）
//
// 说明：这里刻意复用真实 infrastructure/asr/sherpa + application/SessionService，
//       不上屏真环境、不联网、不写配置 —— 只把过程插桩打印，结果可复现。

const fs = require('fs')
const path = require('path')

const { SessionService } = require('../src/application/SessionService')
const { config } = require('../src/infrastructure/config') // 真实线上配置（asr.provider: bailian）
const asrProvider = require('../src/infrastructure/asr')  // 工厂：按 config.asr.provider 分发（当前=bailian）

const WAV = process.argv[2] || path.join(__dirname, '..', 'runtime', 'debug', 'session-2026-08-23T13-21-38-796Z.wav')
const DELAY = Number(process.argv[3] || 40) // 每帧间隔 ms，模拟实时上行节奏（0=一次推完）

// ---- 带时间戳的日志（核心输出）----
const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(3)}s`
const logs = []
function log(scope, ...args) {
  const line = `[${ts()}] [${scope.padEnd(8)}] ` + args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  logs.push(line)
}

// ---- 上屏 / 计费端口：只捕获、不真实执行 ----
const pasted = []
const paster = {
  paste: (t, o) => { log('上屏', JSON.stringify(t)); pasted.push({ t, o }); return Promise.resolve(true) },
  pasteImage: async () => true,
  pasteFile: async () => true,
  send: () => log('发送', '模拟回车'),
  deleteStep: (t) => log('回退', JSON.stringify(t)),
  switchWindow: () => {},
  activateApp: () => {},
}
const usage = {
  recordUsage: (o) => { log('计费', `${o.seconds.toFixed(1)}s / ¥xxx`); return { billableSeconds: 1, costYuan: 0.001 } },
  patchLastText: (t) => log('计费补丁', JSON.stringify(t)),
  checkBudgetAndMaybeDowngrade: () => {},
  getAsrPricePerSecond: () => 0.00001,
}
// 真实 SessionService + 真实 provider（按线上 config 分发，当前=bailian 阿里云）
const svc = new SessionService({
  asr: asrProvider,
  paster,
  usage,
  config,
  enablePaste: true,
  log,
  emit: (p) => log('emit', JSON.stringify(p)),
  connId: 'trace',
})

// ---- WAV 解析：取 data chunk 的 Int16 PCM ----
function readPcm16(wavPath) {
  const buf = fs.readFileSync(wavPath)
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32LE(off + 4)
    if (id === 'data') return buf.subarray(off + 8, off + 8 + len)
    off += 8 + len + (len % 2)
  }
  throw new Error('未找到 data chunk')
}

;(async () => {
  const pcm = readPcm16(WAV)
  const totalSec = pcm.length / 2 / 16000
  log('起始', '='.repeat(58))
  log('起始', `载入 ${path.basename(WAV)}：${pcm.length}B ≈ ${totalSec.toFixed(2)}s（16k mono Int16）`)
  log('起始', `provider=${config.asr.provider} · enablePaste=true · 帧间隔=${DELAY}ms`)
  log('起始', '='.repeat(58))

  svc.start()

  const CHUNK = 3200 // 100ms 一块
  let sent = 0
  let frame = 0
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const chunk = pcm.subarray(i, i + CHUNK)
    svc.pushAudio(chunk)
    sent += chunk.length
    frame += 1
    if (DELAY) await new Promise((r) => setTimeout(r, DELAY))
    if (frame % 5 === 0 || i + CHUNK >= pcm.length) {
      const s = sent / 2 / 16000
      log('上行', `帧#${frame} 已送 ${s.toFixed(2)}s / ${totalSec.toFixed(2)}s (${((sent / pcm.length) * 100).toFixed(0)}%)`)
    }
  }

  await new Promise((r) => setTimeout(r, 200))
  log('推送', `音频推流完成（${frame} 帧，${(sent / 2 / 16000).toFixed(2)}s），触发结束识别 finish`)
  svc.stop()
  await new Promise((r) => setTimeout(r, 400))

  // ---- 汇总对比 ----
  const lastPaste = pasted[pasted.length - 1]
  log('汇总', '='.repeat(58))
  log('汇总', 'STEP 对比：音频 → partial分层 → final → 上屏 是否一致')
  log('汇总', '='.repeat(58))
  log('汇总', `原始音频时长   : ${totalSec.toFixed(2)}s`)
  log('汇总', `上行总帧数     : ${frame} 帧`)
  log('汇总', `emit final 次数: ${logs.filter((l) => l.includes('"type":"final"')).length}`)
  log('汇总', `上屏(paste)次数: ${pasted.length}`)
  log('汇总', `最终上屏文本   : ${JSON.stringify(lastPaste ? lastPaste.t : '(无)')}`)
  log('汇总', `final 与上屏一致: ${lastPaste && logs.some((l) => l.includes(`final`)) ? '是' : '待人工核对'}`)
})().catch((e) => {
  console.error('✗ FAILED:', e)
  process.exit(1)
})
