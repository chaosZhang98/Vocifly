# Vocifly

把手机变成 Mac 的语音输入麦克风。手机网页采集 16kHz PCM 语音，Mac 端负责 ASR 识别并上屏。

## 启动

```bash
npm install
npm start
```

如果还没有生成本地证书，先运行：

```bash
brew install mkcert
npm run setup:https
```

## 手机首次配置

让手机 / 平板和 Mac 连接同一个局域网。打开 Vocifly 主窗口，扫描“首次配置”二维码（或直接访问 `http://<Mac-IP>:8080`），页面会根据设备自动显示对应的安装步骤。

### iPhone / iPad

1. 打开 Vocifly，扫描“首次配置”二维码，或直接访问 `http://<Mac-IP>:8080`。
2. 点击“下载安装描述文件”，Safari 会提示“此网站正尝试下载一个配置描述文件”，点“允许”。
3. 打开 iPhone“设置 > 通用 > VPN 与设备管理”。
4. 在“已下载的描述文件”下面找到“Vocifly 本地证书”，点进去并选择“安装”。
5. 安装成功后，进入“设置 > 通用 > 关于本机 > 证书信任设置”，启用“Vocifly 本地根证书”。
6. 回到“Vocifly 首次配置”页面，点击“验证安装”。
7. 验证通过后，点击“打开 Vocifly 语音输入”。

注意：“证书信任设置”在安装成功前是空的，这是正常现象。如果没有看到“已下载的描述文件”，说明描述文件还没有下载成功，请回到“首次配置”页重新下载。

### 安卓手机 / 平板

1. 打开 Vocifly，扫描“首次配置”二维码，或直接访问 `http://<Mac-IP>:8080`。
2. 点击“下载 CA 证书”，浏览器会下载 `phvoice-ca.crt`，一般保存在“下载”文件夹。
3. 打开系统设置，在证书相关菜单中从存储设备安装证书：
   - 大多数安卓：`设置 > 安全 > 加密与凭据 > 安装证书 > CA 证书`
   - 具体路径因厂商而异，以系统实际菜单为准
4. 选择刚下载的 `phvoice-ca.crt`。若系统提示“可能带来风险”，选择“仍然安装”。
5. 回到“Vocifly 首次配置”页面，点击“验证安装”。
6. 验证通过后，点击“打开 Vocifly 语音输入”。

安卓无法安装 `.mobileconfig` 描述文件，因此需要手动导入根 CA（用户 CA）。现代苹果浏览器 / 安卓 Chrome 都会信任用户安装的 CA 证书，因此手机浏览器可正常访问 HTTPS。安卓对 `.local` mDNS 域名解析不稳定，配置页会优先使用 **IP 直连**地址。

手机 / 平板只需要配置一次。之后直接使用：

```text
https://<Mac-IP>:8443
```



## ASR 识别服务

识别服务通过 `app/config.json` 选择，默认使用本地 sherpa-onnx 模型（免费、离线、隐私友好，精度一般）。

```json
{
  "asr": {
    "provider": "sherpa"
  }
}
```

想切换到阿里云实时语音识别（精度更高，云端按量计费，音频会出网），推荐使用**阿里云百炼**，只需要一个 `sk-` 开头的 API Key：

```json
{
  "asr": {
    "provider": "bailian",
    "bailian": {
      "apiKey": "sk-你的百炼API Key",
      "model": "qwen-audio-3.0-asr-flash-streaming",
      "workspaceId": "",
      "gateway": "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    }
  }
}
```

百炼 API Key 在阿里云百炼控制台“API Key 管理”中创建（北京地域）。默认使用 `qwen-audio-3.0-asr-flash-streaming` 实时语音识别模型。

可以通过 `config.json` 配置即时热词，提升人名、专有名词的识别准确率：

```json
{
  "asr": {
    "provider": "bailian",
    "bailian": {
      "vocabulary": {
        "张三": 5,
        "Vocifly": 5
      }
    }
  }
}
```

