// 本地模拟百炼 DashScope 网关，验证 bailian provider 的协议状态机：
// 握手鉴权 + run-task -> 音频上行 -> result-generated -> finish-task -> task-finished。
// 不需要真实百炼凭证，也不出外网。用法: node scripts/test-bailian-mock.js
const { WebSocketServer } = require('ws')

const PORT = 18778
const FAKE_KEY = 'sk-fake-bailian-key'
process.env.PHVOICE_ASR_PROVIDER = 'bailian'
process.env.BAILIAN_API_KEY = FAKE_KEY
process.env.BAILIAN_MODEL = 'qwen-audio-3.0-asr-flash-streaming'
process.env.BAILIAN_GATEWAY = `ws://127.0.0.1:${PORT}/api-ws/v1/inference`

const asr = require('../src/infrastructure/asr')

function send(ws, event, extra) {
  ws.send(JSON.stringify({
    header: { task_id: 'mock-task', event, attributes: {} },
    payload: extra || {},
  }))
}

const wss = new WebSocketServer({ port: PORT, path: '/api-ws/v1/inference' })
let receivedAuth = null
let receivedAudio = 0
let receivedModel = null
let receivedContext = null
let sawPartial = false

wss.on('connection', (ws, req) => {
  receivedAuth = req?.headers?.authorization || ''
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      receivedAudio += data.length
      if (!sawPartial && receivedAudio > 3200) {
        sawPartial = true
        send(ws, 'result-generated', {
          output: { sentence: { text: '你好', sentence_end: false, heartbeat: false } },
          usage: null,
        })
      }
      return
    }
    const msg = JSON.parse(data.toString())
    const action = msg.header?.action
    if (action === 'run-task') {
      receivedModel = msg.payload?.model
      receivedContext = msg.payload?.input?.context || null
      send(ws, 'task-started', {})
    } else if (action === 'finish-task') {
      send(ws, 'result-generated', {
        output: { sentence: { text: '你好，世界。', sentence_end: true, heartbeat: false } },
        usage: { duration: 1 },
      })
      send(ws, 'task-finished', { output: {}, usage: null })
    }
  })
})

setTimeout(() => {
  console.error('[fail] 模拟测试超时')
  process.exit(1)
}, 15000).unref()

const session = asr.createSession({
  context: [{ role: 'user', content: [{ type: 'input_text', text: '昨天提到了 PhVoice' }] }],
  onPartial: (text) => console.log(`[partial] ${text}`),
  onFinal: (text) => {
    const ok =
      text.includes('你好，世界。') &&
      receivedAuth === `Bearer ${FAKE_KEY}` &&
      receivedModel === 'qwen-audio-3.0-asr-flash-streaming' &&
      Array.isArray(receivedContext) &&
      receivedContext.length === 1 &&
      receivedContext[0].content[0].text === '昨天提到了 PhVoice' &&
      receivedAudio > 0 &&
      sawPartial
    console.log(`[final]   ${text}`)
    console.log(`[check] auth=${receivedAuth === `Bearer ${FAKE_KEY}` ? 'OK' : 'FAIL'}  model=${receivedModel}  context=${receivedContext ? 'OK' : 'FAIL'}  audio=${receivedAudio} bytes  partial=${sawPartial}`)
    wss.close()
    process.exit(ok ? 0 : 1)
  },
})

session.start()
const chunk = Buffer.alloc(3200) // 0.1s 16kHz Int16 静音
for (let i = 0; i < 5; i++) session.pushAudio(chunk)
setTimeout(() => {
  session.finish()
}, 400)
