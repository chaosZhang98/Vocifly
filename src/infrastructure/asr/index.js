// ASR provider 工厂：按 config.asr.provider 选择识别服务（Infrastructure 层）。
// 所有 provider 对外暴露同一接口（满足 AsrPort 契约），server.js 只依赖这里的 createSession：
//   createSession({ onPartial(finalized, partial), onFinal(text) }) -> { start(), pushAudio(buf), finish() }
//   onPartial(finalized, partial)：实时回显分层（已定稿句 + 正在听的半句）
const { config } = require('../config')
const { log } = require('../logger')

const PROVIDERS = {
  sherpa: () => require('./sherpa'),
  bailian: () => require('./bailian'),
}

function getProvider() {
  const name = config.asr.provider
  const loader = PROVIDERS[name]
  if (!loader) {
    const supported = Object.keys(PROVIDERS).join(' / ')
    log('asr', `未知 provider "${name}"，可用: ${supported}；本次回退到 sherpa`)
    return { name: 'sherpa', module: PROVIDERS.sherpa() }
  }
  return { name, module: loader() }
}

function createSession(callbacks) {
  const { name, module } = getProvider()
  log('asr', `本次识别使用 provider: ${name}`)
  return module.createSession({ ...callbacks, config })
}

module.exports = { createSession }