### 上下文增强

Vocifly 会自动保留 Mac 端最近 5 句上屏文本，下一句开始时作为上下文传给百炼 ASR，提升人名、专有名词、同音词的识别准确率。无需额外配置；想关闭可在 `asr.bailian` 里设置 `"contextEnabled": false`。

### 发送快捷键自适应

手机端点击“发送”时，Mac 会自动检测当前最前面的 App，并按默认规则模拟回车：微信/飞书/钉钉/Slack/Discord 等用普通回车，QQ 用 Ctrl+回车。不认识的 App 默认也按回车；可在 `config.json` 顶层 `sendRules` 里覆盖，例如 `{"sendRules": {"WeChat": "cmd-enter"}}`。

回退默认使用 Cmd+Z 撤销上一次粘贴，不依赖光标位置；也可以在设置页里给每个 App 单独选“撤销 / 退格 / 不删除”。手机端回退需要连续点两次确认，避免误触。

`config.json` 已在 `.gitignore` 中，不会提交凭证。也可以用环境变量覆盖：`VOCIFLY_ASR_PROVIDER`、`DASHSCOPE_API_KEY`（或 `BAILIAN_API_KEY`）、`BAILIAN_MODEL`、`BAILIAN_WORKSPACE_ID`。

### 识别费用显示

Vocifly 主窗口底部会实时显示“识别用量与费用”：最近一次、今日、累计的识别次数、音频时长与估算费用。统计在内存中，重启后清零。

计费按音频时长估算：`费用 = 音频时长(秒) × 单价`。默认单价 `0.00033 元/秒`（`qwen-audio-3.0-asr-flash-streaming`，北京地域）；若使用阿里云百炼专属工作区网关，价格可能不同，可在设置页“单价（元/秒）”中修改，或写 `asr.bailian.pricePerSecond`。

使用离线 sherpa（本地模型）时单价为 0，费用显示为 ¥0。

### 设置页面

Vocifly 主窗口右上角有“设置”按钮，也可以在本机浏览器打开 `http://127.0.0.1:8080/settings`。页面里可以直接选择 ASR 类型（离线 / 阿里云百炼）并填写百炼 API Key，保存后写入 `config.json`，下一次识别立即生效，不需要重启。设置页面和设置接口仅允许 Mac 本机访问。

## 测试

```bash
node scripts/test-asr.js            # 用本地模型跑一个 wav 样本
node scripts/test-bailian-mock.js   # 本地模拟百炼网关，不需要凭证
```

## IP 地址变化

Vocifly 启动时会自动检查当前局域网 IP 和 `.local` 名称是否在证书中。IP 变化后，Mac 会自动用同一张根证书重新生成服务端证书；手机不需要重新安装根证书。

日常使用优先访问 `.local` 地址，IP 只是兜底。

## 当前开发状态

- 已完成：Electron 桌面端、局域网 HTTPS、证书配置页、手机网页、WSS 音频流、流式文本回调、上屏。
- ASR：默认 sherpa-onnx 本地流式模型；已接入阿里云百炼实时语音识别（sk- API Key），可插拔扩展腾讯云/火山引擎。
- 手机端：微信风格“按住说话 / 上滑取消 / 松开发送”交互；识别上屏后点击“发送”按钮，会在 Mac 上模拟一次回车，适合聊天窗口直接发送。
- 手机端：点击“切换”打开 App 面板后，在识别结果区域左右滑动可切换 Mac 前台窗口（左滑下一个，右滑上一个）；未打开面板时滑动不切换。
- 手机端：“切换”按钮会弹出手机端 App 面板，显示运行中 App 的图标和名称，点一下直接切换；普通左右滑动切窗口保持不变。
- 手机端：“触摸板”按钮开启触控板模式：单指滑动移动光标、轻点左键、长按拖动、双指滚动。
- 测试时可用 `VOCIFLY_PASTE=0 npm start` 关闭模拟粘贴，避免文字进入当前 Mac 应用。
