// bailian provider —— 阿里云百炼实时语音识别（DashScope WebSocket）
// 用 sk- 开头的百炼 API Key 直接鉴权，不需要 AccessKey/AppKey。
// 默认模型 qwen-audio-3.0-asr-flash-streaming，16kHz Int16 PCM 二进制帧上行。
// 生产容错（参照官方文档）：
//   - heartbeat=true 保持长连接
//   - 连接/启动阶段失败自动重试 3 次（500ms/1s/2s）
//   - 未检测到有效语音（NO_VALID_AUDIO_ERROR）按空结果收尾，不上屏错误文本
//   - 记录建连+启动、整段识别耗时，便于定位延迟
const crypto = require('crypto')
const WebSocket = require('ws')
const { log } = require('../logger')

// finish-task 后等 task-finished 的最长时间
const COMPLETED_TIMEOUT_MS = 5000
// 连接 + task-started 的最长等待时间（覆盖弱网）
const START_TIMEOUT_MS = 8000
const MAX_CONNECT_RETRIES = 3
const RETRY_DELAYS_MS = [500, 1000, 2000]
const TRANSIENT_ERROR_CODES = new Set(['RATE_LIMIT', 'SERVER_BUSY', 'TIMEOUT', 'INTERNAL_SERVER_ERROR'])

function uuid() {
  return crypto.randomUUID()
}

function missingConfigError(cfg) {
  return cfg.apiKey ? null : '百炼 API Key 未填写（设置页或 config.json 的 asr.bailian.apiKey）'
}

function buildParameters(cfg, model) {
  // 静音多久才判定一句话结束（ms）。官方默认 1300，范围 [200, 6000]。
  // 之前写死 700 过小，导致用户正常停顿（如“下面是。”+“我的。”）被过早切成碎句。
  // 1300 又太宽松：顺畅说话时整段只在 finish 才定稿，前端"已定稿/半句"分层全程收不到非空 finalized。
  // 折中取 900（介于 700 的碎 与 1300 的不分 之间），配合应用层"暂定稿预览"兜住仍无短停顿的场景。
  // 可用配置 asr.bailian.maxSentenceSilence 覆盖，缺省 900。
  const cfgSilence = Number(cfg.maxSentenceSilence)
  const maxSentenceSilence = Number.isFinite(cfgSilence) && cfgSilence >= 200 && cfgSilence <= 6000
    ? cfgSilence
    : 900
  const isQwenOrFun = model.startsWith('qwen') || model.startsWith('fun-asr')
  const params = {
    format: 'pcm',
    sample_rate: 16000,
    // Qwen-ASR-Flash / Fun-ASR 开启语义标点，让识别结果携带更自然的句读；
    // Paraformer 用下方 punctuation_prediction_enabled，不适用本字段。
    semantic_punctuation_enabled: isQwenOrFun,
    max_sentence_silence: maxSentenceSilence,
    heartbeat: true,
  }
  // 这几个字段是 Paraformer 专有，Qwen-ASR-Flash 不识别，按模型区分发送
  if (model.startsWith('paraformer')) {
    params.disfluency_removal_enabled = false
    params.punctuation_prediction_enabled = true
    params.inverse_text_normalization_enabled = true
  }
  // 即时热词：仅 Qwen-ASR-Flash / Fun-ASR 支持，提升人名、专有名词准确率
  const vocabulary = cfg.vocabulary
  if (
    vocabulary &&
    Object.keys(vocabulary).length &&
    (model.startsWith('qwen') || model.startsWith('fun-asr'))
  ) {
    params.vocabulary = vocabulary
  }
  return params
}

// ---- 连接预热 ----
// 会话结束后预建下一个连接，下次说话直接复用，跳过「建连 + task-started」等待（云端首字延迟大头）。
// 约束：DashScope 在 task-started 后约 23s 无音频会超时，故预热连接 TTL 取 15s，超时主动回收；
// 且 context（历史上下文）只能在 run-task 时传入、之后不能补，故带 context 的会话不复用预热连接。
const PREWARM_TTL_MS = 15000
let prewarm = null // { ws, taskId, started, timer, model }

function buildHeaders(cfg) {
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, 'user-agent': 'phvoice/0.1.0' }
  if (cfg.workspaceId) headers['X-DashScope-WorkSpace'] = cfg.workspaceId
  return headers
}

// 构造 run-task 帧（预热与真实会话共用，避免 payload 两处写漂移）
function runTaskFrame(taskId, cfg, model, context) {
  const input = Array.isArray(context) && context.length ? { context } : {}
  return {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio', task: 'asr', function: 'recognition', model,
      parameters: buildParameters(cfg, model), input,
    },
  }
}

function dropPrewarm() {
  if (!prewarm) return
  if (prewarm.timer) clearTimeout(prewarm.timer)
  try { prewarm.ws?.terminate() } catch {}
  prewarm = null
}

