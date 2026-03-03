#!/usr/bin/env bash
# DeepVCode → Claude Code 一键安装脚本
# 用法：bash install.sh
# 或远程安装：curl -fsSL https://你的地址/install.sh | bash

set -e

INSTALL_DIR="$HOME/.deepvcode-proxy"
REPO_URL="https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main"
SETTINGS="$HOME/.claude/settings.json"
PORT=3456

echo "=================================="
echo " DeepVCode → Claude Code 安装程序"
echo "=================================="
echo ""

# ── 检查依赖 ──────────────────────────────────────────────────────────────────

check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "❌ 未找到 $1，请先安装：$2"
    exit 1
  fi
}

check_dep node  "https://nodejs.org"
check_dep claude "npm install -g @anthropic-ai/claude-code"
check_dep curl  "系统自带，请检查环境"

echo "✅ 依赖检查通过（node / claude / curl）"

# ── 检查 DeepVCode token ───────────────────────────────────────────────────────

TOKEN_FILE="$HOME/.deepv/jwt-token.json"
if [ ! -f "$TOKEN_FILE" ]; then
  echo ""
  echo "❌ 未找到 DeepVCode 登录凭证"
  echo "   请先在 VSCode 中安装 DeepVCode 插件并登录，然后重新运行此脚本"
  exit 1
fi

EXPIRES=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));
    if (!d.accessToken) { console.log('invalid'); process.exit(); }
    if (d.expiresAt && Date.now() >= d.expiresAt) { console.log('expired'); process.exit(); }
    const days = d.expiresAt ? Math.floor((d.expiresAt-Date.now())/86400000) : '?';
    console.log('ok:'+days);
  } catch(e) { console.log('error:'+e.message); }
" 2>/dev/null)

case "$EXPIRES" in
  expired)
    echo "❌ DeepVCode token 已过期，请在 VSCode 中重新登录后再安装"
    exit 1 ;;
  invalid|error*)
    echo "❌ token 文件无效，请重新登录 DeepVCode"
    exit 1 ;;
  ok:*)
    DAYS="${EXPIRES#ok:}"
    echo "✅ DeepVCode token 有效（剩余 ${DAYS} 天）" ;;
esac

# ── 安装代理文件 ───────────────────────────────────────────────────────────────

echo ""
echo "📦 正在安装代理文件到 $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

# 如果是本地运行（文件在同目录），直接复制；否则从网络下载
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/proxy.js" ]; then
  cp "$SCRIPT_DIR/proxy.js" "$INSTALL_DIR/proxy.js"
  cp "$SCRIPT_DIR/start.sh" "$INSTALL_DIR/start.sh"
else
  curl -fsSL "$REPO_URL/proxy.js" -o "$INSTALL_DIR/proxy.js"
  curl -fsSL "$REPO_URL/start.sh" -o "$INSTALL_DIR/start.sh"
fi

chmod +x "$INSTALL_DIR/start.sh"
echo "✅ 代理文件已安装"

# ── 修改 Claude Code 配置 ──────────────────────────────────────────────────────

echo ""
echo "⚙️  配置 Claude Code ..."
mkdir -p "$(dirname "$SETTINGS")"

if [ -f "$SETTINGS" ]; then
  # 备份原始配置
  cp "$SETTINGS" "${SETTINGS}.bak"
  echo "   已备份原配置到 ${SETTINGS}.bak"

  # 用 node 安全地修改 JSON，避免 sed 破坏文件
  node -e "
    const fs = require('fs');
    const f = '$SETTINGS';
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
    cfg.env = cfg.env || {};
    cfg.env.ANTHROPIC_BASE_URL  = 'http://127.0.0.1:$PORT';
    cfg.env.ANTHROPIC_AUTH_TOKEN = 'PROXY_MANAGED';
    delete cfg.env.ANTHROPIC_API_KEY;
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
    console.log('✅ ~/.claude/settings.json 已更新');
  "
else
  # 创建新配置
  node -e "
    const fs = require('fs');
    const cfg = {
      env: {
        ANTHROPIC_BASE_URL:  'http://127.0.0.1:$PORT',
        ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED'
      }
    };
    fs.writeFileSync('$SETTINGS', JSON.stringify(cfg, null, 2) + '\n');
    console.log('✅ ~/.claude/settings.json 已创建');
  "
fi

# ── 创建 deepvcode 命令 ────────────────────────────────────────────────────────

echo ""
echo "🔗 创建快捷命令 deepvcode ..."

# 找合适的 bin 目录
BIN_DIR=""
for d in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
  if [ -d "$d" ] && echo "$PATH" | grep -q "$d"; then
    BIN_DIR="$d"
    break
  fi
done

if [ -z "$BIN_DIR" ]; then
  # 创建并加入 PATH
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  echo ""
  echo "   ⚠️  请将以下内容添加到你的 shell 配置文件（~/.zshrc 或 ~/.bashrc）："
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

cat > "$BIN_DIR/deepvcode" <<'EOF'
#!/usr/bin/env bash
exec bash "$HOME/.deepvcode-proxy/start.sh" "$@"
EOF
chmod +x "$BIN_DIR/deepvcode"
echo "✅ 命令已创建：$BIN_DIR/deepvcode"

# ── 启动测试 ───────────────────────────────────────────────────────────────────

echo ""
echo "🚀 启动代理测试 ..."
# 杀掉所有占用该端口的 node 进程
pkill -f "proxy.js" 2>/dev/null || true
lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1
nohup node "$INSTALL_DIR/proxy.js" "$PORT" > /tmp/deepvcode-proxy.log 2>&1 &

for i in 1 2 3; do
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/health" | grep -q ok; then
    break
  fi
  if [ $i -eq 3 ]; then
    echo "❌ 代理启动测试失败，查看日志：cat /tmp/deepvcode-proxy.log"
    exit 1
  fi
done
echo "✅ 代理运行正常"

# ── 完成 ───────────────────────────────────────────────────────────────────────

echo ""
echo "=================================="
echo "  安装完成！"
echo "=================================="
echo ""
echo "使用方法："
echo "  deepvcode          启动代理并进入 Claude Code"
echo "  deepvcode --help   查看 Claude Code 帮助"
echo ""
echo "注意事项："
echo "  - Claude Code 已配置为默认走 DeepVCode 代理"
echo "  - 若要恢复原始配置，还原备份：cp ${SETTINGS}.bak $SETTINGS"
echo "  - token 到期后，在 VSCode 中重新登录 DeepVCode 即可，无需重新安装"
echo ""
