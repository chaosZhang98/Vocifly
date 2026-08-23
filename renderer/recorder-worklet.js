// AudioWorklet：把麦克风流降采样为 16kHz Int16 PCM 并回传主线程。
//
// 关键点：直接“抽点”降采样（48k→16k 每 3 个取 1 个）会把 >8kHz 的高频语音
// 混叠回 0~8kHz，导致识别率明显下降。这里先做 windowed-sinc 低通（抗混叠）
// 再抽取，保证 16kHz 上行音频干净、无混叠失真。
//
// 若 AudioContext 采样率本已是 16kHz（ratio≈1），则透传，不额外滤波。
const OUTPUT_RATE = 16000
const CUTOFF_HZ = 7040 // 低于 8kHz 输出 Nyquist 的折中截止频率

function hamming(n, N) {
  return 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1))
}

// 构造 windowed-sinc 低通 FIR，归一化 DC 增益为 1。
function makeSinc(ratio, taps) {
  const fsIn = OUTPUT_RATE * ratio
  const fcNorm = CUTOFF_HZ / fsIn // 0..0.5
  const alpha = (taps - 1) / 2
  const coeffs = new Float32Array(taps)
  let sum = 0
  for (let n = 0; n < taps; n++) {
    const x = n - alpha
    let h
    if (x === 0) h = 2 * fcNorm
    else h = 2 * fcNorm * Math.sin(Math.PI * 2 * fcNorm * x) / (Math.PI * 2 * fcNorm * x)
    h *= hamming(n, taps)
    coeffs[n] = h
    sum += h
  }
  for (let n = 0; n < taps; n++) coeffs[n] /= sum
  return coeffs
}

// 帧能量（RMS，0~1）：用于静音门限 VAD，判断这一帧是否真的在说话。
function frameRms(arr) {
  if (!arr || arr.length === 0) return 0
  let sum = 0
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i]
  return Math.sqrt(sum / arr.length) / 32768
}

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / OUTPUT_RATE
    this.filtering = this.ratio > 1.001
    // VAD：enabled / threshold（RMS 门限）/ holdMs（语音结束后的拖尾）。
    // 由主线程通过 port.postMessage({ type:'vad', ... }) 下发配置。
    this.vad = { enabled: true, threshold: 0.006, holdMs: 260 }
    this.vadRemainMs = 0
    this.port.onmessage = (e) => {
      const m = e.data || {}
      if (m.type === 'vad') {
        if (m.enabled !== undefined) this.vad.enabled = !!m.enabled
        if (m.threshold !== undefined) this.vad.threshold = Number(m.threshold) || 0.006
        if (m.holdMs !== undefined) this.vad.holdMs = Number(m.holdMs) || 260
        this.vadRemainMs = 0
      }
    }
    if (this.filtering) {
      // 按抽取倍数选择滤波器阶数：3x -> 19 阶，2x -> 15 阶，封顶 33 阶
      this.taps = Math.max(15, Math.min(33, Math.round(this.ratio * 6) | 1))
      this.coeffs = makeSinc(this.ratio, this.taps)
      this.buf = new Float32Array(this.taps) // 延迟线（环形）
      this.bufIdx = 0
      this.sampleCounter = 0 // 已处理的输入样本位置（绝对计数）
      this.nextOutAt = 0     // 下一输出对应输入样本的位置
    }
  }

  // 静音门限：启用 VAD 时，只有能量超过门限的帧（及其后 holdMs 拖尾）才上行。
  // 静音帧直接丢弃，省流量也省费用；disabled 时全量透传。
  shouldSend(pcm) {
    if (!this.vad.enabled) return true
    const frameMs = (pcm.length / OUTPUT_RATE) * 1000
    const energy = frameRms(pcm)
    if (energy >= this.vad.threshold) {
      this.vadRemainMs = Math.max(this.vadRemainMs, this.vad.holdMs)
    } else {
      this.vadRemainMs = Math.max(0, this.vadRemainMs - frameMs)
    }
    return this.vadRemainMs > 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const src = input[0]

    // 已经是 16kHz：直接/放大量转 Int16，跳过滤波与抽取
    if (!this.filtering) {
      const out = new Int16Array(src.length)
      for (let i = 0; i < src.length; i++) {
        const s = Math.max(-1, Math.min(1, src[i]))
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      if (!this.shouldSend(out)) return true
      this.port.postMessage(out.buffer, [out.buffer])
      return true
    }

    // 抗混叠低通 + 抽取
    const out = []
    const { taps, coeffs, buf } = this
    for (let i = 0; i < src.length; i++) {
      buf[this.bufIdx] = src[i]
      this.bufIdx = (this.bufIdx + 1) % taps
      let acc = 0
      let idx = this.bufIdx // 环形缓冲中最旧的样本
      for (let k = 0; k < taps; k++) {
        acc += buf[idx] * coeffs[k]
        idx = (idx + 1) % taps
      }
      if (this.sampleCounter >= this.nextOutAt) {
        out.push(acc)
        this.nextOutAt += this.ratio
      }
      this.sampleCounter++
    }

    if (out.length) {
      const pcm = new Int16Array(out.length)
      for (let i = 0; i < out.length; i++) {
        const s = Math.max(-1, Math.min(1, out[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      if (!this.shouldSend(pcm)) return true
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}

registerProcessor('pcm-worklet', PCMWorklet)
