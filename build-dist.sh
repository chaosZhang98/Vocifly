#!/usr/bin/env bash
# 把 PhVoice 打包成可分发的 mac .app / dmg，校验内容并可选地灌运行时、安装、启动。
#
# 用法:
#   build-dist.sh                      # 构建 + 深度签名 + 校验（默认出目录版+dmg+zip）
#   build-dist.sh --dir                # 只出 dist/mac-arm64/PhVoice.app 目录版（最快，用于调试）
#   build-dist.sh --runtime            # 构建后把 config.json + models/ 灌进打包 app 的 userData（否则 app 无真实 key/模型）
#   build-dist.sh --install            # 构建后把 .app 装到 /Applications（自动备份旧版）
#   build-dist.sh --launch             # 构建后启动（已装则启 /Applications 版，否则启 dist 版）
#   可组合: build-dist.sh --runtime --install --launch     # 一步到位
#   其余参数原样传给 electron-builder（如 --x64 / --publish never / --config.xxx）
#
# 说明: 脚本开头 unset ELECTRON_RUN_AS_NODE —— VSCode 扩展 shell 会注入该变量，
#       会让 Electron 二进制退化为纯 Node（app 静默退出 / app undefined）。
set -euo pipefail

unset ELECTRON_RUN_AS_NODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 从脚本所在目录向上找到 package.json，定位 app 项目根（脚本无论放哪层都行）
APP_DIR="$SCRIPT_DIR"
while [ ! -f "$APP_DIR/package.json" ] && [ "$APP_DIR" != "/" ]; do APP_DIR="$(dirname "$APP_DIR")"; done
[ -f "$APP_DIR/package.json" ] || { echo "✖ 未定位到 app 项目根（找不到 package.json）"; exit 1; }
cd "$APP_DIR"

# ---- 参数解析 ----
DO_RUNTIME=0; DO_INSTALL=0; DO_LAUNCH=0; EB_ARGS=()
for a in "$@"; do
  case "$a" in
    --runtime) DO_RUNTIME=1 ;;
    --install) DO_INSTALL=1 ;;
    --launch)  DO_LAUNCH=1 ;;
    --dir)     EB_ARGS+=("--dir") ;;                      # 只出 .app 目录版
    *)         EB_ARGS+=("$a") ;;                         # 透传给 electron-builder
  esac
done

echo "==> 项目目录: $APP_DIR"
echo "==> electron-builder 参数: ${EB_ARGS[*]:-（默认 --mac，出目录版+dmg+zip）}"

# ---- 依赖检查 ----
for c in node npm; do command -v "$c" >/dev/null || { echo "✖  缺少 $c"; exit 1; }; done
[ -f config.json ] || echo "⚠  缺 app/config.json（API key）—— 打包版将只有 config.example.json，无真实 key"

# ---- 1) 清空旧产物，构建 ----
echo "==> 清空 dist/"; rm -rf dist
echo "==> electron-builder ${EB_ARGS[*]:---mac} --publish never"
"$APP_DIR/node_modules/.bin/electron-builder" --mac --publish never "${EB_ARGS[@]}"

APP="$APP_DIR/dist/mac-arm64/PhVoice.app"
[ -d "$APP" ] || { echo "✖  未生成 $APP"; exit 1; }

# ---- 2) 深度 ad-hoc 签名 ----
# identity:null 会留下「声明了资源封印却没有 CodeResources」的签名，LaunchServices/双击可能拒载，
# 必须补一次完整的 ad-hoc 深度签名。
echo "==> codesign --force --deep --sign -"
codesign --force --deep --sign - "$APP"

# ---- 3) 校验 ----
if codesign --verify --deep --strict --verbose=2 "$APP" 2>/dev/null; then
  echo "   ✔ 签名校验通过"
else
  echo "   ⚠ 签名严格校验收紧失败（多半仍可运行，仅提示）"
fi

