// sherpa provider —— 基于 sherpa-onnx 离线 SenseVoice（非实时，int8 量化）。
//
// 与旧版（流式 zipformer）的关键差异：SenseVoice 是非流式模型，没有逐字 partial，
// 服务端靠「静音分段 + 长句兜底」把上行音频切成一个个 utterance，每段整段识别一次，
// 结果作为「已定稿句」逐句回显。因此离线模式下手机端 VAD 必须关闭（见 server.js effectiveVad），
// 才能拿到带静音边界的完整音频供分段。
//
// SenseVoice 自带标点 + ITN（useInverseTextNormalization），无需再挂独立标点模型。
// 模型全局只加载一次；每个分段创建独立 offline stream。
//
// 仍实现 AsrPort 契约（onion 架构 Infrastructure 层）：
//   createSession({ onPartial(finalized, partial), onFinal(text), config }) -> { start, pushAudio, finish }
//   onPartial 两参：finalized=已定稿句拼接，partial=恒空（非实时无半句）。

const path = require('path')
const fs = require('fs')
const sherpa = require('sherpa-onnx-node')
const { log } = require('../logger')
const paths = require('../paths')
// MODEL_DIR 从 model-download.js 复用：下载按钮与识别读取同一个目录，避免两处写死子目录名漂移。
const { MODEL_DIR } = require('../model-download')

let recognizer = null
let recognizerError = null

function getRecognizer() {
  if (recognizer || recognizerError) return { recognizer, error: recognizerError }
  try {
    const file = (name) => path.join(MODEL_DIR, name)
    for (const name of ['model.int8.onnx', 'tokens.txt']) {
      if (!fs.existsSync(file(name))) throw new Error(`模型文件缺失: ${name}`)
    }
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: file('model.int8.onnx'),
          useInverseTextNormalization: 1, // 中文数字/日期归一化（自带标点，无需标点模型）
        },
        tokens: file('tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    })
    log('asr', 'sherpa-onnx SenseVoice 离线模型加载完成')
  } catch (error) {
    recognizerError = error
    log('asr', '模型加载失败:', error.message)
  }
  return { recognizer, error: recognizerError }
}

// Int16 PCM Buffer -> Float32Array（sherpa-onnx 需要 [-1, 1] 浮点采样）
function int16ToFloat32(buf) {
  const count = Math.floor(buf.length / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768
  }
  return out
}

// Int16 PCM Buffer -> RMS 能量（0~32767），用于静音检测
function rmsOf(buf) {
  const count = Math.floor(buf.length / 2)
  if (count === 0) return 0
  let sum = 0
  for (let i = 0; i < count; i++) {
    const s = buf.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / count)
}

