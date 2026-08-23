// 剪贴板端口 —— 领域核心抽象，只定义不实现，零 IO、零外部依赖。
//
// 洋葱约束：本文件处于最内层 Domain，严禁 require 任何外部模块。它只声明
// 「读/写系统剪贴板」这一原子能力契约，具体实现（pbcopy/pbpaste 子进程）
// 在 Infrastructure 层注入。
//
// 上屏策略依赖它做两件事：
//   readClipboard()  —— 上屏前备份用户当前剪贴板内容，以便还原
//   writeClipboard() —— 把识别文本写入剪贴板，再交给 PastePort 模拟 Cmd+V
//
// 说明：仅当走「写剪贴板 + 模拟粘贴」回退路径时才用到；mac-control 助手直接
// 注入粘贴字符时可不动系统剪贴板。是否还原由 Application 层权衡后决定。

class ClipboardPort {
  /**
   * 读当前系统剪贴板文本。剪贴板为空或含非文本内容时返回 null。
   * @returns {Promise<string|null>}
   */
  async readClipboard() {
    throw new Error('ClipboardPort.readClipboard 为抽象端口，需由 Infrastructure 层实现注入')
  }

  /**
   * 把文本写入系统剪贴板。
   * @param {string} text
   * @returns {Promise<void>}
   */
  async writeClipboard(_text) {
    throw new Error('ClipboardPort.writeClipboard 为抽象端口，需由 Infrastructure 层实现注入')
  }
}

module.exports = { ClipboardPort }
