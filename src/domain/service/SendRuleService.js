// 发送/删除快捷键规则解析 —— 领域核心纯逻辑，零 IO、零外部依赖。
//
// 洋葱依赖约束：本文件处于最内层 Domain，严禁 import 任何外部模块
// （child_process / fs / electron / sherpa-onnx-node / ws 等）。需要的输入
// （app 信息、config 里的自定义规则）全部由调用方（Application/Infrastructure）
// 作为参数传入，本层只做「根据规则返回按键组合」的纯计算。

const DEFAULT_RULES = {
  wechat: 'enter',
  微信: 'enter',
  'com.tencent.xinWeChat': 'enter',
  lark: 'enter',
  飞书: 'enter',
  'com.bytedance.lark': 'enter',
  dingtalk: 'enter',
  钉钉: 'enter',
  'com.alibaba.dingtalk': 'enter',
  slack: 'enter',
  'com.tinyspeck.slackmacgap': 'enter',
  discord: 'enter',
  'com.hnc.Discord': 'enter',
  telegram: 'enter',
  'org.telegram.desktop': 'enter',
  qq: 'ctrl-enter',
  'com.tencent.qq': 'ctrl-enter',
}

// 解析「发送」用的回车组合键。
// @param app {name, bundleId} 前台应用信息（由 Infrastructure 层读取后传入）
// @param customRules {Object} config.sendRules 自定义规则（可能为空）
// @returns { key: 'enter'|'cmd-enter'|'ctrl-enter'|'none', source: 'config'|'default'|'unknown' }
function resolveSendRule(app, customRules = {}) {
  if (app) {
    for (const candidate of [app.bundleId, app.name]) {
      if (customRules[candidate]) return { key: customRules[candidate], source: 'config' }
    }
    for (const candidate of [app.bundleId, app.name]) {
      if (DEFAULT_RULES[candidate]) return { key: DEFAULT_RULES[candidate], source: 'default' }
    }
  }
  return { key: 'enter', source: 'unknown' }
}

// 解析「删除上次输入」用的规则。默认 Cmd+Z 撤销，不依赖光标位置。
// @param app {name, bundleId} 前台应用信息
// @param customRules {Object} config.deleteRules 自定义规则（可能为空）
// @returns 'none'|'undo'|'backspace' 等
function resolveDeleteRule(app, customRules = {}) {
  if (app) {
    for (const candidate of [app.bundleId, app.name]) {
      if (customRules[candidate]) return customRules[candidate]
    }
  }
  return 'undo'
}

// 把规则 key 转成 osascript 命令参数（回车组合键的注入脚本）。
// @param key 'cmd-enter'|'ctrl-enter'|'none'|其它(默认普通回车)
// @returns string[] | null（'none' 返回 null）
function keyToOsaScript(key) {
  if (key === 'cmd-enter') return ['-e', 'tell application "System Events" to key code 36 using {command down}']
  if (key === 'ctrl-enter') return ['-e', 'tell application "System Events" to key code 36 using {control down}']
  if (key === 'none') return null
  return ['-e', 'tell application "System Events" to key code 36']
}

module.exports = { resolveSendRule, resolveDeleteRule, keyToOsaScript, DEFAULT_RULES }
