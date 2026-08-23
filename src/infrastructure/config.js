// 统一配置加载：config.json（本地真实凭证，不进 git）+ 环境变量覆盖 + 默认值
// ASR provider 可插拔，目前支持：
//   sherpa  离线本地识别
//   bailian 阿里云百炼实时语音识别（sk- API Key，推荐）
const fs = require('fs')
const path = require('path')
const { log } = require('./logger')
const paths = require('./paths')

const CONFIG_FILE = paths.configFile

const DEFAULTS = {
  sendRules: {},
  deleteRules: {},
  // 上屏/回车/删除相关延时（毫秒），可在 config.json 或控制面板调整
  pasteDelayMs: 150,          // 上屏后到模拟回车
  attachPasteDelayMs: 1000,   // compose 多附件：每个附件上屏后到下一个之间的稳定等待（防剪贴板覆盖，目标 App 读取慢时可调大）
  sendDelayMs: 120,           // 模拟回车前等待目标应用处理粘贴
  deleteDelayMs: 120,         // 回退/删除前等待
  clipboardRestoreDelayMs: 300, // 还原剪贴板延迟
  // 触控板（手机端鼠标模拟）灵敏度与边缘/轨迹常量，可在控制面板「配置 → 触控板」调整
  trackpad: {
    sensitivity: 1.8, // 服务端相对位移放大倍率（也影响滚轮）
    edgeZonePx: 18,   // 边缘检测像素带宽度
    edgeDwellMs: 250, // 贴边到进入连续移动的等待时间
    edgeStepMs: 30,   // 边缘连续移动的步进间隔
    edgeSpeed: 12,    // 边缘连续移动步进量
    trailMs: 1000,    // 手写笔刷轨迹保留时长
  },
  // 静音门限（VAD）：手机端 AudioWorklet 按帧能量判断是否真的在说话。
  // 静音帧不再上行，既省流量、也省费用（百炼按音频时长计费）。
  // 阈值越大越“严格”（少误发、可能切掉轻音）；holdMs 是语音结束后保留的拖尾，
  // 避免把句尾轻声截断。设为 enabled=false 则退回全量上行（不省费）。
  vad: {
    enabled: true,
    threshold: 0.006,  // RMS 能量门限（0~1，越大越严格）
    holdMs: 260,       // 语音结束后的保持时长（毫秒），用于保留句尾轻声
  },
  // 月度费用预算（元）。monthlyYuan=0 表示不限额；超过 alertPct% 时在控制面板概览提示，
  // 达到 100% 时明确告警。只做提醒，不中断识别。
  budget: {
    monthlyYuan: 0,
    alertPct: 80,
  },
  asr: {
    provider: 'sherpa',
    bailian: {
      apiKey: '',
      model: 'qwen-audio-3.0-asr-flash-streaming',
      workspaceId: '',
      gateway: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      vocabulary: {},
      contextEnabled: false,
      // 静音多少毫秒才判定一句话结束。官方默认 1300，范围 [200, 6000]。
      // 设得越小越“碎”，适合逐句确认；设得越大越连贯，适合长句口述。
      maxSentenceSilence: 1300,
      // 单价（元/秒）：Qwen-ASR-Flash 流式按音频时长计费，北京地域约 0.00033 元/秒。
      // 若使用专属工作区网关，价格可能不同，可在此调整。
      pricePerSecond: 0.00033,
    },
  },
}

function loadFileConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    log('config', `config.json 解析失败，使用默认配置: ${error.message}`)
    return {}
  }
}

