// 文字优化端口 —— 领域核心抽象，只定义不实现，零 IO、零外部依赖。
//
// 洋葱约束：本文件处于最内层 Domain，严禁 require 任何外部模块。它只声明
// 「对识别结果做文字优化（纠错/润色/换语气）需要什么能力」，具体实现
// （百炼 qwen 在线大模型）在 Infrastructure 层注入。Application 层只依赖本抽象。
//
// 契约形状（JSDoc 为准）：
//   OptimizePort.optimize(text, opts) → Promise<string>
//
//   optimize(text) —— 把一段语音转写文本交给大模型优化，返回优化后的文本；
//     失败应 reject（带可读原因），由调用方决定 toast 文案与降级行为。

class OptimizePort {
  /**
   * 优化一段识别文本。实现类必须调用大模型并返回优化后的纯文本。
   * 基类只定义契约，不提供任何实现 —— 直接被调用即抛错。
   * @param {string} text 待优化文本
   * @param {Object} [opts] 可选参数（如 config 引用、附加指令等，由实现类决定）
   * @returns {Promise<string>}
   */
  async optimize(_text, _opts) {
    throw new Error('OptimizePort.optimize 为抽象端口，需由 Infrastructure 层实现注入')
  }
}

module.exports = { OptimizePort }