function startPrewarm(cfg) {
  if (prewarm) return
  const model = cfg.model || 'qwen-audio-3.0-asr-flash-streaming'
  const pw = { ws: null, taskId: uuid(), started: false, timer: null, model }
  prewarm = pw
  let ws
  try {
    ws = new WebSocket(cfg.gateway, { headers: buildHeaders(cfg), perMessageDeflate: false })
  } catch {
    dropPrewarm()
    return
  }
  pw.ws = ws
  ws.on('message', (data, isBinary) => {
    if (prewarm !== pw || isBinary) return // 已被接手/回收则不处理
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    const event = msg?.header?.event
    if (event === 'task-started') {
      pw.started = true
      log('asr:bailian', '预热连接已就绪（下次说话直接复用）')
      pw.timer = setTimeout(() => { log('asr:bailian', '预热连接超时未使用，回收'); dropPrewarm() }, PREWARM_TTL_MS)
    } else if (event === 'task-failed' || event === 'task-finished') {
      dropPrewarm()
    }
  })
  ws.on('error', () => { if (prewarm === pw) dropPrewarm() })
  ws.on('close', () => { if (prewarm === pw) dropPrewarm() })
  ws.once('open', () => {
    if (prewarm !== pw) return
    try { ws.send(JSON.stringify(runTaskFrame(pw.taskId, cfg, model, null))) }
    catch { dropPrewarm() }
  })
}

// 接手已就绪的预热连接：改绑会话的消息/错误/关闭处理器，返回连接句柄；无可用预热则返回 null。
function takePrewarm(cfg, onMessage, onError, onClose) {
  if (!prewarm || !prewarm.started) return null
  const model = cfg.model || 'qwen-audio-3.0-asr-flash-streaming'
  if (prewarm.model !== model) { dropPrewarm(); return null } // 模型变了，预热参数不匹配
  const pw = prewarm
  prewarm = null
  if (pw.timer) clearTimeout(pw.timer)
  pw.ws.on('message', onMessage)
  pw.ws.on('error', onError)
  pw.ws.on('close', onClose)
  return { ws: pw.ws, taskId: pw.taskId }
}

function isNoValidAudio(failed) {
  return !!(failed && failed.includes('NO_VALID_AUDIO_ERROR'))
}

function isTransientFailure(msg) {
  const code = msg?.header?.error_code || ''
  const message = msg?.header?.error_message || ''
  return TRANSIENT_ERROR_CODES.has(code) || /timeout|temporarily|busy|overload/i.test(message)
}