echo "==> 校验 asar 内容（必须无 config.json / models / runtime / scripts）"
ASAR_LIST="$APP_DIR/node_modules/.bin/asar list"
BAD=$("$ASAR_LIST" "$APP/Contents/Resources/app.asar" 2>/dev/null | grep -E "(^|/)(config\.json|models|runtime|scripts)(/|$)" || true)
if [ -n "$BAD" ]; then
  echo "   ✖ asar 内含本应排除的文件: $BAD"; exit 1
else
  echo "   ✔ asar 排除正确"
fi

UNPACK=$(ls "$APP/Contents/Resources/app.asar.unpacked/node_modules/" 2>/dev/null | tr '\n' ' ')
[ -n "$UNPACK" ] && echo "   ✔ sherpa 原生已解包: $UNPACK" || echo "   ⚠ 未发现 asar 解包（sherpa 可能无法 dlopen）"

for f in scripts config.example.json; do
  [ -e "$APP/Contents/Resources/$f" ] && { [ "$f" = "scripts" ] && echo "   ✔ extraResources/scripts ($(ls "$APP/Contents/Resources/scripts" | wc -l | tr -d ' ') 个)" || echo "   ✔ extraResources/$f"; } \
    || echo "   ⚠ 缺 extraResources/$f"
done

# ---- 4) 可选：灌运行时资源（config.json + models → userData/phvoice/phvoice）----
USER_RUNTIME="$HOME/Library/Application Support/phvoice/phvoice"
if [ "$DO_RUNTIME" = 1 ]; then
  echo "==> 灌运行时资源到 $USER_RUNTIME"
  mkdir -p "$USER_RUNTIME"
  if [ -f config.json ]; then
    cp config.json "$USER_RUNTIME/config.json"; echo "   ✔ config.json（含 API key）"
  else
    echo "   ⚠ 无 config.json，跳过（app 将用示例配置）"
  fi
  if [ -d models ]; then
    rm -rf "$USER_RUNTIME/models"; cp -R models "$USER_RUNTIME/models"
    echo "   ✔ models ($(du -sh "$USER_RUNTIME/models" 2>/dev/null | cut -f1)) 已灌入"
  else
    echo "   ⚠ 无 app/models，跳过（ASR 将不可用，仅优雅回退）"
  fi
fi

# ---- 5) 可选：安装到 /Applications ----
DEST="/Applications/PhVoice.app"
if [ "$DO_INSTALL" = 1 ]; then
  if pgrep -f "$DEST/Contents/MacOS/PhVoice" >/dev/null 2>&1; then
    echo "==> 检测到 PhVoice 在运行，先退出"; osascript -e 'tell application "PhVoice" to quit' 2>/dev/null || pkill -9 -f "$DEST/Contents/MacOS/PhVoice" || true; sleep 2
  fi
  if [ -d "$DEST" ]; then rm -rf "${DEST}.bak"; mv "$DEST" "${DEST}.bak"; fi
  cp -R "$APP" "$DEST"
  xattr -cr "$DEST" 2>/dev/null; xattr -c "$DEST" 2>/dev/null || true
  echo "   ✔ 已安装到 $DEST"
fi

# ---- 6) 可选：启动（用 open；本脚本已 unset ELECTRON_RUN_AS_NODE，安全）----
if [ "$DO_LAUNCH" = 1 ]; then
  TO_OPEN="$APP"
  [ "$DO_INSTALL" = 1 ] && TO_OPEN="$DEST"
  [ -d "$DEST" ] && TO_OPEN="$DEST"
  echo "==> 启动 $TO_OPEN"
  open "$TO_OPEN"
fi

# ---- 7) 汇总 ----
echo
echo "===== 构建完成 ====="
echo " • 目录版: $APP"
for d in dist/*.dmg dist/*.zip; do [ -f "$d" ] && echo " • 分发版: $d ($(du -sh "$d" 2>/dev/null | cut -f1))"; done
echo "一步到位: build-dist.sh --runtime --install --launch"
