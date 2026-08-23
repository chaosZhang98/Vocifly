// 应用用例层 · 会话服务 —— 洋葱架构的 Application 层。
//
// 职责：承载一次 WebSocket 连接内的「识别会话状态机 + 上屏 / 回显 / 回退 / 重上屏」业务用例。
// 它见到的只有 Port（asr / paste / usage）+ 一个抽象的 emit（发信回调），
// 不 import 任何具体实现（bailian / sherpa / mac-paster / pbcopy）。这些由
// Interface 层（server.js 组合根）通过构造参数注入，符合「依赖向内、注入实现」。
//
// 关键设计：
//   - 实例化时机 = 每条 WebSocket 连接建立时（因为 session/history/pasteHistory 是每连接一份的）。
//   - emit(payload)：由接口层绑定到该连接的 ws.send(JSON.stringify(payload))。
//   - 并发防串：sessionSeq 作废旧会话迟到的 final/partial，避免「旧会话错误覆盖新会话成功」。

const CONTEXT_MAX_TURNS = 5
const CONTEXT_MAX_CHARS = 400
const HISTORY_MAX = 20
const PARTIAL_THROTTLE_MS = 100 // partial 推送节流窗口（毫秒），避免 ASR 每个结果都高频刷屏

// 纯函数：把上下文历史构造成 ASR 多轮上下文（部分 provider 支持）。
// 历史里把「[错误]」开头的兜底文本过滤掉，限制轮数与总字符数。
function buildAsrContext(history) {
  const items = []
  let total = 0
  for (const raw of history.slice(-CONTEXT_MAX_TURNS)) {
    const text = String(raw).trim()
    if (!text || text.startsWith('[错误]')) continue
    if (total + text.length > CONTEXT_MAX_CHARS) break
    items.push({ role: 'user', content: [{ type: 'input_text', text }] })
    total += text.length
  }
  return items
}

class SessionService {
  /**
   * @param {Object} deps             依赖注入（由 Interface 层提供，杜绝业务窥探具体实现）
   * @param {Object} deps.asr         AsrPort：{ createSession({onPartial, onFinal, context, config}) -> {start, pushAudio, finish} }
   * @param {Object} deps.paster      PastePort：{ paste, pasteImage, pasteFile, send, deleteStep, switchWindow, activateApp, ... }
   * @param {Object} deps.usage       usagePort：{ recordUsage, patchLastText, checkBudgetAndMaybeDowngrade, getAsrPricePerSecond }
   * @param {Object} deps.config      只读配置引用（读 provider / bailian.contextEnabled / attachPasteDelayMs 等）
   * @param {boolean} deps.enablePaste  是否上屏（测试模式可关）
   * @param {(history: string[]) => Object[]} deps.contextBuilder  ASR 上下文构造（默认 buildAsrContext）
   * @param {(scope: string, ...args) => void} deps.log  日志
   * @param {(payload: Object) => void} deps.emit  发送 JSON 到当前连接
   * @param {string|number} deps.connId  连接 id（日志 / deviceId）
   */
  constructor(deps) {
    const { asr, paster, usage, config, enablePaste, contextBuilder, log, emit, connId } = deps
    this.asr = asr
    this.paster = paster
    this.usage = usage
    this.config = config
    this.enablePaste = enablePaste
    this.log = log
    this.emit = emit
    this.connId = connId
    this.contextBuilder = contextBuilder || buildAsrContext
    this.stallMs = deps.stallMs || 1000 // 半句停顿超过此值就锁定为“暂定稿”（前端以正常色显示），default 1s

    // —— 每连接一套的会话状态 ——
    this.session = null
    this.sessionSeq = 0      // 每次 start 递增，作废旧会话迟到的结果
    this.audioBytes = 0
    this.sessionStartAt = 0
    this.history = []
    this.discardResult = false
    this.pasteHistory = []   // 多步回退：每次上屏压一层，删除时弹出一层
    this.pendingUsage = null
    this.lastPartialSentAt = 0
    this.pendingFinalized = ''
    this.pendingPartial = ''
    this.partialTimer = null
    // —— 暂定稿兜底（C）——
    // 顺畅说话时 ASR 往往不给定稿句(sentence_end)，前端永远只看到灰的半句。
    // 半句停顿超过 stallMs 就把它锁成“暂定稿”，作为 finalized 前缀 + 成段下发，前端会立刻以正常色显示。
    this.stableText = ''     // 已锁定为暂定稿的中前文，展示层 finalized 前缀
    this.lastFinalized = ''  // 最近一次下发的 finalized（含 stable 前缀）
    this.lastPartial = ''    // 最近一次下发的半句
    this.stallTimer = null
  }

