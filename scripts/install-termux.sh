#!/bin/bash
set -euo pipefail

# AllBot Installer for Android/Termux
# Usage: curl -fsSL https://github.com/SxLiuYu/allbot/raw/main/scripts/install-termux.sh | bash

BOLD='\033[1m'
SUCCESS='\033[38;2;0;229;204m'
NC='\033[0m'

info()  { printf "${BOLD}[*]${NC} %s\n" "$*"; }
ok()    { printf "${SUCCESS}[✓]${NC} %s\n" "$*"; }

if [ ! -d "/data/data/com.termux" ]; then
  echo "此脚本必须在 Termux 中运行。"
  echo "下载 Termux: https://github.com/SxLiuYu/allbot/releases"
  exit 1
fi

info "检测到 Termux，开始安装..."

SOURCES="$PREFIX/etc/apt/sources.list"
TUNA_MIRROR="deb https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/ stable main"

TZ_PROP=$(getprop persist.sys.timezone 2>/dev/null || echo "")
case "$TZ_PROP" in
  Asia/Shanghai|Asia/Chongqing|Asia/Harbin|Asia/Urumqi|Asia/Kashgar|PRC|CTT)
    echo "$TUNA_MIRROR" > "$SOURCES"
    info "检测到中国时区，使用 TUNA 镜像"
    ;;
  *)
    info "时区: ${TZ_PROP:-未知}，使用 Termux 默认镜像"
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-y -o Dpkg::Options::=--force-confold"

info "更新软件源..."
apt-get update $APT_OPTS || true
apt-get upgrade $APT_OPTS || true

info "安装 Node.js 和依赖工具..."
apt-get install $APT_OPTS nodejs-lts lsof

npm config set fetch-retries 5
npm config set fetch-retry-mintimeout 20000
npm config set fetch-timeout 600000

case "$TZ_PROP" in
  Asia/Shanghai|Asia/Chongqing|Asia/Harbin|Asia/Urumqi|Asia/Kashgar|PRC|CTT)
    NPM_REGISTRY="--registry=https://registry.npmmirror.com"
    ;;
  *)
    NPM_REGISTRY=""
    ;;
esac

info "获取最新版本号..."
# Do NOT read the version from registry.npmjs.org/allbot: that name belongs to
# an unrelated 2015 project (bot-lab/allbot, 0.1.70), so it would install the
# wrong package. AllBot ships through GitHub Releases; the tag list also holds
# a `launcher` tag (the APK), so filter to `v<calver>` only.
#
# We also read the asset name from the same response instead of assuming
# "allbot-<tag>.tgz": a release built before the version bump carries the old
# version in the filename (e.g. tag v2026.11.13 -> allbot-2026.11.02.tgz).
RELEASES_JSON=$(
  curl -fsSL --connect-timeout 15 "https://api.github.com/repos/SxLiuYu/allbot/releases?per_page=30" 2>/dev/null || true
)

# Pick the newest v<calver> release that actually carries a tarball asset.
# The picker lives in a temp file rather than an inline `node -e`: nesting a
# quoted regex inside $( ) makes bash's paren matching fragile.
PICK=""
if [ -n "$RELEASES_JSON" ]; then
  PICKER=$(mktemp) || PICKER=""
  if [ -n "$PICKER" ]; then
    cat >"$PICKER" <<'NODE_PICK'
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const rs = JSON.parse(s);
    const ok = rs
      .filter((r) => /^v\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/.test(r.tag_name || ""))
      .sort((a, b) => (a.tag_name < b.tag_name ? 1 : -1));
    for (const r of ok) {
      const tgz = (r.assets || []).find((a) => /^(?:[a-z0-9-]+-)?allbot-.*\.tgz$/.test(a.name || ""));
      if (tgz) {
        console.log(r.tag_name.replace(/^v/, "") + "\t" + tgz.browser_download_url + "\t" + tgz.name);
        return;
      }
    }
  } catch (e) {
    /* unparseable response: leave output empty and fall through */
  }
});
NODE_PICK
    PICK=$(printf '%s' "$RELEASES_JSON" | node "$PICKER" 2>/dev/null || true)
    rm -f "$PICKER"
  fi
fi

if [ -z "${ALLBOT_VERSION:-}" ] && [ -n "$PICK" ]; then
  KB_VER=$(printf '%s' "$PICK" | cut -f1)
  TGZ_URL=$(printf '%s' "$PICK" | cut -f2)
  TGZ_NAME=$(printf '%s' "$PICK" | cut -f3)
else
  KB_VER="${ALLBOT_VERSION:-}"
  # 包名是 scoped 的 @sxliuyu/allbot，npm pack 产出的文件名带 scope 前缀：
  # sxliuyu-allbot-<ver>.tgz。手动指定版本时走的就是这条兜底路径，
  # 名字写错会直接 404。
  TGZ_NAME="sxliuyu-allbot-${KB_VER}.tgz"
  TGZ_URL="https://github.com/SxLiuYu/allbot/releases/download/v${KB_VER}/${TGZ_NAME}"
fi

if [ -z "$KB_VER" ]; then
  printf '\033[31m✗\033[0m 无法从 GitHub 获取 AllBot 版本号。\n' >&2
  printf '  请检查网络后重试，或手动指定版本：\n' >&2
  printf '  ALLBOT_VERSION=2026.11.17 bash install-termux.sh\n' >&2
  exit 1
fi

info "安装 AllBot v${KB_VER} (${TGZ_NAME})..."
npm install -g "$TGZ_URL" --force $NPM_REGISTRY || {
  info "npm 安装 tarball 失败，改用 git clone 源码安装..."
  git clone --depth 1 --branch "v${KB_VER}" https://github.com/SxLiuYu/allbot ~/allbot \
    && cd ~/allbot && pnpm install --frozen-lockfile && pnpm build \
    && npm install -g . --force
}
ok "AllBot $(allbot --version)"

# Optional: local speech engine (voice input + read-aloud). Non-fatal.
info "安装本地语音引擎 (sherpa-onnx, 可选)..."
SHERPA_INSTALLER="$(dirname "$0")/install-sherpa-onnx-termux.sh"
if [ -f "$SHERPA_INSTALLER" ]; then
  bash "$SHERPA_INSTALLER" || info "语音引擎安装跳过（不影响核心功能）。之后可重试 scripts/install-sherpa-onnx-termux.sh。"
else
  curl -fsSL https://github.com/SxLiuYu/allbot/raw/main/scripts/install-sherpa-onnx-termux.sh | bash \
    || info "语音引擎安装跳过（不影响核心功能）。"
fi

info "启动配置向导，按提示操作..."
exec allbot android-install < /dev/tty
