// bailian-optimize —— 文字优化（百炼 qwen 在线大模型，OpenAI 兼容 chat/completions）。
//
// 与实时 ASR 无关：这是「事后手动」的识别文本后处理，走一次普通 Chat → Response，
// 无流式、无会话状态。复用 ASR 的百炼 API Key（DASHSCOPE_API_KEY / BAILIAN_API_KEY），
// 不计费（预算只覆盖 ASR 的音频秒数）。OpenAI 兼容端点：
//   https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
//
// 实现 OptimizePort 契约：optimize(text, opts) -> Promise<string>，失败 reject。
// 提示词来自「优化模板」config.optimize.pool（每条 = 名称 + 提示词），解析优先级：
//   显式 opts.prompt 直接覆盖 > opts.promptId 命中池 > config.optimize.defaultId 命中池
//   > 池首条 > 内置 DEFAULT_PROMPT 兜底。
// 模型默认 qwen-turbo，可用 config.optimize.model（或旧字段 config.asr.bailian.optimizeModel）覆盖。

const { log } = require('../logger')
const { config } = require('../config')

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const DEFAULT_MODEL = 'qwen-turbo'

// 默认优化指令：优先「识别纠错（语义通顺优先）」，再补标点/通顺/语气，不扩写、不改原意。
// 关键约束：只输出文本本身，禁止解释/引号/markdown，否则优化结果会带壳直接上屏。
const DEFAULT_PROMPT =
  '你是中文语音转写文本的优化助手。用户的输入来自语音识别（ASR）转写，可能因口音、同音字、近音字而产生识别错误。请按顺序处理：' +
  '①先通读全文，逐句判断语义是否通顺，凡是语义不通、明显属于识别错误的词句（同音字、近音字、口音误转），优先按上下文与常理修正为最可能正确的原意；' +
  '②在语义正确的基础上补全标点、让语句通顺自然，必要时微调语气使其更得体。' +
  '不要扩写、不添加原意之外的信息，也不臆测转写之外的内容。只输出优化后的文本本身，不要任何解释、前缀、引号或 Markdown 代码块。'

// 从优化模板解析提示词（见文件头注释的优先级）。
function resolvePrompt(opts) {
  if (opts && opts.prompt) return opts.prompt
  const pool = Array.isArray(config?.optimize?.pool) ? config.optimize.pool : []
  const wantId = (opts && opts.promptId) || config?.optimize?.defaultId
  if (wantId) {
    const hit = pool.find((e) => e && e.id === wantId)
    if (hit && hit.prompt) return hit.prompt
  }
  const first = pool.find((e) => e && e.prompt)
  if (first) return first.prompt
  return DEFAULT_PROMPT
}

async function optimize(text, opts = {}) {
  const cfg = config?.asr?.bailian || {}
  const apiKey = cfg.apiKey || ''
  if (!apiKey) {
    throw new Error('百炼 API Key 未填写（设置页或 config.json 的 asr.bailian.apiKey）')
  }
  const model = opts.model || config?.optimize?.model || cfg.optimizeModel || DEFAULT_MODEL
  const systemPrompt = resolvePrompt(opts)

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'user-agent': 'vocifly/0.1.0',
  }
  if (cfg.workspaceId) headers['X-DashScope-WorkSpace'] = cfg.workspaceId

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    stream: false,
    temperature: 0.2,
  }

  const startedAt = Date.now()
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`优化请求失败 HTTP ${resp.status}: ${detail.slice(0, 200)}`)
  }

  const data = await resp.json()
  const out = data?.choices?.[0]?.message?.content
  if (typeof out !== 'string' || !out.trim()) {
    throw new Error('优化返回为空（模型无有效输出）')
  }
  const optimized = out.trim()
  log('optimize', `优化完成，耗时 ${Date.now() - startedAt}ms，${text.length} → ${optimized.length} 字`)
  return optimized
}

module.exports = { optimize }