function createSession({ onPartial, onFinal, config }) {
  // 分段配置（来自 config.asr.sherpa，可缺省）
  const cfg = config?.asr?.sherpa || {}
  const SILENCE_BREAK_MS = Number(cfg.silenceBreakMs) || 450 // 停顿超此值钉死一句
  const SILENCE_RMS = Number(cfg.silenceRms) || 28           // 能量阈值，低于判静音（0~32767）
  const VOICE_RMS = Number(cfg.voiceRms) || 300              // 判定为「真实语音」的能量阈值；低于此视为底噪，不识别（防静音幻觉）
  const MAX_SEG_MS = Number(cfg.maxSegmentMs) || 12000       // 长句兜底：不停顿也强制切段，避免长时间无回显
  const PREVIEW_SILENCE_MS = Math.min(SILENCE_BREAK_MS, 200) // 预览识别阈值：静音累积到此时提前识别（与剩余静音等待并行）
  const { recognizer: rec, error } = getRecognizer()

  // 模型不可用时回退到提示，保证链路可诊断
  if (!rec) {
    return {
      start() {},
      pushAudio() {},
      finish() {
        onFinal(`[错误] 语音识别模型不可用: ${error?.message || '未知原因'}`)
      },
    }
  }

  let finished = false
  let segments = []      // 已定稿句（SenseVoice 自带标点，直接拼接）
  const segChunks = []   // 当前待识别分段的 PCM
  const fullChunks = []  // 整段会话音频（用于异常时离线复现）
  let segMs = 0          // 当前分段累计时长(ms)
  // 静音分段状态
  let breakSilenceMs = 0
  let hadVoice = false
  let segHasVoice = false // 当前段是否出现过「真实语音」能量（≥VOICE_RMS），否则视为底噪段，不识别
  // 预览识别：静音累积到 PREVIEW_SILENCE_MS 就提前跑一次识别，与「静音等待」并行，
  // 正式定稿时复用结果、隐藏 decode 耗时；previewSeq 用于作废「预览后又开口」的过期结果。
  let previewTriggered = false
  let pendingText = null
  let previewSeq = 0

  // 会话音频落盘：识别异常时可用原始音频离线复现，定位问题在音频链路还是识别层
  function dumpAudio() {
    try {
      const pcm = Buffer.concat(fullChunks)
      if (pcm.length < 3200) return // 短于 0.1s 的不存
      const dir = paths.debugDir
      fs.mkdirSync(dir, { recursive: true })
      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(36 + pcm.length, 4)
      header.write('WAVEfmt ', 8)
      header.writeUInt32LE(16, 16)
      header.writeUInt16LE(1, 20) // PCM
      header.writeUInt16LE(1, 22) // mono
      header.writeUInt32LE(16000, 24)
      header.writeUInt32LE(32000, 28) // byteRate
      header.writeUInt16LE(2, 32) // blockAlign
      header.writeUInt16LE(16, 34) // bitsPerSample
      header.write('data', 36)
      header.writeUInt32LE(pcm.length, 40)
      const name = `session-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`
      fs.writeFileSync(path.join(dir, name), Buffer.concat([header, pcm]))
      log('asr', '音频已保存: debug/' + name)
    } catch (error) {
      log('asr', '音频保存失败:', error.message)
    }
  }

  // 把一段 Int16 PCM 跑一次 SenseVoice，返回识别文本（空则 ''）
  function transcribe(buf) {
    const samples = int16ToFloat32(buf)
    // 过短片段识别噪声/效果差，跳过；避免把无意义的静音段也转成字
    if ((samples.length / 16000) * 1000 < 300) return ''
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    rec.decode(stream)
    return (rec.getResult(stream).text || '').trim()
  }

  // 按 SILENCE_RMS 掐掉段首/段尾的静音边（10ms 窗 RMS）。SenseVoice 在纯静音上会
  // 幻觉出 "I am."/"Yeah." 等高频英文填充词，识别前把静音边切掉，只留真实语音。
  function trimSilence(buf) {
    const frame = 160 // 10ms @16k 的样本数
    const n = Math.floor(buf.length / 2)
    let start = 0
    let end = Math.floor(n / frame)
    while (start < end && rmsOf(buf.subarray(start * frame * 2, (start + 1) * frame * 2)) < SILENCE_RMS) start++
    while (end > start && rmsOf(buf.subarray((end - 1) * frame * 2, end * frame * 2)) < SILENCE_RMS) end--
    return buf.subarray(start * frame * 2, end * frame * 2)
  }

  // 提前识别当前语音段：静音累积到 PREVIEW_SILENCE_MS 就异步跑一次（与剩余静音等待并行）。
  // 结果缓存到 pendingText，正式定稿时复用；若预览后又开口（previewSeq 变化）则作废。
  function triggerPreview() {
    if (segChunks.length === 0 || !segHasVoice) return
    const buf = Buffer.concat(segChunks)
    const mySeq = previewSeq
    setImmediate(() => {
      if (mySeq !== previewSeq) return // 预览期间又检测到语音，结果作废
      pendingText = transcribe(trimSilence(buf)) || null
    })
  }

  // 把当前缓存段钉死为已定稿句，并回显（finalized=全部定稿句，partial 恒空）
  function commitSegment() {
    if (segChunks.length === 0) return
    const buf = Buffer.concat(segChunks)
    segChunks.length = 0
    segMs = 0
    const hadRealVoice = segHasVoice
    segHasVoice = false
    // 整段没出现过真实语音能量 → 是静音/底噪段，直接丢弃，不送进模型（防幻觉）
    if (!hadRealVoice) {
      log('asr', `丢弃静音段（无语音，${Math.round((buf.length / 2 / 16000) * 1000)}ms）`)
      return
    }
    // 优先复用预览结果（预览已把 decode 耗时藏在静音等待里）；未就绪则同步兜底识别。
    const text = pendingText != null ? pendingText : transcribe(trimSilence(buf))
    if (text) {
      segments.push(text)
      log('asr', `分段定稿 #${segments.length}: ${text}`)
      onPartial(segments.join(''), '')
    }
  }

  return {
    start() {
      finished = false
      segments = []
      segChunks.length = 0
      fullChunks.length = 0
      segMs = 0
      breakSilenceMs = 0
      hadVoice = false
      segHasVoice = false
    },
    pushAudio(buf) {
      if (finished) return
      const chunk = Buffer.from(buf)
      segChunks.push(chunk)
      fullChunks.push(chunk)
      const chunkMs = (chunk.length / 2 / 16000) * 1000
      segMs += chunkMs

      // 静音分段：迟滞三段判定（语音 / 静音 / 中间地带）。
      //   ≥VOICE_RMS  真实语音：开启分段、清零停顿
      //   <SILENCE_RMS 静音：累计停顿，够窗口就钉死当前句
      //   中间地带（底噪）：保持当前状态，既不误开分段、也不打断已有语音
      const rms = rmsOf(chunk)
      if (rms >= VOICE_RMS) {
        hadVoice = true
        segHasVoice = true
        breakSilenceMs = 0
        previewTriggered = false
        pendingText = null
        previewSeq++ // 作废上一次预览（若其异步识别尚未执行完）
      } else if (rms < SILENCE_RMS) {
        if (hadVoice) {
          breakSilenceMs += chunkMs
          if (!previewTriggered && breakSilenceMs >= PREVIEW_SILENCE_MS) {
            previewTriggered = true
            triggerPreview()
          }
        }
      }
      if (hadVoice && breakSilenceMs >= SILENCE_BREAK_MS) {
        breakSilenceMs = 0
        hadVoice = false
        commitSegment()
        previewTriggered = false
        pendingText = null
        return
      }
      // 长句兜底：即使不停顿，累计到 MAX_SEG_MS 也强制切一段，避免长时间无回显。
      if (segMs >= MAX_SEG_MS) {
        commitSegment()
      }
    },
    finish() {
      if (finished) return
      finished = true
      dumpAudio()
      commitSegment() // 把最后残留段一并定稿
      onFinal(segments.join(''))
    },
  }
}

module.exports = { createSession }
