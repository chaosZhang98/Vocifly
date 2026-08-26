// 上屏端口 —— 领域核心抽象，只定义不实现，零 IO、零外部依赖。
//
// 洋葱约束：本文件处于最内层 Domain，严禁 require 任何外部模块。它只声明
// 「把识别结果送进前台应用需要哪些原子动作」，具体实现（mac-paster 调
// pbcopy/osascript/mac-control 助手）在 Infrastructure 层注入。
//
// 上屏语义（这是业务关心的抽象，不是底层键鼠细节）：
//   paste(text)      —— 把文本送进当前光标处（剪贴板 + Cmd+V / 或 mac-control 助手）
//   send()           —— 按前台应用规则模拟回车（发送）
//   deleteStep(text) —— 撤销/退格删除上次上屏内容，便于「说错了重新说」
//   activateApp(id)  —— 切换/激活到目标应用（回显前聚焦）
//   switchWindow(dir)—— 切换窗口（prev/next）
//
// 实现类不应把这些动作耦合进领域逻辑；Application 层只调用本抽象。

class PastePort {
  /** 把文本送进前台光标处。 @param {string} text @param {{enter?: boolean}} [opts] @returns {Promise<boolean>} */
  async paste(_text, _opts) {
    throw new Error('PastePort.paste 为抽象端口，需由 Infrastructure 层实现注入')
  }

  /** 模拟回车（发送）。 @returns {Promise<void>} */
  async send() {
    throw new Error('PastePort.send 为抽象端口，需由 Infrastructure 层实现注入')
  }

  /** 撤销/删除上次上屏内容。
   *  @param {string} text 回退目标文本
   *  @param {{mode?: 'undo'|'backspace'}} [opts] mode='backspace' 强制逐字符退格（等效键盘删除键），不传则按规则自适应 */
  deleteStep(_text, _opts) {
    throw new Error('PastePort.deleteStep 为抽象端口，需由 Infrastructure 层实现注入')
  }

  /** 激活目标应用（回显前聚焦）。 @param {string} bundleId */
  activateApp(_bundleId) {
    throw new Error('PastePort.activateApp 为抽象端口，需由 Infrastructure 层实现注入')
  }

  /** 切换窗口。 @param {'prev'|'next'} dir */
  switchWindow(_dir) {
    throw new Error('PastePort.switchWindow 为抽象端口，需由 Infrastructure 层实现注入')
  }
}

module.exports = { PastePort }
