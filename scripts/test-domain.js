// 领域核心纯逻辑 + SessionService 状态机 —— ad-hoc 单元测试（无框架）。
// 覆盖：SendRuleService 规则解析、RecognitionResult 值对象、
//       buildAsrContext 上下文构造、SessionService 关键用例（模式切换/上屏/并发防串/回退）。
// 用法: node scripts/test-domain.js
const assert = require('assert')

const { resolveSendRule, resolveDeleteRule, keyToOsaScript } = require('../src/domain/service/SendRuleService')
const { RecognitionResult } = require('../src/domain/model/RecognitionResult')
const { SessionService, buildAsrContext } = require('../src/application/SessionService')

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message) }
}
function section(title) { console.log('\n' + title) }

// ---- mock 依赖注入（洋葱：SessionService 只见 ports，全用假实现）----
function makeDeps(overrides = {}) {
  const emitted = []
  const sessions = []
  const calls = { paste: [], send: 0, deleteStep: [], recordUsage: [] }
  const deps = {
    asr: {
      createSession(opts) {
        const s = { start() {}, pushAudio() {}, finish() {}, onPartial: opts.onPartial, onFinal: opts.onFinal }
        sessions.push(s)
        return s
      },
    },
    paster: {
      paste: async () => { calls.paste.push('paste'); return true },
      pasteImage: async () => true,
      pasteFile: async () => true,
      send: () => { calls.send++ },
      deleteStep: async () => { calls.deleteStep.push('delete'); return true },
    },
    usage: {
      recordUsage: (x) => { calls.recordUsage.push(x); return { billableSeconds: 1, costYuan: 0 } },
      patchLastText: () => {},
      checkBudgetAndMaybeDowngrade: () => {},
      getAsrPricePerSecond: () => 0,
    },
    optimize: null,
    config: { asr: { provider: 'sherpa', bailian: { contextEnabled: true } }, compose: {} },
    enablePaste: false,
    log: () => {},
    emit: (p) => emitted.push(p),
    connId: 'test',
  }
  Object.assign(deps, overrides)
  const svc = new SessionService(deps)
  return { svc, emitted, sessions, calls }
}

section('SendRuleService · 发送/删除规则解析')
test('微信默认回车', () => {
  assert.deepStrictEqual(resolveSendRule({ bundleId: 'com.tencent.xinWeChat', name: '微信' }), { key: 'enter', source: 'default' })
})
test('QQ 默认 ctrl-enter', () => {
  assert.deepStrictEqual(resolveSendRule({ bundleId: 'com.tencent.qq', name: 'QQ' }), { key: 'ctrl-enter', source: 'default' })
})
test('自定义规则优先于默认（同 bundleId）', () => {
  assert.deepStrictEqual(
    resolveSendRule({ bundleId: 'com.tencent.xinWeChat', name: '微信' }, { 'com.tencent.xinWeChat': 'cmd-enter' }),
    { key: 'cmd-enter', source: 'config' },
  )
})
test('自定义规则整体优先于默认（即使默认命中 bundleId）', () => {
  assert.deepStrictEqual(
    resolveSendRule({ bundleId: 'com.tencent.qq', name: '微信' }, { '微信': 'cmd-enter' }),
    { key: 'cmd-enter', source: 'config' },
  )
})
test('同层内 bundleId 匹配优先于 name', () => {
  assert.deepStrictEqual(
    resolveSendRule({ bundleId: 'b1', name: 'n1' }, { n1: 'cmd-enter', b1: 'none' }),
    { key: 'none', source: 'config' },
  )
})
test('无 app 信息 → unknown + 回车兜底', () => {
  assert.deepStrictEqual(resolveSendRule(null), { key: 'enter', source: 'unknown' })
})
test('自定义 none → 不回车', () => {
  assert.deepStrictEqual(resolveSendRule({ name: '终端' }, { '终端': 'none' }), { key: 'none', source: 'config' })
})
test('删除规则默认 undo', () => {
  assert.strictEqual(resolveDeleteRule({ name: '微信' }), 'undo')
})
test('删除规则自定义 backspace', () => {
  assert.strictEqual(resolveDeleteRule({ name: '终端' }, { '终端': 'backspace' }), 'backspace')
})
test('keyToOsaScript 映射', () => {
  assert.deepStrictEqual(keyToOsaScript('cmd-enter'), ['-e', 'tell application "System Events" to key code 36 using {command down}'])
  assert.deepStrictEqual(keyToOsaScript('ctrl-enter'), ['-e', 'tell application "System Events" to key code 36 using {control down}'])
  assert.deepStrictEqual(keyToOsaScript('none'), null)
  assert.deepStrictEqual(keyToOsaScript('enter'), ['-e', 'tell application "System Events" to key code 36'])
})

