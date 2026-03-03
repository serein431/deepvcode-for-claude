# DeepVCode → Claude Code Windows 启动脚本
# 用法：deepvcode（安装后）或 powershell -File $env:USERPROFILE\.deepvcode-proxy\start.ps1

$ErrorActionPreference = "Stop"

$PROXY_SCRIPT = "$env:USERPROFILE\.deepvcode-proxy\proxy.js"
$PORT = 3456
$LOG = "$env:TEMP\deepvcode-proxy.log"
$TOKEN_FILE = "$env:USERPROFILE\.deepv\jwt-token.json"

# 检查依赖
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 未找到 node，请先安装 Node.js：https://nodejs.org" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $TOKEN_FILE)) {
    Write-Host "❌ 未找到 DeepVCode token，请先在 VSCode 中安装并登录 DeepVCode 插件" -ForegroundColor Red
    exit 1
}

# 检查 token 是否过期
try {
    $tokenData = Get-Content $TOKEN_FILE -Raw | ConvertFrom-Json
    if ($tokenData.expiresAt) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($nowMs -ge $tokenData.expiresAt) {
            Write-Host "❌ DeepVCode token 已过期，请在 VSCode 中重新登录 DeepVCode 插件" -ForegroundColor Red
            exit 1
        }
        $days = [math]::Floor(($tokenData.expiresAt - $nowMs) / 86400000)
        Write-Host "✅ Token 有效，剩余 $days 天" -ForegroundColor Green
    } else {
        Write-Host "✅ Token 有效（无过期时间）" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ token 文件读取失败，请重新登录 DeepVCode 插件" -ForegroundColor Red
    exit 1
}

# 停止旧的代理进程
Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
}
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine -like "*proxy.js*"
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1

# 后台启动代理
$proxyProc = Start-Process -FilePath "node" -ArgumentList "`"$PROXY_SCRIPT`" $PORT" `
    -RedirectStandardOutput $LOG -RedirectStandardError $LOG `
    -WindowStyle Hidden -PassThru

# 等待启动
$started = $false
for ($i = 1; $i -le 3; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-RestMethod "http://127.0.0.1:$PORT/health" -ErrorAction Stop
        if ($resp -match "ok") { $started = $true; break }
    } catch {}
}

if (-not $started) {
    Write-Host "❌ 代理启动失败，查看日志：Get-Content $LOG" -ForegroundColor Red
    exit 1
}

Write-Host "✅ DeepVCode 代理已启动（端口 $PORT，PID $($proxyProc.Id)）" -ForegroundColor Green
Write-Host "📋 日志：Get-Content -Wait $LOG"
Write-Host ""

# 启动 Claude Code
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$PORT"
$env:ANTHROPIC_AUTH_TOKEN = "PROXY_MANAGED"
claude @args
