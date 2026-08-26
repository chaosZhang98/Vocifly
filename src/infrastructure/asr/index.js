// ASR provider 工厂：按 config.asr.provider 选择识别服务（Infrastructure 层）。
// 所有 provider 对外暴露同一接口（满足 AsrPort 契约），server.js 只依赖这里的 createSession：
//   createSession({ onPartial(finalized, partial), onFinal(text) }) -> { start(), pushAudio(buf), finish() }
//   onPartial(finalized, partial)：实时回显分层（已定稿句 + 正在听的半句）
// callbacks.provider 可传入每连接的 provider 覆盖（手机端「云端/本地」模式仅本手机生效），
// 优先于全局 config.asr.provider。
const { config } = require('../config')
const { log } = require('../logger')

const PROVIDERS = {
  sherpa: () => require('./sherpa'),
  bailian: () => require('./bailian'),
}

function getProvider(override) {
  const name = override || config.asr.provider
  const loader = PROVIDERS[name]
  if (!loader) {
    const supported = Object.keys(PROVIDERS).join(' / ')
    log('asr', `未知 provider "${name}"，可用: ${supported}；本次回退到 sherpa`)
    return { name: 'sherpa', module: PROVIDERS.sherpa() }
  }
  return { name, module: loader() }
}

function createSession(callbacks) {
  const { provider, ...rest } = callbacks || {}
  const { name, module } = getProvider(provider)
  log('asr', `本次识别使用 provider: ${name}${provider ? '（本连接覆盖）' : ''}`)
  return module.createSession({ ...rest, config })
}

module.exports = { createSession }
