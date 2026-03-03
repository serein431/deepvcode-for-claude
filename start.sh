#!/usr/bin/env bash
# DeepVCode → Claude Code 启动脚本
# 用法：deepvcode（安装后）或 bash ~/.deepvcode-proxy/start.sh

PROXY_SCRIPT="$HOME/.deepvcode-proxy/proxy.js"
PORT=3456
LOG="/tmp/deepvcode-proxy.log"

# 检查依赖
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 node，请先安装 Node.js：https://nodejs.org"
  exit 1
fi

if [ ! -f "$HOME/.deepv/jwt-token.json" ]; then
  echo "❌ 未找到 DeepVCode token，请先在 VSCode 中安装并登录 DeepVCode 插件"
  exit 1
fi

# 检查 token 是否过期
EXPIRES=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync(process.env.HOME+'/.deepv/jwt-token.json','utf8'));
    if (d.expiresAt && Date.now() >= d.expiresAt) { console.log('expired'); }
    else { const days = d.expiresAt ? Math.floor((d.expiresAt-Date.now())/86400000) : '?'; console.log('ok:'+days); }
  } catch(e) { console.log('error'); }
" 2>/dev/null)

if [ "$EXPIRES" = "expired" ]; then
  echo "❌ DeepVCode token 已过期，请在 VSCode 中重新登录 DeepVCode 插件"
  exit 1
elif [ "$EXPIRES" = "error" ]; then
  echo "❌ token 文件读取失败，请重新登录 DeepVCode 插件"
  exit 1
else
  DAYS="${EXPIRES#ok:}"
  echo "✅ Token 有效，剩余 ${DAYS} 天"
fi

# 停掉旧的代理进程
pkill -f "proxy.js" 2>/dev/null || true
lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# 后台启动代理
nohup node "$PROXY_SCRIPT" "$PORT" > "$LOG" 2>&1 &
PROXY_PID=$!

# 等待启动
for i in 1 2 3; do
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/health" | grep -q ok; then
    break
  fi
  if [ $i -eq 3 ]; then
    echo "❌ 代理启动失败，查看日志：cat $LOG"
    exit 1
  fi
done

echo "✅ DeepVCode 代理已启动（端口 $PORT，PID $PROXY_PID）"
echo "📋 日志：tail -f $LOG"
echo ""

# 启动 Claude Code
ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_AUTH_TOKEN="PROXY_MANAGED" claude
