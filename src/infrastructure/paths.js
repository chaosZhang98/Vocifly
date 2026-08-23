// 路径收敛：区分「源码态」与「打包态(asar)」的可写/只读资源位置。
// 打包成 .app 后 __dirname 在 app.asar 内（只读），而 runtime/ 需要可写、
// models/config.json 在包外——所以统一在此按 app.isPackaged 归位。
// 后续模块一律用这里的 paths.*，不要再各自 __dirname 穿越到 app 根。
//
// 判定说明：纯 Node（dev / node 测试脚本）下 require('electron') 返回的是可执行
// 文件的路径字符串而非 API，这里用守卫避免把字符串当 app 用；只有真正在
// Electron 主进程内才拿到 app 对象，isPackaged 才可能是 true。
const path = require('path')

function getElectronApp() {
  try {
    const electron = require('electron')
    return electron && typeof electron === 'object' && electron.app ? electron.app : null
  } catch {
    return null
  }
}

const app = getElectronApp()
const isPackaged = !!(app && app.isPackaged)

// 源码态项目根：src/infrastructure → app/
const DEV_ROOT = path.join(__dirname, '..', '..')

// 只读资源根：打包态在包外的 Contents/Resources（配合 asarUnpack / extraResources）；
// 源码态即项目根。
const resourcesRoot = isPackaged ? process.resourcesPath : DEV_ROOT
// 可写产物根：打包态放用户数据目录；源码态即 app/runtime。
const userDataRoot = isPackaged ? path.join(app.getPath('userData'), 'phvoice') : path.join(DEV_ROOT, 'runtime')

module.exports = {
  isPackaged,

  // ---- 只读（真文件系统，打包态经 extraResources 带出 asar）----
  scriptsDir: path.join(resourcesRoot, 'scripts'),
  configExampleFile: path.join(resourcesRoot, 'config.example.json'),
  // 模型 893M，绝不打包；打包态让用户自放到 userData/phvoice/models
  modelsDir: isPackaged ? path.join(app.getPath('userData'), 'phvoice', 'models') : path.join(DEV_ROOT, 'models'),

  // ---- 可写（runtime → 源码态 app/runtime，打包态 userData/phvoice）----
  runtimeDir: userDataRoot,
  logsDir: path.join(userDataRoot, 'logs'),
  dataDir: path.join(userDataRoot, 'data'),
  debugDir: path.join(userDataRoot, 'debug'),
  binDir: path.join(userDataRoot, 'bin'),
  certsDir: path.join(userDataRoot, 'certs'),

  // 配置（含 API key，包外）
  configFile: isPackaged ? path.join(app.getPath('userData'), 'phvoice', 'config.json') : path.join(DEV_ROOT, 'config.json'),

  binFile(name) { return path.join(this.binDir, name) },
  swiftFile(name) { return path.join(this.scriptsDir, name) },
}
