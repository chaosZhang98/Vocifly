// 离线 SenseVoice 模型的「就绪检测 + 下载」。
//
// 模型（model.int8.onnx ~230MB + tokens.txt）绝不打包进 .app（见 electron-builder.yml 的
// "!models/**/*"）。打包态由用户下载到 userData/phvoice/models，源码态到 app/models/，二者
// 统一走 paths.modelsDir，sherpa provider 读同一个目录（MODEL_DIR 从这里 import，避免两处
// 写死子目录名导致「下载位置」与「读取位置」漂移）。
//
// 下载入口：控制面板「识别服务 → 离线模型」按钮（POST /api/model/download），进度轮询
// GET /api/model/status。也可离线用 scripts/download-sensevoice.js 手动拉取。

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const paths = require('./paths')
const { log } = require('./logger')

const MODEL_DIR = path.join(paths.modelsDir, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17')
const BASE_URL = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
const FILES = ['model.int8.onnx', 'tokens.txt']

// 模型是否就绪：两个文件都存在且非空（sherpa 加载时还会再校验，这里只做轻量探测）。
function isModelAvailable() {
  return FILES.every((name) => {
    try {
      const f = path.join(MODEL_DIR, name)
      return fs.existsSync(f) && fs.statSync(f).size > 0
    } catch {
      return false
    }
  })
}

// 下载状态（进程内全局单例）：控制面板据此渲染按钮/进度，下载中轮询刷新。
let state = { running: false, file: '', received: 0, done: false, error: '' }

function getDownloadState() {
  return { ...state, available: isModelAvailable() }
}

// 单个文件下载：curl 跟随重定向，--fail 保证 HTTP 错误返回非零退出码；进度靠轮询目标文件大小。
function downloadOne(name) {
  return new Promise((resolve, reject) => {
    const dest = path.join(MODEL_DIR, name)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      log('model', `${name} 已存在，跳过`)
      resolve()
      return
    }
    state.file = name
    state.received = 0
    const url = `${BASE_URL}/${name}`
    log('model', `开始下载 ${name} ← ${url}`)
    const child = spawn('curl', ['-L', '--fail', '-sS', '-o', dest, url], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const timer = setInterval(() => {
      try { state.received = fs.statSync(dest).size } catch { /* 文件尚未创建 */ }
    }, 300)
    child.on('error', (e) => { clearInterval(timer); reject(e) })
    child.on('exit', (code) => {
      clearInterval(timer)
      try { state.received = fs.statSync(dest).size } catch {}
      if (code === 0) {
        resolve()
      } else {
        // 失败时清掉可能残留的半截文件，否则下次重试会因「文件非空」误判为已下载而跳过。
        try { fs.unlinkSync(dest) } catch {}
        reject(new Error(`curl 退出码 ${code}${stderr ? '：' + stderr.trim().slice(0, 200) : ''}`))
      }
    })
  })
}

// 依次下载两个文件（幂等：已存在则跳过），成功后校验就绪；错误写入 state.error 供面板展示。
async function downloadModel() {
  if (state.running) return getDownloadState()
  if (isModelAvailable()) return getDownloadState()
  state = { running: true, file: '', received: 0, done: false, error: '' }
  try {
    fs.mkdirSync(MODEL_DIR, { recursive: true })
    for (const name of FILES) await downloadOne(name)
    state.done = true
    log('model', isModelAvailable() ? '离线模型下载完成' : '离线模型下载结束但校验未通过（文件缺失）')
  } catch (error) {
    state.error = error.message
    log('model', `离线模型下载失败: ${error.message}`)
  } finally {
    state.running = false
    state.file = ''
  }
  return getDownloadState()
}

module.exports = { MODEL_DIR, isModelAvailable, downloadModel, getDownloadState }
