# Vocifly

把手机变成 Mac 的语音输入麦克风。手机网页采集 16kHz PCM 语音，Mac 端负责 ASR 识别并上屏。

<p align="center">
  <img src="./doc/pc-setting.png" width="800" alt="Vocifly 设置面板">
</p>

> 隐私优先，数据不出本机。本地 ASR 免费离线使用，也可按需接入云端高精度识别。

## 安装

```bash
npm install
```

## 启动

```bash
npm start
```

**DMG 分发版用户无需任何前置步骤**：首次启动自动生成本地 HTTPS 证书（mkcert 已随包内置，无需 `brew install`）。

首次建议做一次「设备接入」页的 **Mac 本机钥匙串信任**（在控制面板「设备接入」页点「在 Mac 上信任」，弹一次系统授权框、输登录密码即可）——这样 Mac 本机浏览器访问 HTTPS 不再弹警告。手机使用不依赖此步骤，跳过也不影响。

源码运行（开发 / 自用）才需要 mkcert（首次会自动找到可用二进制并生成证书）：

```bash
brew install mkcert
# app 能自动找到 mkcert 并首次生成证书；如需手动触发：
npm run setup:https
```

打开 Vocifly 主窗口（或访问 `http://localhost:9898`）即可扫码使用。

> 默认端口：HTTP 控制面板 / 证书安装页 9898，HTTPS 语音页 / WebSocket 9899。

## 手机首次配置

让手机 / 平板和 Mac 连接同一个局域网。打开 Vocifly 主窗口，「设备接入」页按三步走：

1. **Mac 本机钥匙串信任** — 点「在 Mac 上信任」完成一次性授权（可跳过，见上）
2. **首次配置** — 新手机扫「首次配置」二维码（或直接访问 `http://<Mac-IP>:9898`），页面会根据设备自动显示对应的安装步骤
3. **正常输入** — 已配过证书的手机扫「正常输入」二维码直接使用

### iPhone / iPad

1. 在「设备接入」页扫「首次配置」二维码，或直接访问 `http://<Mac-IP>:9898`。
2. 点击"下载安装描述文件"，Safari 会提示"此网站正尝试下载一个配置描述文件"，点"允许"。
3. 打开 iPhone"设置 > 通用 > VPN 与设备管理"。
4. 在"已下载的描述文件"下面找到"Vocifly 本地证书"，点进去并选择"安装"。
5. 安装成功后，进入"设置 > 通用 > 关于本机 > 证书信任设置"，启用"Vocifly 本地根证书"。
6. 回到"Vocifly 首次配置"页面，点击"验证安装"。
7. 验证通过后，点击"打开 Vocifly 语音输入"。

注意："证书信任设置"在安装成功前是空的，这是正常现象。如果没有看到"已下载的描述文件"，说明描述文件还没有下载成功，请回到"首次配置"页重新下载。

### 安卓手机 / 平板

1. 在「设备接入」页扫「首次配置」二维码，或直接访问 `http://<Mac-IP>:9898`。
2. 点击"下载 CA 证书"，浏览器会下载 `phvoice-ca.crt`，一般保存在"下载"文件夹。
3. 打开系统设置，在证书相关菜单中从存储设备安装证书：
   - 大多数安卓：`设置 > 安全 > 加密与凭据 > 安装证书 > CA 证书`
   - 具体路径因厂商而异，以系统实际菜单为准
4. 选择刚下载的 `phvoice-ca.crt`。若系统提示"可能带来风险"，选择"仍然安装"。
5. 回到"Vocifly 首次配置"页面，点击"验证安装"。
6. 验证通过后，点击"打开 Vocifly 语音输入"。

手机 / 平板只需要配置一次。之后直接访问：

```text
https://<Mac-IP>:9899
```

## 手机端界面

手机浏览器打开后即是语音输入 + 触控板操作界面：

<p align="center">
  <img src="./doc/web.png" width="300" alt="手机端界面">
</p>

- **点击说话** — 按住录音，松开识别上屏
- **触控板模式** — 单指滑动移动光标，长按进滚轮，双指滚动
- **回退 / 删除键 / 执行** — 撤销粘贴、删除文字、模拟回车

手机端源码位于 `renderer/`（`app.js`、`recorder-worklet.js`、`sw.js`）。

## 打包分发

```bash
npm run build:mac   # 构建未签名 .app（含自动下载内置 mkcert）
npm run dist        # 构建 .dmg
```

产出在 `dist/`。当前使用 ad-hoc 签名（`identity: null`），Gatekeeper 会拦截普通用户双击；如面向大众分发，需接入 Apple Developer 账号签名 + 公证（见 `electron-builder.yml`）。

## 测试

```bash
npm run test:asr     # 离线 SenseVoice（sherpa）模型跑 wav 样本
npm run test:mock    # 本地 mock 阿里百炼网关（无真实凭证）
npm run trace        # 端到端识别会话链路追踪
```

## 环境变量

最高优先级（覆盖 `config.json`）：`VOCIFLY_PASTE=0`（禁模拟粘贴）、`VOCIFLY_FORCE_HTTP=1`、`VOCIFLY_ASR_PROVIDER`、`DASHSCOPE_API_KEY` / `BAILIAN_API_KEY`、`BAILIAN_MODEL`、`BAILIAN_WORKSPACE_ID`、`BAILIAN_GATEWAY`、`VOCIFLY_HTTP_PORT` / `VOCIFLY_HTTPS_PORT`。

## 目录结构（简）

```
src/
  domain/          纯逻辑：端口契约、值对象、发送规则（零 IO）
  application/     会话状态机 SessionService
  infrastructure/  实现：ASR（sherpa/bailian）、粘贴上屏、配置、配对、用量
  interface/       Electron 主进程（main.js）、服务端/组合根（server.js）、
                   本地证书（local-cert.js）、iPhone 描述文件（mobileconfig.js）
renderer/          手机端网页（app.js 等）+ Mac 控制面板（control.html）
scripts/           fetch-mkcert / setup-local-https / 各测试脚本
```