section('RecognitionResult · 值对象')
test('text() 拼接 finalized+partial', () => {
  assert.strictEqual(RecognitionResult.of('你好', '世界').text(), '你好世界')
})
test('isEmpty 两段都空才为真', () => {
  assert.strictEqual(RecognitionResult.of('', '').isEmpty(), true)
  assert.strictEqual(RecognitionResult.of('', '半句').isEmpty(), false)
})
test('canonicalKey 去重键', () => {
  assert.strictEqual(RecognitionResult.of('a', 'b').canonicalKey(), RecognitionResult.of('a', 'b').canonicalKey())
  assert.notStrictEqual(RecognitionResult.of('a', 'b').canonicalKey(), RecognitionResult.of('a', 'c').canonicalKey())
})
test('不可变（Object.freeze）', () => {
  assert.strictEqual(Object.isFrozen(RecognitionResult.of('a', 'b')), true)
})

section('buildAsrContext · ASR 上下文构造')
test('过滤 [错误] 与空串', () => {
  const ctx = buildAsrContext(['[错误] 模型不可用', '', '  正常文本  '])
  assert.strictEqual(ctx.length, 1)
  assert.strictEqual(ctx[0].content[0].text, '正常文本')
})
test('限制最近 5 轮', () => {
  const ctx = buildAsrContext(['a', 'b', 'c', 'd', 'e', 'f'])
  assert.strictEqual(ctx.length, 5)
  assert.strictEqual(ctx[0].content[0].text, 'b')
  assert.strictEqual(ctx[4].content[0].text, 'f')
})
test('累计字符超 400 截断', () => {
  const ctx = buildAsrContext(['a'.repeat(300), 'b'.repeat(200)])
  assert.strictEqual(ctx.length, 1)
  assert.strictEqual(ctx[0].content[0].text, 'a'.repeat(300))
})

section('SessionService · 会话状态机')
test('setInputMode 云端/本地覆盖 provider', () => {
  const { svc } = makeDeps()
  svc.setInputMode('cloud')
  assert.strictEqual(svc.effectiveProvider(), 'bailian')
  svc.setInputMode('local')
  assert.strictEqual(svc.effectiveProvider(), 'sherpa')
  svc.setInputMode(null)
  assert.strictEqual(svc.effectiveProvider(), 'sherpa') // 跟随全局 config.asr.provider='sherpa'
})
test('setInputMode keyboard 仅记展示模式、清覆盖', () => {
  const { svc } = makeDeps()
  svc.setInputMode('cloud')
  svc.setInputMode('keyboard')
  assert.strictEqual(svc.providerOverride, null)
  assert.strictEqual(svc.clientMode, 'keyboard')
  assert.strictEqual(svc.displayMode(), 'keyboard')
})
test('displayMode 按有效引擎映射 cloud/local', () => {
  const { svc } = makeDeps()
  svc.setInputMode('cloud')
  assert.strictEqual(svc.displayMode(), 'cloud')
})
test('onFinal 正常上屏并入 history/pasteHistory', () => {
  const { svc, emitted, sessions } = makeDeps()
  svc.start()
  sessions[0].onFinal('你好，世界')
  assert.deepStrictEqual(svc.history, ['你好，世界'])
  assert.deepStrictEqual(svc.pasteHistory, ['你好，世界'])
  assert(emitted.some((e) => e.type === 'final' && e.text === '你好，世界'))
})
test('onFinal "[错误]" 文本只 toast、不上屏不入历史', () => {
  const { svc, emitted, sessions } = makeDeps()
  svc.start()
  sessions[0].onFinal('[错误] 模型不可用')
  assert.strictEqual(svc.history.length, 0)
  assert.strictEqual(svc.pasteHistory.length, 0)
  assert(emitted.some((e) => e.type === 'toast' && e.text.startsWith('[错误]')))
  assert(!emitted.some((e) => e.type === 'final'))
})
test('重复 start 丢弃旧会话迟到的 final（并发防串）', () => {
  const { svc, sessions } = makeDeps()
  svc.start()
  svc.start()
  sessions[0].onFinal('旧结果')
  assert.strictEqual(svc.history.length, 0)
  sessions[1].onFinal('新结果')
  assert.deepStrictEqual(svc.history, ['新结果'])
})
test('pushAudio 累加 audioBytes，stop 记录 usage', () => {
  const { svc, sessions, calls } = makeDeps()
  svc.start()
  svc.pushAudio(Buffer.alloc(3200)) // 0.1s @16k Int16
  assert.strictEqual(svc.audioBytes, 3200)
  svc.stop()
  assert.strictEqual(calls.recordUsage.length, 1)
})
test('compose 空内容 → toast', () => {
  const { svc, emitted } = makeDeps()
  svc.compose({ text: '   ', attachments: [] })
  assert(emitted.some((e) => e.type === 'toast' && e.text.includes('输入内容为空')))
})
test('send 无历史无文本 → toast 先点击说话', () => {
  const { svc, emitted } = makeDeps()
  svc.send({})
  assert(emitted.some((e) => e.type === 'toast' && e.text.includes('先点击说话')))
})
test('removeLast 无历史 → toast', () => {
  const { svc, emitted } = makeDeps()
  svc.removeLast({})
  assert(emitted.some((e) => e.type === 'toast' && e.text.includes('没有可回退')))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
