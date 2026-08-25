---
name: run-phvoice
description: Run, launch, screenshot, and smoke-test PhVoice (macOS Electron menu-bar app — phone as microphone). Use when asked to "run the app", "start PhVoice", "launch it", "screenshot the control panel", or "smoke-test the API".
---

# Run PhVoice

PhVoice 是一个 macOS 菜单栏 Electron 应用：手机当麦克风，Mac 端 ASR 识别并上屏。
它没有命令行入口——真正的运行时表面是一个 **loopback HTTP API**（控制面板 + REST）+ 一个
Electron 窗口（控制面板）。所以“运行”= 启动 Electron + 打 HTTP 接口 + 用 CDP 截图。

驱动脚本是 [driver.mjs](.claude/skills/run-phvoice/driver.mjs)。**先跑它，别手敲 `npm start`。**

> 路径均相对 `app/`（本 skill 所在单元）。本应用**仅 macOS**：托盘/隐藏 Dock/
> 辅助功能权限/登录项/CGEvent 上屏/编译好的 Swift 助手，在 Linux 上无法运行（不是“没试”）。

## 前置条件

- **macOS**（Apple Silicon / Intel）
- **Node ≥ 22**（驱动用全局 `fetch`/`WebSocket`；本机 v24）
- 依赖：`cd app && npm install`（拉 electron / ws / qrcode / sherpa-onnx-node）

证书**不需要**手动生成：`createServer` 首次启动会用 `ensureLocalCertificate` 自动签/重签，
README 里的 `brew install mkcert` + `npm run setup:https` 不是必需步骤。

## 运行（agent 路径，首选）

```bash
cd app
node .claude/skills/run-phvoice/driver.mjs run
```

一条命令完成：杀旧实例 → 启动 Electron（自动 `env -u ELECTRON_RUN_AS_NODE` +
`--remote-debugging-port=9222`）→ 等 `/api/health` 就绪 → HTTP 冒烟 → CDP 截图。
截图落在 `runtime/debug/control-panel.png`。结束时 app 保持运行，用 `stop` 关掉。

子命令（app 已运行时单独用）：

```bash
node .claude/skills/run-phvoice/driver.mjs smoke      # 只冒烟，exit 0/1
node .claude/skills/run-phvoice/driver.mjs screenshot # 只截图
node .claude/skills/run-phvoice/driver.mjs launch     # 只启动并等就绪
node .claude/skills/run-phvoice/driver.mjs stop       # 杀掉 PhVoice
```

就绪标志：`http://127.0.0.1:9898/api/health` 返回 200。HTTP 端口解析顺序：
`PHVOICE_HTTP_PORT` 环境变量 > `config.json` 的 `httpPort` > 9898（驱动已复刻该顺序）。

## 运行（人类路径，仅普通 macOS 终端）

```bash
cd app && npm start   # = electron . ，弹出窗口/驻留菜单栏，Ctrl-C 退出
```

注意：**本 VSCode/Bash 工具 shell 里直接 `npm start` 会崩**（见 Gotchas 的
`ELECTRON_RUN_AS_NODE`）。普通 macOS 终端没有该变量，`npm start` 正常。

## 直接调用（无 GUI 的服务器模式）

只测 server/config/pairing 逻辑、不想起 Electron 时：

```bash
cd app
PHVOICE_FORCE_HTTP=1 PHVOICE_HTTP_PORT=9897 node src/interface/server.js
# 另开终端：
curl http://127.0.0.1:9897/api/settings
```

`PHVOICE_FORCE_HTTP=1` 跳过 HTTPS/证书、只起 HTTP；控制路由（`/api/settings` 等）仍只允许 loopback。

## 冒烟内容

驱动 `smoke` 打三个 loopback 接口：`/api/health`（200）、`/api/settings`
（apiKey 已被掩码、不泄露真实 `sk-` key）、`/api/login-item`（`{ok:true}`）。

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1`（本 shell 预置）**：直接 `electron .` 会退化成 Node 模式，
  `require('electron')` 返回路径字符串、`app` 为 undefined，顶层 `app.on` 抛
  `Cannot read properties of undefined`。必须 `env -u ELECTRON_RUN_AS_NODE`（驱动已自动做）。
  连 `open /Applications/PhVoice.app` 也会把该变量 leak 进 GUI 会话导致静默闪退。
- **README 端口过时**：README 写 8080/8443，实际默认是 **9898（HTTP 控制面板）/ 9899（HTTPS+WS）**。
- **apiKey 不出进程边界**：`/api/settings` 返回掩码 `••••••••••••••••`，不是真实 key。
  `config.json`（0600、已 gitignore）存真实百炼 key，别用 `cat` 直接看。
- **仅 macOS**：Linux 上起不来，依赖 macOS API。
- **`npm install` 可能拦 electron 的 postinstall**（本机有 `allowScripts` 策略告警）。若
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` 缺失，手动
  `node node_modules/electron/install.js` 补下载二进制。

## Troubleshooting

- `app 未在 30s 内就绪` → 看 `runtime/logs/app.log` 尾部（驱动超时会自动把尾部打出来）。
  常见：electron 二进制缺失（见上一条）、端口被占。
- 启动即退、日志出现 `reading 'on'` 堆栈 → `echo $ELECTRON_RUN_AS_NODE` 为 `1`，用驱动或
  `env -u ELECTRON_RUN_AS_NODE` 重启。