function createSession({ onPartial, onFinal, config, context }) {
  const cfg = config.asr.bailian
  const configError = missingConfigError(cfg)
  if (configError) {
    log('asr:bailian', configError)
    return {
      start() {},
      pushAudio() {},
      finish() {
        onFinal(`[错误] ${configError}`)
      },
    }
  }

  let ws = null
  let taskId = null
  let started = false // 收到 task-started，可以上行音频
  let finished = false
  let failed = null // task-failed / 连接错误原因
  let stopRequested = false
  let connectAttempt = 0
  let retryScheduled = false
  let reconnectTimer = null
  let stopTimer = null
  let completedTimer = null
  let sessionStartAt = 0
  const pendingAudio = [] // 连接建立前收到的音频块
  const segments = [] // 已定稿句（sentence_end=true，自带标点）
  let currentPartial = ''
  let lastEmitted = ''

  // 实时回显分层：finalized=已定稿句拼接（确定不再变），partial=当前半句（还会被修正）。
  // 两者分开传递，前端才能用不同视觉层级展示，避免「整段字变来变去」让用户忐忑。
  function emit(finalized, partial) {
    const full = finalized + partial
    if (full && full !== lastEmitted) {
      lastEmitted = full
      onPartial(finalized, partial)
    }
  }

  function finalText() {
    const parts = [...segments]
    // 按停止键时如果还有半句没等到 sentence_end，用最后的 partial 兜底
    if (currentPartial) parts.push(currentPartial)
    return parts.join('')
  }

  function clearTimers() {
    for (const timer of [reconnectTimer, stopTimer, completedTimer]) {
      if (timer) clearTimeout(timer)
    }
    reconnectTimer = null
    stopTimer = null
    completedTimer = null
  }

  function settleFinal() {
    if (finished) return
    finished = true
    clearTimers()
    if (failed) {
      if (isNoValidAudio(failed) && !finalText()) {
        log('asr:bailian', '未检测到有效语音，按空结果收尾')
        onFinal('')
      } else {
        onFinal(`[错误] 百炼识别失败: ${failed}`)
      }
    } else {
      const cost = Date.now() - sessionStartAt
      log('asr:bailian', `识别完成，整段耗时 ${cost}ms，共 ${segments.length} 句`)
      onFinal(finalText())
    }
    if (ws) {
      try { ws.terminate() } catch {}
      ws = null
    }
    startPrewarm(cfg) // 会话结束预建下一连接，下次说话跳过建连
  }

  function sendControl(action) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const model = cfg.model || 'qwen-audio-3.0-asr-flash-streaming'
    ws.send(JSON.stringify(
      action === 'run-task'
        ? runTaskFrame(taskId, cfg, model, context)
        : { header: { action, task_id: taskId, streaming: 'duplex' }, payload: { input: {} } },
    ))
  }

  function requestStop() {
    if (finished) return false
    if (!(started && ws && ws.readyState === WebSocket.OPEN)) return false
    sendControl('finish-task')
    if (completedTimer) clearTimeout(completedTimer)
    completedTimer = setTimeout(() => {
      if (!finished) {
        log('asr:bailian', `等待 task-finished 超时（${COMPLETED_TIMEOUT_MS}ms），按当前结果收尾`)
        settleFinal()
      }
    }, COMPLETED_TIMEOUT_MS)
    return true
  }

  function flushPendingAudio() {
    while (pendingAudio.length && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(pendingAudio.shift(), { binary: true })
    }
  }

  // 只在 task-started 之前重试：此时音频还都留在 pendingAudio 里，
  // 重连后可原样补发，不会丢语音；任务开始后再断线就按当前结果收尾，避免重复识别。
  function scheduleRetry(reason) {
    if (finished || started || stopRequested || retryScheduled || connectAttempt >= MAX_CONNECT_RETRIES) {
      return false
    }
    connectAttempt += 1
    retryScheduled = true
    const delay = RETRY_DELAYS_MS[connectAttempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
    log('asr:bailian', `连接失败（${reason}），${delay}ms 后进行第 ${connectAttempt}/${MAX_CONNECT_RETRIES} 次重试`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      retryScheduled = false
      connect()
    }, delay)
    return true
  }

  function handleMessage(data, isBinary) {
    if (isBinary) return
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    const event = msg?.header?.event

    if (event === 'task-started') {
      started = true
      log('asr:bailian', `识别已开始（建连+启动耗时 ${Date.now() - sessionStartAt}ms）`)
      flushPendingAudio()
      if (stopRequested) requestStop()
    } else if (event === 'result-generated') {
      const sentence = msg?.payload?.output?.sentence
      if (!sentence || sentence.heartbeat) return
      const text = (sentence.text || '').trim()
      if (sentence.sentence_end) {
        if (text) {
          segments.push(text)
          log('asr:bailian', `定稿句 #${segments.length}: ${text}`)
        }
        currentPartial = ''
        emit(segments.join(''), '')
      } else {
        currentPartial = text
        emit(segments.join(''), text)
      }
    } else if (event === 'task-finished') {
      log('asr:bailian', `识别完成，整段耗时 ${Date.now() - sessionStartAt}ms`)
      settleFinal()
    } else if (event === 'task-failed') {
      const detail = `${msg?.header?.error_code || 'UNKNOWN'}: ${msg?.header?.error_message || '未知错误'}`
      log('asr:bailian', 'task-failed:', detail)
      if (!started && isTransientFailure(msg) && scheduleRetry(detail)) return
      failed = detail
      settleFinal()
    }
  }

  function onWsError(error) {
    log('asr:bailian', '连接错误:', error.message)
    if (retryScheduled || scheduleRetry(error.message)) return
    failed = failed || error.message
    settleFinal()
  }

  function onWsClose() {
    if (finished || retryScheduled) return
    if (scheduleRetry('连接被关闭')) return
    log('asr:bailian', '连接被关闭，按当前结果收尾')
    settleFinal()
  }

  async function connect() {
    try {
      taskId = uuid()
      ws = new WebSocket(cfg.gateway, { headers: buildHeaders(cfg), perMessageDeflate: false })
      ws.on('message', handleMessage)
      ws.on('error', onWsError)
      ws.on('close', onWsClose)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      sendControl('run-task')
    } catch (error) {
      log('asr:bailian', '启动失败:', error.message)
      if (retryScheduled || scheduleRetry(error.message)) return
      failed = failed || error.message
      settleFinal()
    }
  }

  return {
    start() {
      segments.length = 0
      currentPartial = ''
      lastEmitted = ''
      pendingAudio.length = 0
      connectAttempt = 0
      retryScheduled = false
      finished = false
      failed = null
      started = false
      stopRequested = false
      sessionStartAt = Date.now()
      // 无历史上下文时优先复用预热连接（已 task-started），跳过建连；带 context 则需重建（context 只能在 run-task 时传）
      const useContext = Array.isArray(context) && context.length > 0
      const taken = !useContext ? takePrewarm(cfg, handleMessage, onWsError, onWsClose) : null
      if (taken) {
        ws = taken.ws
        taskId = taken.taskId
        started = true
        log('asr:bailian', '复用预热连接，跳过建连')
      } else {
        connect()
      }
    },
    pushAudio(buf) {
      if (finished || failed) return
      if (started && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(buf, { binary: true })
      } else {
        pendingAudio.push(Buffer.from(buf))
      }
    },
    finish() {
      if (finished) return
      stopRequested = true
      if (requestStop()) return
      // 还没连上就被按停：等一个启动窗口，云端一开就开始收尾
      stopTimer = setTimeout(() => {
        stopTimer = null
        if (finished) return
        if (requestStop()) return
        settleFinal()
      }, START_TIMEOUT_MS)
    },
  }
}

module.exports = { createSession }
