// 验证 bailian 连接预热：第一次会话结束预建连接，第二次会话复用（不再发 run-task）。
// 带历史上下文（context）的会话不复用预热，仍走建连。不需要真实百炼凭证，不出外网。
// 用法: node scripts/test-bailian-prewarm.js
const { WebSocketServer } = require('ws')

const PORT = 18779
const FAKE_KEY = 'sk-fake-bailian-key'
process.env.PHVOICE_ASR_PROVIDER = 'bailian'
process.env.BAILIAN_API_KEY = FAKE_KEY
process.env.BAILIAN_MODEL = 'qwen-audio-3.0-asr-flash-streaming'
process.env.BAILIAN_GATEWAY = `ws://127.0.0.1:${PORT}/api-ws/v1/inference`

const asr = require('../src/infrastructure/asr')

let runTaskCount = 0
let finishTaskCount = 0

const wss = new WebSocketServer({ port: PORT, path: '/api-ws/v1/inference' })
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const msg = JSON.parse(data.toString())
    const action = msg.header?.action
    const taskId = msg.header?.task_id
    if (action === 'run-task') {
      runTaskCount++
      ws.send(JSON.stringify({ header: { task_id: taskId, event: 'task-started', attributes: {} }, payload: {} }))
    } else if (action === 'finish-task') {
      finishTaskCount++
      ws.send(JSON.stringify({ header: { task_id: taskId, event: 'result-generated', attributes: {} }, payload: { output: { sentence: { text: '一句。', sentence_end: true, heartbeat: false } } } }))
      ws.send(JSON.stringify({ header: { task_id: taskId, event: 'task-finished', attributes: {} }, payload: {} }))
    }
  })
})

let finalCount = 0
function makeSession(context) {
  return asr.createSession({
    context: context || [],
    onPartial: () => {},
    onFinal: () => { finalCount++ },
  })
}
function runSession(context) {
  return new Promise((resolve) => {
    const s = makeSession(context)
    s.start()
    s.pushAudio(Buffer.alloc(3200))
    setTimeout(() => { s.finish(); resolve() }, 60)
  })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 会话1：无 context → 建连（run-task #1），结束后预热（run-task #2）
  await runSession([])
  await wait(400)
  const afterFirst = runTaskCount
  console.log(`会话1（无 context）后 run-task=${afterFirst}（预期 2 = 1 会话 + 1 预热）`)

  // 会话2：无 context → 应复用预热，期间只新增「预热」一个 run-task
  await runSession([])
  await wait(400)
  const afterSecond = runTaskCount
  console.log(`会话2（无 context）后 run-task=${afterSecond}（预期 3 = 复用 + 仅新增预热）`)

  // 会话3：带 context → 不复用预热，走建连（+1）。已有的预热连接（pw3）未被消费、仍在空转，
  // settleFinal 里 `if (prewarm) return` 不重建，故只新增「建连」这一条 run-task。
  await runSession([{ role: 'user', content: [{ type: 'input_text', text: '上文' }] }])
  await wait(400)
  const afterThird = runTaskCount
  console.log(`会话3（带 context）后 run-task=${afterThird}（预期 4 = 仅建连，预热保留给下次）`)

  const ok = afterFirst === 2 && afterSecond === 3 && afterThird === 4 && finalCount === 3
  console.log(`\nfinalCount=${finalCount}  ${ok ? '✓ 预热生命周期正确' : '✗ 断言失败'}`)
  wss.close()
  process.exit(ok ? 0 : 1)
}

setTimeout(() => { console.error('[fail] 超时'); process.exit(1) }, 10000).unref()
main()
