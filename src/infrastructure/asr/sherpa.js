// sherpa provider —— 基于 sherpa-onnx 流式 zipformer（中英双语，int8 量化）
// 说完后用 ct-transformer 标点模型对整段做一次优化，再上屏。
// 模型全局只加载一次；每次识别会话创建一个独立 stream。

const path = require('path')
const fs = require('fs')
const sherpa = require('sherpa-onnx-node')
const { log } = require('../logger')
const paths = require('../paths')

const MODEL_DIR = path.join(paths.modelsDir, 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20')
const PUNCT_DIR = path.join(paths.modelsDir, 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12')

let recognizer = null
let recognizerError = null
let punctuator = null

// 标点模型独立懒加载：失败不影响识别主流程，只退回无标点结果
function getPunctuator() {
  if (punctuator !== null) return punctuator
  try {
    const int8 = path.join(PUNCT_DIR, 'model.int8.onnx')
    const fp32 = path.join(PUNCT_DIR, 'model.onnx')
    const modelFile = fs.existsSync(int8) ? int8 : fp32
    if (!fs.existsSync(modelFile)) throw new Error('标点模型文件缺失')
    punctuator = new sherpa.OfflinePunctuation({
      model: { ctTransformer: modelFile, numThreads: 1, provider: 'cpu', debug: 0 },
    })
    log('asr', '标点模型加载完成:', path.basename(modelFile))
  } catch (error) {
    log('asr', '标点模型加载失败，退回无标点模式:', error.message)
    punctuator = false
  }
  return punctuator
}

function getRecognizer() {
  if (recognizer || recognizerError) return { recognizer, error: recognizerError }
  try {
    const file = (name) => path.join(MODEL_DIR, name)
    for (const name of [
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.int8.onnx',
      'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt',
    ]) {
      if (!fs.existsSync(file(name))) throw new Error(`模型文件缺失: ${name}`)
    }
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: file('encoder-epoch-99-avg-1.int8.onnx'),
          decoder: file('decoder-epoch-99-avg-1.int8.onnx'),
          joiner: file('joiner-epoch-99-avg-1.int8.onnx'),
        },
        tokens: file('tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      // 判停阈值放宽：1.2s 太容易把拖长的音/自然停顿切成两段，
      // 切分点前的字会被重复识别（"我——也不知道" -> "我我我 也不知道"）。
      // 断句主要靠 final 的标点模型，endpoint 只做长停顿兜底。
      rule2MinTrailingSilence: 2.0,
      rule3MinUtteranceLength: 30,
    })
    log('asr', 'sherpa-onnx 流式模型加载完成')
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
  // 静音分段配置（来自 config.asr.sherpa，可缺省）
  const cfg = config?.asr?.sherpa || {}
  const SILENCE_BREAK_MS = Number(cfg.silenceBreakMs) || 450 // 停顿超此值钉死一句，前端做「已定稿/半句」分层
  const SILENCE_RMS = Number(cfg.silenceRms) || 28           // 能量阈值，低于判静音（0~32767）
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

  let stream = null
  let finished = false
  let lastPartial = ''
  let segments = []
  let currentSeg = ''
  const pcmChunks = []
  // 静音分段状态：连续静音超阈值就钉死一句，让前端分层（否则整段一直当 partial 变来变去）
  let breakSilenceMs = 0
  let hadVoice = false

  // 会话音频落盘：识别异常时可用原始音频离线复现，定位问题在音频链路还是识别层
  function dumpAudio() {
    try {
      const pcm = Buffer.concat(pcmChunks)
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

  function drain() {
    while (rec.isReady(stream)) rec.decode(stream)
    let seg = rec.getResult(stream).text.trim()
    // 停顿触发 endpoint：把这一句钉死（加句号），重置解码状态再收下一句。
    // 不 reset 的话内部状态持续累积，后续输出会错乱重复。
    while (rec.isEndpoint(stream)) {
      if (seg) {
        segments.push(seg)
        log('asr', `停顿断句 #${segments.length}: ${seg}`)
      }
      rec.reset(stream)
      while (rec.isReady(stream)) rec.decode(stream)
      seg = rec.getResult(stream).text.trim()
    }
    currentSeg = seg
    const base = segments.join('。')
    // 有中间结果时，已定稿末尾补上句号，避免前端两段拼接后「A。BC」少标点
    const head = base && seg ? `${base}。` : base
    const full = head + seg
    if (full && full !== lastPartial) {
      lastPartial = full
      onPartial(head, seg)
    }
  }

  // 静音分段：把当前半句钉死为已定稿句，并重置解码器开始下一句。
  // 这样长段落说一轮，前端能实时看到「已定稿句越来越多、半句单独变」，不会整段抖。
  function commitSilenceBreak() {
    const seg = currentSeg
    if (!seg) return
    segments.push(seg)
    log('asr', `静音断句 #${segments.length}: ${seg}`)
    rec.reset(stream)
    currentSeg = ''
    if (segments.length) onPartial(segments.join('。'), '')
  }

  return {
    start() {
      stream = rec.createStream()
      finished = false
      lastPartial = ''
      segments = []
      currentSeg = ''
      pcmChunks.length = 0
      breakSilenceMs = 0
      hadVoice = false
    },
    pushAudio(buf) {
      if (!stream || finished) return
      pcmChunks.push(Buffer.from(buf))
      stream.acceptWaveform({ sampleRate: 16000, samples: int16ToFloat32(buf) })
      drain()
      // 静音分段：能量低于阈值累计时长，达到静音窗口就把当前半句钉死为已定稿句。
      const rms = rmsOf(buf)
      if (rms < SILENCE_RMS) {
        if (hadVoice) breakSilenceMs += (buf.length / 2 / 16000) * 1000
      } else {
        hadVoice = true
        breakSilenceMs = 0
      }
      if (hadVoice && breakSilenceMs >= SILENCE_BREAK_MS) {
        breakSilenceMs = 0
        hadVoice = false
        commitSilenceBreak()
      }
    },
    finish() {
      if (!stream || finished) return
      finished = true
      dumpAudio()
      stream.inputFinished()
      drain()
      // final 优化：整段无标点原文过一遍标点模型，输出带逗号/句号/问号的定稿
      const allSegs = currentSeg ? [...segments, currentSeg] : segments
      const raw = allSegs.join(' ')
      const punct = getPunctuator()
      let finalText = lastPartial
      if (punct && raw) {
        try {
          const startAt = Date.now()
          finalText = punct.addPunct(raw)
          log('asr', `标点优化完成，耗时 ${Date.now() - startAt}ms`)
        } catch (error) {
          log('asr', '标点处理失败，使用无标点结果:', error.message)
        }
      }
      onFinal(finalText)
      stream = null
    },
  }
}

module.exports = { createSession }
