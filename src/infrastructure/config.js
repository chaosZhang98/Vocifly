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
  // 服务端口。默认 http 设置页 9898 / https 语音页+WS 9899；可在控制面板「配置 → 常规」改，改后自动重启生效。
  // 也可用 VOCIFLY_HTTP_PORT / VOCIFLY_HTTPS_PORT 环境变量临时覆盖（优先级最高）。
  httpPort: 9898,
  httpsPort: 9899,
  // 是否开机自启（macOS 登录项）。默认关闭；可在菜单栏下拉菜单勾选，或在此文件手动改。
  launchAtLogin: false,
  // 上屏/回车/删除相关延时（毫秒），可在 config.json 或控制面板调整
  pasteDelayMs: 150,          // 上屏后到模拟回车
  attachPasteDelayMs: 1000,   // compose 多附件：每个附件上屏后到下一个之间的稳定等待（防剪贴板覆盖，目标 App 读取慢时可调大）
  // 键盘输入（compose）通路参数：手机端「键盘」模式下文字/附件上屏的行为。
  // 走手机自带输入法，不占用 Vocifly 录音通道。
  compose: {
    fileMaxCount: 5,        // 一次最多携带的附件数（手机端硬编码上限的服务端可调版）
    fileMaxMB: 20,          // 单个附件大小上限（MB）
    sendAfterPaste: false,  // 上屏完成后是否自动模拟回车发送（compose 场景；抬头键盘模式下常为打字后按下发送）
  },
  // 新手机默认的输入模式：cloud(云端) / local(本地) / keyboard(键盘)。
  // 云端/本地会同步 asr.provider；键盘仅作默认 UI 状态（仍保留默认引擎用于语音）。各手机可在对话页覆盖。
  // 注意：此值不设默认，由 loadConfig 按当前 provider 推导，避免与持久化的默认引擎失配。
  sendDelayMs: 120,           // 模拟回车前等待目标应用处理粘贴
  deleteDelayMs: 120,         // 回退/删除前等待
  clipboardRestoreDelayMs: 300, // 还原剪贴板延迟
  // 触控板（手机端鼠标模拟）灵敏度与边缘/轨迹常量，可在控制面板「配置 → 触控板」调整
  trackpad: {
    sensitivity: 1.8,       // 光标（mouseMove）相对位移放大倍率
    scrollSensitivity: 1.8, // 滚轮（mouseScroll：双指滚动 + 红点摇杆）相对位移放大倍率
    edgeZonePx: 18,   // 边缘检测像素带宽度
    edgeDwellMs: 250, // 贴边到进入连续移动的等待时间
    edgeStepMs: 30,   // 边缘连续移动的步进间隔
    edgeSpeed: 12,    // 边缘连续移动步进量
    trailMs: 1000,    // 手写笔刷轨迹保留时长
    // 小红点摇杆滚轮（骨架①）：A 板面精细 / B 红点加速，二者都在「滚轮模式」内
    tpEnabled: true,      // 总开关：关掉则整块红点摇杆失效，回到普通光标
    tpLongPressMs: 800,   // 长按红点激活滚轮模式的时长（ms）
    tpDeadZoneR: 14,      // 圆心死区半径：距圆心小于此不滚（px）
    tpMaxRadius: 64,      // 满速半径：距圆心超此=满速（px）
    tpMaxSpeed: 12,       // 满速时每次 move 的滚动增量
    tpIdleMs: 5000,       // 滚轮模式无操作超时退出（ms）
    rollGain: 1.0,        // A 板面精细滚动位移倍率（1=严格跟手）
    tpAccel: 1.0,         // 橡皮筋加速度：手指拖离心越远滚动越快（0=无加速纯跟手）
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
  // 优化模板：手机端「优化」按钮的模板库。每条 = 名称 + 提示词；
  // defaultId 指定「未手动选择时」用的默认模板。模型全局统一（optimize.model，默认 qwen-turbo），
  // 不逐条配置。手机端只收到 {id, name} 列表（提示词正文不出 Mac），选择后按 promptId 回传。
  // 复用百炼 API Key（asr.bailian.apiKey），不计费。
  optimize: {
    model: 'qwen-turbo',
    defaultId: 'polish',
    pool: [
      {
        id: 'polish',
        name: '纠错润色',
        prompt: '你是中文语音转写文本的优化助手。用户的输入来自语音识别（ASR）转写，可能因口音、同音字、近音字而产生识别错误。请按顺序处理：①先通读全文，逐句判断语义是否通顺，凡是语义不通、明显属于识别错误的词句（同音字、近音字、口音误转），优先按上下文与常理修正为最可能正确的原意；②在语义正确的基础上补全标点、让语句通顺自然，必要时微调语气使其更得体。不要扩写、不添加原意之外的信息，也不臆测转写之外的内容。只输出优化后的文本本身，不要任何解释、前缀、引号或 Markdown 代码块。',
      },
      {
        id: 'formal',
        name: '正式化',
        prompt: '你是中文文本的正式化助手。请把用户输入的文本改写成更正式、得体的书面表达：用词规范、句式完整、语气克制有礼。保留原意，不添加新信息。只输出改写后的文本本身，不要任何解释、前缀、引号或 Markdown 代码块。',
      },
      {
        id: 'casual',
        name: '口语化',
        prompt: '你是中文文本的口语化助手。请把用户输入的文本改写成更自然、口语化的表达：贴近日常说话习惯、轻松亲切，可适度使用语气词。保留原意，不添加新信息。只输出改写后的文本本身，不要任何解释、前缀、引号或 Markdown 代码块。',
      },
    ],
  },
  asr: {
    provider: 'sherpa',
    // 离线 sherpa（SenseVoice 非实时）分段参数：静音分段 + 长句强制分段兜底
    sherpa: {
      silenceBreakMs: 450,   // 停顿超过此值钉死一句（ms）
      silenceRms: 28,        // 能量阈值，低于判静音（0~32767）
      voiceRms: 300,         // 判定为「真实语音」的能量阈值（0~32767）；低于此视为底噪，不识别（防静音幻觉）
      maxSegmentMs: 12000,   // 不停顿也强制切段（ms），避免长时间无回显
    },
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
  // 首次运行（文件不存在）返回 null，由调用方决定是否生成默认配置；
  // 只有"存在但解析失败"才返回 {}（不覆盖损坏文件，避免误清用户数据）。
  if (!fs.existsSync(CONFIG_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    log('config', `config.json 解析失败，使用默认配置: ${error.message}`)
    return {}
  }
}

// 写回 config.json（0600：含 API key，仅本人可读写）。统一入口，避免到处 mkdir/writeFile。
function writeConfigFile(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })
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
  const fileConfig = loadFileConfig()
  const config = merge(DEFAULTS, fileConfig)

  // 打包态首次运行：本地还没有 config.json，自动生成一份默认配置，
  // 让用户打开控制面板即可看到/修改，也避免"没有配置文件却在跑"的困惑。
  if (paths.isPackaged && fileConfig === null) {
    writeConfigFile(config)
    log('config', `未找到 config.json，已生成默认配置: provider=${config.asr.provider}`)
  }

  // 环境变量优先级最高，方便临时切换/调试
  if (process.env.VOCIFLY_ASR_PROVIDER) config.asr.provider = process.env.VOCIFLY_ASR_PROVIDER
  if (process.env.DASHSCOPE_API_KEY) config.asr.bailian.apiKey = process.env.DASHSCOPE_API_KEY
  if (process.env.BAILIAN_API_KEY) config.asr.bailian.apiKey = process.env.BAILIAN_API_KEY
  if (process.env.BAILIAN_MODEL) config.asr.bailian.model = process.env.BAILIAN_MODEL
  if (process.env.BAILIAN_WORKSPACE_ID) config.asr.bailian.workspaceId = process.env.BAILIAN_WORKSPACE_ID
  if (process.env.BAILIAN_GATEWAY) config.asr.bailian.gateway = process.env.BAILIAN_GATEWAY

  // 默认输入模式与默认引擎对齐：config.json 之前无 defaultInputMode 字段时按 provider 推导初值；
  // 若已存在但为 cloud/local 且与 provider 失配（历史版本只改 provider 未同步 defaultInputMode），
  // 也在此拉齐。keyboard 是纯 UI 默认（保留现有引擎），不参与对齐。
  if (config.defaultInputMode === undefined) {
    config.defaultInputMode = config.asr.provider === 'bailian' ? 'cloud' : 'local'
  } else if (config.defaultInputMode === 'cloud' || config.defaultInputMode === 'local') {
    const expected = config.asr.provider === 'bailian' ? 'cloud' : 'local'
    if (config.defaultInputMode !== expected) config.defaultInputMode = expected
  }

  return config
}