  // 推送一块 PCM（Int16 16kHz mono）
  pushAudio(buf) {
    this.audioBytes += buf.length
    this.session?.pushAudio(buf)
  }

  // partial 节流：100ms 窗口内最多推送一次，且只发最新文本。
  flushPartial() {
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null }
    if (!this.pendingFinalized && !this.pendingPartial) return
    // 顺畅说话时 ASR 的 finalized 多为空，partial 则是“整段累积”文本。
    // 若已锁定过暂定稿(stableText)，新的整段 partial 必以它开头：把 stableText 提为 finalized、
    // 剩余部分作半句增量，前端不会重复显示“已定稿”和“半句”。
    let finalized = this.pendingFinalized
    let partial = this.pendingPartial
    if (this.stableText && partial.startsWith(this.stableText)) {
      finalized = this.stableText
      partial = partial.slice(this.stableText.length)
    }
    this.pendingFinalized = ''
    this.pendingPartial = ''
    this.emit({ type: 'partial', finalized, partial })
    // 过程日志：落「已定稿(finalized) / 半句(partial)」分层，便于排查交互流程
    this.log('ws', `#${this.connId} partial → finalized=${JSON.stringify(finalized)} partial=${JSON.stringify(partial)}`)
    this.lastPartialSentAt = Date.now()
    this.lastFinalized = finalized
    this.lastPartial = partial
    // 半句停顿超阈值 → 锁定为暂定稿；一旦有新半句又来就重置，不会误锁。
    clearTimeout(this.stallTimer)
    this.stallTimer = partial ? setTimeout(() => this.lockStable(), this.stallMs) : null
  }

  // 半句长时间无更新（无 sentence_end 的顺畅说话）：把当前的「已定稿+半句」整体锁为暂定稿下发。
  // 前端据此用正常色渲染，用户能看出“这段是当前上屏候选”；若继续说话会再变回半句灰。
  lockStable() {
    if (!this.lastPartial) return
    const full = this.lastFinalized + this.lastPartial
    this.stableText = full
    this.lastFinalized = full
    this.lastPartial = ''
    this.emit({ type: 'partial', finalized: full, partial: '', stable: true })
    this.log('ws', `#${this.connId} 暂定稿锁定 → finalized=${JSON.stringify(full)} partial=""`)
  }

  queuePartial(finalized, partial) {
    this.pendingFinalized = finalized
    this.pendingPartial = partial
    const now = Date.now()
    const elapsed = now - this.lastPartialSentAt
    if (elapsed >= PARTIAL_THROTTLE_MS) {
      this.flushPartial()
    } else if (!this.partialTimer) {
      const delay = PARTIAL_THROTTLE_MS - elapsed
      this.partialTimer = setTimeout(() => this.flushPartial(), delay)
    }
  }

  // 用例：开始识别（前端 start）。带并发防串 + 回显分层 + final 上屏/历史/用量。
  start() {
    this.audioBytes = 0
    this.sessionStartAt = Date.now()
    this.discardResult = false
    this.pendingUsage = null
    this.stableText = ''
    this.lastFinalized = ''
    this.lastPartial = ''
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null }
    // 防御并发：重复 start 时先作废旧会话，避免「旧会话超时错误覆盖新会话成功」。
    if (this.session) {
      this.sessionSeq += 1
      try { this.session.finish() } catch {}
      this.session = null
      this.log('ws', `#${this.connId} 检测到重复 start，已结束上一次识别会话`)
    }
    const mySeq = ++this.sessionSeq
    this.log('ws', `#${this.connId} 开始一次识别`)
    const useContext = this.config.asr.provider === 'bailian' && this.config.asr.bailian.contextEnabled !== false
    this.session = this.asr.createSession({
      context: useContext ? this.contextBuilder(this.history) : [],
      onPartial: (finalized, partial) => {
        if (mySeq !== this.sessionSeq) return
        this.queuePartial(finalized || '', partial || '')
      },
      onFinal: (text) => {
        if (mySeq !== this.sessionSeq) {
          this.log('ws', `#${this.connId} 丢弃过期会话结果（已有新会话）`)
          return
        }
        if (this.discardResult) {
          this.log('ws', `#${this.connId} 用户取消本次识别，丢弃结果`)
          return
        }
        if (!text) {
          this.log('ws', `#${this.connId} 空结果（如未检测到语音），跳过上屏`)
          return
        }
        this.log('ws', `#${this.connId} final (${text.length}字): ${text}`)
        if (text.startsWith('[错误]')) {
          // ASR 失败/超时/缺 Key 的兜底文本：只 toast 给前端，不上屏、不入历史、不可发送。
          // 否则这段报错会被当成「用户说的话」粘贴进聊天框，甚至点发送发出去。
          this.emit({ type: 'toast', text, target: 'enter' })
          return
        }
        if (this.pendingUsage) this.usage.patchLastText(text)
        this.emit({ type: 'final', text })
        this.history.push(text)
        if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX)
        this.pasteHistory.push(text)
        if (this.pasteHistory.length > HISTORY_MAX) this.pasteHistory.shift()
        if (this.enablePaste) {
          this.paster.paste(text).then((ok) => {
            if (!ok) this.emit({ type: 'toast', text: '上屏失败：请检查 Mac 的「辅助功能」权限', target: 'enter' })
          })
        } else this.log('paste', '测试模式，跳过上屏:', text)
      },
    })
    this.session.start()
  }

  // 用例：结束识别，记录用量并结束会话。
  stop() {
    const seconds = (this.audioBytes / 2 / 16000).toFixed(1)
    this.log('ws', `#${this.connId} 结束识别，共收到音频 ${(this.audioBytes / 1024).toFixed(0)}KB（约 ${seconds}s），耗时 ${Date.now() - this.sessionStartAt}ms`)
    if (this.audioBytes > 0) {
      this.pendingUsage = this.usage.recordUsage({ seconds: this.audioBytes / 2 / 16000, text: '', pricePerSecond: this.usage.getAsrPricePerSecond(), deviceId: this.connId })
      this.log('usage', `#${this.connId} 记录 1 次识别：${(this.audioBytes / 2 / 16000).toFixed(1)}s（计费 ${this.pendingUsage.billableSeconds}s），约 ¥${this.pendingUsage.costYuan.toFixed(5)}`)
      this.usage.checkBudgetAndMaybeDowngrade()
    }
    this.session?.finish()
    this.session = null
  }

  // 用例：取消识别，丢弃结果并按取消计费。
  cancel() {
    this.discardResult = true
    if (this.audioBytes > 0) {
      this.pendingUsage = this.usage.recordUsage({ seconds: this.audioBytes / 2 / 16000, text: '（用户取消）', pricePerSecond: this.usage.getAsrPricePerSecond(), deviceId: this.connId })
      this.log('usage', `#${this.connId} 记录 1 次取消识别：${(this.audioBytes / 2 / 16000).toFixed(1)}s（计费 ${this.pendingUsage.billableSeconds}s），约 ¥${this.pendingUsage.costYuan.toFixed(5)}`)
      this.usage.checkBudgetAndMaybeDowngrade()
    }
    this.session?.finish()
    this.session = null
  }

  // 用例：手机端 compose —— 文本 + 附件（图片/文件）原子上屏，粘贴后自动回车。
  compose(msg) {
    const composeText = typeof msg.text === 'string' ? msg.text : ''
    const MAX_ATTACH = 5
    const MAX_B64 = 28 * 1024 * 1024 // 约 20MB 文件的 base64
    const attachments = (Array.isArray(msg.attachments) ? msg.attachments : [])
      .filter((a) => a && typeof a.base64 === 'string' && a.base64.length <= MAX_B64)
      .slice(0, MAX_ATTACH)
    if (!composeText.trim() && attachments.length === 0) {
      this.emit({ type: 'toast', text: '输入内容为空', target: 'enter' })
      return
    }
    if (composeText.trim()) {
      this.pasteHistory.push(composeText)
      if (this.pasteHistory.length > HISTORY_MAX) this.pasteHistory.shift()
    }
    for (const a of attachments) {
      const label = a.kind === 'image' ? '[图片]' : `[文件] ${a.name || ''}`
      this.pasteHistory.push(label)
      if (this.pasteHistory.length > HISTORY_MAX) this.pasteHistory.shift()
    }
    this.log('ws', `#${this.connId} 用户输入: ${composeText || '(仅附件)'}${attachments.length ? ` + ${attachments.length}个附件` : ''}`)
    const doCompose = async () => {
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
      try {
        if (this.enablePaste) {
          // 多附件必须逐条确认（helper ACK）+ 稳定等待，否则后一张图会覆盖前一张的剪贴板
          const settle = this.config.attachPasteDelayMs || 450
          if (composeText) {
            await this.paster.paste(composeText)
            await sleepMs(settle)
          }
          for (let i = 0; i < attachments.length; i++) {
            const a = attachments[i]
            const fp = String(a.base64 || '').slice(0, 24)
            this.log('ws', `#${this.connId} compose 附件#${i + 1} ${a.kind} ${a.name || ''} base64len=${(a.base64 || '').length} head=${fp}`)
            if (a.kind === 'image') await this.paster.pasteImage(a.base64, a.name)
            else await this.paster.pasteFile(a.name || 'file', a.base64)
            await sleepMs(settle)
          }
          // 仅粘贴到光标处，不模拟回车发送（发送由用户手动在 PC 上触发）
        } else {
          this.log('paste', '测试模式，跳过 compose 上屏')
        }
      } catch (e) {
        this.log('ws', `#${this.connId} compose 上屏失败:`, e.message)
      }
    }
    doCompose()
    this.emit({ type: 'sent', source: 'compose' })
  }

  // 用例：用户点击发送 —— 对最后一次上屏内容模拟回车。
  send() {
    const lastText = this.pasteHistory[this.pasteHistory.length - 1]
    if (lastText) {
      this.log('ws', `#${this.connId} 用户点击发送: ${lastText}`)
      this.paster.send()
      this.pasteHistory = []
      this.emit({ type: 'sent' })
    } else {
      this.emit({ type: 'toast', text: '先点击说话', target: 'enter' })
    }
  }

  // 用例：重新上屏 —— 首次上屏贴错位置后，用户把光标移到正确位置，重新粘贴最后一次结果。
  repaste(msg) {
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    if (!text) {
      this.emit({ type: 'toast', text: '没有可重新上屏的内容', target: 'enter' })
      return
    }
    this.log('ws', `#${this.connId} 重新上屏: ${text}`)
    this.pasteHistory.push(text)
    if (this.pasteHistory.length > HISTORY_MAX) this.pasteHistory.shift()
    if (this.enablePaste) {
      // 重新上屏只负责「重新 Cmd+V」，不激活、不改焦点——用户需先手动把光标放到目标输入框。
      this.paster.paste(text).then((ok) => {
        this.emit(ok
          ? { type: 'repasted' }
          : { type: 'toast', text: '重新上屏失败：请检查 Mac 的「辅助功能」权限', target: 'enter' })
      })
    } else {
      this.log('paste', '测试模式，跳过重新上屏:', text)
      this.emit({ type: 'repasted' })
    }
  }

  // 用例：删除上次上屏（回退一步）。
  removeLast() {
    if (this.pasteHistory.length) {
      const lastText = this.pasteHistory.pop()
      this.log('ws', `#${this.connId} 用户回退一步: ${lastText}`)
      this.paster.deleteStep(lastText)
      this.emit({ type: 'deleted', remaining: this.pasteHistory.length })
    } else {
      this.emit({ type: 'toast', text: '没有可回退的内容', target: 'delete' })
    }
  }

  // WebSocket 连接关闭时释放资源：清掉 partial 节流定时器，结束仍在识别的会话。
  dispose() {
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null }
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null }
    try { this.session?.finish() } catch {}
    this.session = null
  }
}

module.exports = { SessionService, buildAsrContext }