function merge(base, extra) {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = merge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function loadConfig() {
  const config = merge(DEFAULTS, loadFileConfig())

  // 环境变量优先级最高，方便临时切换/调试
  if (process.env.PHVOICE_ASR_PROVIDER) config.asr.provider = process.env.PHVOICE_ASR_PROVIDER
  if (process.env.DASHSCOPE_API_KEY) config.asr.bailian.apiKey = process.env.DASHSCOPE_API_KEY
  if (process.env.BAILIAN_API_KEY) config.asr.bailian.apiKey = process.env.BAILIAN_API_KEY
  if (process.env.BAILIAN_MODEL) config.asr.bailian.model = process.env.BAILIAN_MODEL
  if (process.env.BAILIAN_WORKSPACE_ID) config.asr.bailian.workspaceId = process.env.BAILIAN_WORKSPACE_ID
  if (process.env.BAILIAN_GATEWAY) config.asr.bailian.gateway = process.env.BAILIAN_GATEWAY

  return config
}

const config = loadConfig()

function getSettings() {
  return {
    sendRules: { ...config.sendRules },
    deleteRules: { ...config.deleteRules },
    asr: {
      provider: config.asr.provider,
      bailian: { ...config.asr.bailian },
    },
    timing: {
      pasteDelayMs: config.pasteDelayMs,
      attachPasteDelayMs: config.attachPasteDelayMs,
      sendDelayMs: config.sendDelayMs,
      deleteDelayMs: config.deleteDelayMs,
      clipboardRestoreDelayMs: config.clipboardRestoreDelayMs,
    },
    trackpad: { ...config.trackpad },
    vad: { ...config.vad },
    budget: { ...config.budget },
  }
}

// 设置页保存配置：写回 config.json 并同步更新内存中的 config，
// 下一次 createSession 就会读到新 provider/凭证，不需要重启服务。
function saveSettings(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('settings 必须是 JSON 对象')
  }
  const asrPatch = next.asr || {}

  if (next.sendRules !== undefined) {
    if (!next.sendRules || typeof next.sendRules !== 'object' || Array.isArray(next.sendRules)) {
      throw new Error('sendRules 必须是对象')
    }
    const allowed = new Set(['enter', 'cmd-enter', 'ctrl-enter', 'none'])
    for (const [key, value] of Object.entries(next.sendRules)) {
      if (!allowed.has(value)) {
        throw new Error(`不支持的发送规则: ${value}（支持 enter / cmd-enter / ctrl-enter / none）`)
      }
    }
    config.sendRules = { ...next.sendRules }
  }

  if (next.deleteRules !== undefined) {
    if (!next.deleteRules || typeof next.deleteRules !== 'object' || Array.isArray(next.deleteRules)) {
      throw new Error('deleteRules 必须是对象')
    }
    const allowed = new Set(['undo', 'backspace', 'none'])
    for (const [key, value] of Object.entries(next.deleteRules)) {
      if (!allowed.has(value)) {
        throw new Error(`不支持的删除方式: ${value}（支持 undo / backspace / none）`)
      }
    }
    config.deleteRules = { ...next.deleteRules }
  }

  const provider = asrPatch.provider || config.asr.provider
  if (!['sherpa', 'bailian'].includes(provider)) {
    throw new Error(`不支持的 ASR 类型: ${provider}`)
  }

  if (provider === 'bailian') {
    const bailian = { ...config.asr.bailian, ...(asrPatch.bailian || {}) }
    if (!bailian.apiKey) throw new Error('百炼 API Key 未填写')
    if (bailian.pricePerSecond != null) {
      const price = Number(bailian.pricePerSecond)
      if (!Number.isFinite(price) || price < 0) throw new Error('单价必须是大于等于 0 的数字（元/秒）')
      bailian.pricePerSecond = price
    }
  }

  // 延时配置：可在 next.timing 子对象或顶层同名键中指定
  const timingPatch = { ...(next.timing || {}) }
  for (const key of ['pasteDelayMs', 'attachPasteDelayMs', 'sendDelayMs', 'deleteDelayMs', 'clipboardRestoreDelayMs']) {
    if (next[key] !== undefined) timingPatch[key] = next[key]
  }
  if (Object.keys(timingPatch).length) {
    for (const [key, value] of Object.entries(timingPatch)) {
      const v = Number(value)
      if (!Number.isFinite(v) || v < 0 || v > 5000) {
        throw new Error(`${key} 必须是 0~5000 的毫秒数`)
      }
      config[key] = v
    }
  }

  // 触控板配置（sensitivity / edgeZonePx / edgeDwellMs / edgeStepMs / edgeSpeed / trailMs）
  const tpPatch = { ...(next.trackpad || {}) }
  if (Object.keys(tpPatch).length) {
    const tpKeys = ['sensitivity', 'edgeZonePx', 'edgeDwellMs', 'edgeStepMs', 'edgeSpeed', 'trailMs']
    for (const key of tpKeys) {
      if (tpPatch[key] === undefined) continue
      const v = Number(tpPatch[key])
      if (!Number.isFinite(v) || v < 0) throw new Error(`${key} 必须是大于等于 0 的数字`)
      config.trackpad[key] = v
    }
  }

  // 月度费用预算
  const budgetPatch = { ...(next.budget || {}) }
  if (Object.keys(budgetPatch).length) {
    if (budgetPatch.monthlyYuan !== undefined) {
      const v = Number(budgetPatch.monthlyYuan)
      if (!Number.isFinite(v) || v < 0) throw new Error('月度预算必须是大于等于 0 的数字（0 表示不限额）')
      config.budget.monthlyYuan = v
    }
    if (budgetPatch.alertPct !== undefined) {
      const v = Number(budgetPatch.alertPct)
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('告警百分比必须是 0~100 的数字')
      config.budget.alertPct = v
    }
  }

    // VAD 配置
  const vadPatch = { ...(next.vad || {}) }
  if (Object.keys(vadPatch).length) {
    if (vadPatch.enabled !== undefined) config.vad.enabled = !!vadPatch.enabled
    if (vadPatch.threshold !== undefined) {
      const v = Number(vadPatch.threshold)
      if (!Number.isFinite(v) || v <= 0 || v > 1) throw new Error('VAD 阈值必须是 0~1 之间的数字')
      config.vad.threshold = v
    }
    if (vadPatch.holdMs !== undefined) {
      const v = Number(vadPatch.holdMs)
      if (!Number.isFinite(v) || v < 0 || v > 2000) throw new Error('VAD holdMs 必须是 0~2000 毫秒')
      config.vad.holdMs = v
    }
  }

    config.asr = merge(config.asr, asrPatch)
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  log('config', `配置已保存: provider=${config.asr.provider}`)
  return getSettings()
}

module.exports = { config, getSettings, saveSettings }