const config = loadConfig()

// apiKey 不出进程边界的掩码占位。getSettings 返回它、saveSettings 识别它（用户未改时跳过），
// 两者必须一致，才能既不在 /api/settings 响应里泄露真实 key，又不被掩码覆盖掉真实凭证。
const API_KEY_MASK = '••••••••••••••••'

function getSettings() {
  const bailian = { ...config.asr.bailian }
  if (bailian.apiKey) bailian.apiKey = API_KEY_MASK
  return {
    sendRules: { ...config.sendRules },
    deleteRules: { ...config.deleteRules },
    asr: {
      provider: config.asr.provider,
      sherpa: { ...config.asr.sherpa },
      bailian,
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
    compose: { ...config.compose },
    optimize: {
      model: config.optimize.model,
      defaultId: config.optimize.defaultId,
      pool: (config.optimize.pool || []).map((e) => ({ id: e.id, name: e.name, prompt: e.prompt })),
    },
    defaultInputMode: config.defaultInputMode,
    launchAtLogin: config.launchAtLogin,
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
  }
}

// 设置页保存配置：写回 config.json 并同步更新内存中的 config，
// 下一次 createSession 就会读到新 provider/凭证，不需要重启服务。
function saveSettings(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('settings 必须是 JSON 对象')
  }
  const asrPatch = { ...(next.asr || {}) }

  // 保存时若 apiKey 仍是 GET 返回的掩码占位（用户没改），从补丁中去掉，避免用掩码覆盖真实 key。
  if (asrPatch.bailian?.apiKey === API_KEY_MASK) {
    asrPatch.bailian = { ...asrPatch.bailian }
    delete asrPatch.bailian.apiKey
  }

  // 开机自启（macOS 登录项）：布尔值，写回 config.json；实际注册由主进程调用 setLoginItemSettings 完成。
  if (next.launchAtLogin !== undefined) {
    config.launchAtLogin = !!next.launchAtLogin
  }

  // 端口：http / https，1~65535 整数。改后由主进程重启服务生效（见 /api/settings 保存逻辑）。
  if (next.httpPort !== undefined || next.httpsPort !== undefined) {
    for (const key of ['httpPort', 'httpsPort']) {
      if (next[key] === undefined) continue
      const p = Number(next[key])
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`${key} 必须是 1~65535 的整数`)
      config[key] = p
    }
  }

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

  // 离线 sherpa 分段参数校验（静音/语音门限、分段时长）。先与现有配置合并再校验，
  // 因为补丁可能是部分字段（只改 voiceRms 时其余键缺失，Number(undefined)=NaN 会误判）。
  if (asrPatch.sherpa) {
    const s = { ...config.asr.sherpa, ...asrPatch.sherpa }
    for (const key of ['silenceBreakMs', 'silenceRms', 'voiceRms', 'maxSegmentMs']) {
      const v = Number(s[key])
      if (!Number.isFinite(v) || v < 0) throw new Error(`sherpa.${key} 必须是大于等于 0 的数字`)
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

  // 触控板配置（sensitivity / edgeZonePx / edgeDwellMs / edgeStepMs / edgeSpeed / trailMs / 红点摇杆）
  const tpPatch = { ...(next.trackpad || {}) }
  if (Object.keys(tpPatch).length) {
    const tpKeys = ['sensitivity', 'scrollSensitivity', 'edgeZonePx', 'edgeDwellMs', 'edgeStepMs', 'edgeSpeed', 'trailMs',
      'tpLongPressMs', 'tpDeadZoneR', 'tpMaxRadius', 'tpMaxSpeed', 'tpIdleMs', 'rollGain', 'tpAccel']
    for (const key of tpKeys) {
      if (tpPatch[key] === undefined) continue
      const v = Number(tpPatch[key])
      if (!Number.isFinite(v) || v < 0) throw new Error(`${key} 必须是大于等于 0 的数字`)
      config.trackpad[key] = v
    }
    // tpEnabled 是布尔开关，单独处理
    if (tpPatch.tpEnabled !== undefined) config.trackpad.tpEnabled = !!tpPatch.tpEnabled
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

  // 键盘输入（compose）参数：附件数量/大小上限、上屏后是否自动回车
  const composePatch = { ...(next.compose || {}) }
  if (Object.keys(composePatch).length) {
    if (composePatch.fileMaxCount !== undefined) {
      const v = Number(composePatch.fileMaxCount)
      if (!Number.isInteger(v) || v < 1 || v > 20) throw new Error('compose.fileMaxCount 必须是 1~20 的整数')
      config.compose.fileMaxCount = v
    }
    if (composePatch.fileMaxMB !== undefined) {
      const v = Number(composePatch.fileMaxMB)
      if (!Number.isFinite(v) || v <= 0 || v > 100) throw new Error('compose.fileMaxMB 必须是大于 0、不超过 100 的数字')
      config.compose.fileMaxMB = v
    }
    if (composePatch.sendAfterPaste !== undefined) config.compose.sendAfterPaste = !!composePatch.sendAfterPaste
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

  // provider 单独变更（未走 defaultInputMode 流程）时同步默认输入模式，避免二者失配。
  // 场景：预算自动降级、托盘「识别服务」切换、控制面板「识别服务」直接改 provider —— 都只动 asr.provider。
  // keyboard 是纯 UI 默认（保留现有引擎），provider 变更不覆盖它；若本次显式带了 defaultInputMode，则走下方分支。
  if (asrPatch.provider !== undefined && next.defaultInputMode === undefined && config.defaultInputMode !== 'keyboard') {
    config.defaultInputMode = config.asr.provider === 'bailian' ? 'cloud' : 'local'
  }

  // 默认输入模式：cloud / local / keyboard。云端同步 provider=bailian，本地同步 provider=sherpa；
  // 键盘保持现有 provider（仍保留默认引擎用于语音），仅改变新手机的默认 UI 状态。
  // 放在 merge 之后，确保 defaultInputMode 对 provider 的改写不被 asrPatch 的旧 provider 覆盖。
  if (next.defaultInputMode !== undefined) {
    const m = next.defaultInputMode
    if (!['cloud', 'local', 'keyboard'].includes(m)) throw new Error('defaultInputMode 必须是 cloud / local / keyboard')
    config.defaultInputMode = m
    if (m === 'cloud') config.asr.provider = 'bailian'
    else if (m === 'local') config.asr.provider = 'sherpa'
  }

  // 优化模板：model / pool / defaultId。手机端「优化」按钮用的模板库。
  // 池与默认模板针对「新池」一并校验：defaultId 必须落在最终池里，池清空则拒绝。
  const optPatch = next.optimize
  if (optPatch !== undefined) {
    if (!optPatch || typeof optPatch !== 'object' || Array.isArray(optPatch)) {
      throw new Error('optimize 必须是对象')
    }
    if (optPatch.model !== undefined) {
      const m = String(optPatch.model).trim()
      if (!m) throw new Error('优化模型不能为空')
      config.optimize.model = m
    }
    const nextPool = optPatch.pool !== undefined ? optPatch.pool : config.optimize.pool
    if (!Array.isArray(nextPool)) throw new Error('优化模板必须是数组')
    const seen = new Set()
    const pool = nextPool.map((entry) => {
      const id = String(entry?.id || '').trim()
      const name = String(entry?.name || '').trim()
      const prompt = String(entry?.prompt || '').trim()
      if (!id || !name || !prompt) throw new Error('优化模板每条需填写名称与提示词')
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error(`优化模板标识非法: ${id}（仅字母数字 _ -，≤32 字符）`)
      if (seen.has(id)) throw new Error(`优化模板标识重复: ${id}`)
      seen.add(id)
      if (name.length > 20) throw new Error(`优化模板名称不超过 20 字（当前「${name}」）`)
      if (prompt.length > 2000) throw new Error('优化模板提示词不超过 2000 字')
      return { id, name, prompt }
    })
    if (pool.length === 0) throw new Error('优化模板至少保留一条')
    if (pool.length > 20) throw new Error('优化模板最多 20 条')
    const defaultId = optPatch.defaultId !== undefined ? String(optPatch.defaultId).trim() : config.optimize.defaultId
    if (!pool.some((e) => e.id === defaultId)) throw new Error('优化模板默认条目不在池内')
    config.optimize.pool = pool
    config.optimize.defaultId = defaultId
  }

  writeConfigFile(config)
  log('config', `配置已保存: provider=${config.asr.provider} inputMode=${config.defaultInputMode}`)
  return getSettings()
}

// 手机端 VAD 的「有效值」：本地(sherpa)非实时识别靠服务端静音分段，需要完整音频上行，
// 故本地模式强制关闭手机端 VAD（否则静音被手机端掐掉，分段失效）；云端(bailian)按音频时长计费，
// 保留 VAD 省费。仅用于发给手机的 WS settings 消息，控制面板 getSettings() 仍返回用户原始 vad 设置。
// provider 可选：手机端「云端/本地」模式按连接覆盖 provider 时，VAD 须按该连接实际引擎计算。
function effectiveVad(provider) {
  const p = provider || config.asr.provider
  return { ...config.vad, enabled: config.vad.enabled && p === 'bailian' }
}

module.exports = { config, getSettings, saveSettings, effectiveVad }
