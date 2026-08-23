// ASR 端口 —— 领域核心抽象，只定义不实现，零 IO、零外部依赖。
//
// 洋葱约束：本文件处于最内层 Domain，严禁 require 任何外部模块。它只声明
// 「识别提供商需要提供什么样的能力契约」，具体实现（sherpa 离线 / bailian 在线）
// 在 Infrastructure 层注入。Application 层只依赖本抽象，不直接 import 任何 provider。
//
// 契约形状（JSDoc 为准，运行时由实现类提供）：
//   AsrPort.createSession({ onPartial, onFinal, config, context }) → AsrSession
//
//   AsrSession 接口：
//     start()                    // 开始识别（可上送音频）
//     pushAudio(int16buf)        // 推一帧 16kHz Int16 PCM
//     finish()                   // 结束会话，触发最终回调
//
//   onPartial(finalized, partial)  // 实时回显分层：已定稿句 + 正在听的半句
//   onFinal(text)                  // 最终结果
//
// 注意：onPartial 是「两参」（finalized, partial），不是旧的单参 text。
// 这是视觉分层需求定下的契约 —— 前端需要区分「确定」与「还在修正」两段。

/** @typedef {Object} AsrSession
 *  @property {() => void} start
 *  @property {(buf: Buffer) => void} pushAudio
 *  @property {() => void} finish
 */

/** @typedef {(finalized: string, partial: string) => void} OnPartialFn
 *  @typedef {(text: string) => void} OnFinalFn
 *  @typedef {(callbacks: {onPartial: OnPartialFn, onFinal: OnFinalFn, config?: any, context?: any}) => AsrSession} CreateSessionFn
 */

class AsrPort {
  /**
   * 创建一次识别会话。实现类必须返回一个满足 AsrSession 接口的对象。
   * 基类只定义契约，不提供任何实现 —— 直接被调用即抛错。
   * @param {Object} callbacks
   * @param {OnPartialFn} callbacks.onPartial
   * @param {OnFinalFn} callbacks.onFinal
   * @param {any} [callbacks.config]
   * @param {any} [callbacks.context]
   * @returns {AsrSession}
   */
  createSession(_callbacks) {
    throw new Error('AsrPort.createSession 为抽象端口，需由 Infrastructure 层实现注入')
  }
}

module.exports = { AsrPort }
