# DeepVCode → Claude Code Windows 一键安装脚本
# 用法：右键以 PowerShell 运行，或在 PowerShell 中执行：.\install.ps1
# 或远程安装：iwr https://你的地址/install.ps1 -UseBasicParsing | iex

$ErrorActionPreference = "Stop"

$INSTALL_DIR = "$env:USERPROFILE\.deepvcode-proxy"
$REPO_URL = "https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main"
$SETTINGS = "$env:USERPROFILE\.claude\settings.json"
$PORT = 3456

Write-Host "==================================" -ForegroundColor Cyan
Write-Host " DeepVCode → Claude Code 安装程序" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

# ── 检查依赖 ──────────────────────────────────────────────────────────────────

function Test-Command {
    param([string]$Command)
    return [bool](Get-Command -Name $Command -ErrorAction SilentlyContinue)
}

function Check-Dep {
    param(
        [string]$Name,
        [string]$InstallUrl
    )
    if (-not (Test-Command $Name)) {
        Write-Host "❌ 未找到 $Name，请先安装：$InstallUrl" -ForegroundColor Red
        exit 1
    }
}

Check-Dep "node" "https://nodejs.org"
Check-Dep "claude" "npm install -g @anthropic-ai/claude-code"
Check-Dep "curl" "Windows 10+ 自带 curl"

Write-Host "✅ 依赖检查通过（node / claude / curl）" -ForegroundColor Green

# ── 检查 DeepVCode token ───────────────────────────────────────────────────────

$TOKEN_FILE = "$env:USERPROFILE\.deepv\jwt-token.json"
if (-not (Test-Path $TOKEN_FILE)) {
    Write-Host ""
    Write-Host "❌ 未找到 DeepVCode 登录凭证" -ForegroundColor Red
    Write-Host "   请先在 VSCode 中安装 DeepVCode 插件并登录，然后重新运行此脚本"
    exit 1
}

try {
    $tokenData = Get-Content $TOKEN_FILE -Raw | ConvertFrom-Json
    if (-not $tokenData.accessToken) {
        Write-Host "❌ token 文件无效，请重新登录 DeepVCode" -ForegroundColor Red
        exit 1
    }
    if ($tokenData.expiresAt -and (Get-Date).ToUniversalTime().AddMilliseconds($tokenData.expiresAt - (Get-Date).ToUniversalTime().Ticks / 10000).Ticks -le 0) {
        Write-Host "❌ DeepVCode token 已过期，请在 VSCode 中重新登录后再安装" -ForegroundColor Red
        exit 1
    }
    $days = if ($tokenData.expiresAt) {
        [math]::Floor(($tokenData.expiresAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 86400000)
    } else { "?" }
    Write-Host "✅ DeepVCode token 有效（剩余 $days 天）" -ForegroundColor Green
} catch {
    Write-Host "❌ token 文件解析失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ── 安装代理文件 ───────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "📦 正在安装代理文件到 $INSTALL_DIR ..."
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (Test-Path "$SCRIPT_DIR\proxy.js") {
    Copy-Item "$SCRIPT_DIR\proxy.js" "$INSTALL_DIR\proxy.js" -Force
    Copy-Item "$SCRIPT_DIR\start.ps1" "$INSTALL_DIR\start.ps1" -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path "$INSTALL_DIR\start.ps1")) {
        # 如果没有 start.ps1，创建一个简单的
        @'
param([string[]]$Args)
$PORT = if ($Args[0] -match '^\d+$') { $Args[0] } else { 3456 }
node "$env:USERPROFILE\.deepvcode-proxy\proxy.js" $PORT
'@ | Set-Content "$INSTALL_DIR\start.ps1" -Encoding UTF8
    }
} else {
    Invoke-WebRequest -Uri "$REPO_URL/proxy.js" -OutFile "$INSTALL_DIR\proxy.js" -UseBasicParsing
    Invoke-WebRequest -Uri "$REPO_URL/start.ps1" -OutFile "$INSTALL_DIR\start.ps1" -UseBasicParsing -ErrorAction SilentlyContinue
}

Write-Host "✅ 代理文件已安装" -ForegroundColor Green

# ── 修改 Claude Code 配置 ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "⚙️  配置 Claude Code ..."
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SETTINGS) | Out-Null

$claudeConfig = @{ env = @{} }
if (Test-Path $SETTINGS) {
    # 备份原始配置
    Copy-Item $SETTINGS "$SETTINGS.bak" -Force
    Write-Host "   已备份原配置到 ${SETTINGS}.bak"
    try {
        $claudeConfig = Get-Content $SETTINGS -Raw | ConvertFrom-Json -AsHashtable
        if (-not $claudeConfig) { $claudeConfig = @{ env = @{} } }
        if (-not $claudeConfig.env) { $claudeConfig.env = @{} }
    } catch {
        $claudeConfig = @{ env = @{} }
    }
}

$claudeConfig.env["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:$PORT"
$claudeConfig.env["ANTHROPIC_AUTH_TOKEN"] = "PROXY_MANAGED"
$claudeConfig.env.Remove("ANTHROPIC_API_KEY")

$claudeConfig | ConvertTo-Json -Depth 10 | Set-Content $SETTINGS -Encoding UTF8
Write-Host "✅ $SETTINGS 已更新" -ForegroundColor Green

# ── 创建 deepvcode 命令 ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "🔗 创建快捷命令 deepvcode ..."

# 查找或创建 bin 目录
$BIN_DIR = $null
$possibleBins = @(
    "$env:USERPROFILE\bin",
    "$env:USERPROFILE\.local\bin"
)

foreach ($d in $possibleBins) {
    if ($env:PATH -like "*$d*") {
        try {
            New-Item -ItemType Directory -Force -Path $d -ErrorAction Stop | Out-Null
            $probeFile = Join-Path $d ".deepvcode-write-test.tmp"
            "ok" | Set-Content -Path $probeFile -Encoding ASCII -ErrorAction Stop
            Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
            $BIN_DIR = $d
            break
        } catch {
            # PATH 中存在但不可写（例如 WindowsApps），继续尝试下一个目录
        }
    }
}

if (-not $BIN_DIR) {
    $BIN_DIR = "$env:USERPROFILE\.local\bin"
    New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if (-not $userPath) { $userPath = "" }
    if ($userPath -notlike "*$BIN_DIR*") {
        $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $BIN_DIR } else { "$userPath;$BIN_DIR" }
        [Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
    }
    Write-Host ""
    Write-Host "   ⚠️  已将 $BIN_DIR 添加到用户 PATH，请重启 PowerShell 后使用 deepvcode 命令" -ForegroundColor Yellow
}

# 创建 PowerShell 脚本
@'
#!/usr/bin/env pwsh
$PORT = if ($args[0] -match '^\d+$') { $args[0] } else { 3456 }

# 检查代理是否已在运行
$running = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
if (-not $running) {
    Write-Host "🚀 启动 DeepVCode 代理 (端口 $PORT)..." -ForegroundColor Cyan
    Start-Process -FilePath "node" -ArgumentList "$env:USERPROFILE\.deepvcode-proxy\proxy.js", $PORT -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

# 启动 Claude Code
& claude @args
'@ | Set-Content "$BIN_DIR\deepvcode.ps1" -Encoding UTF8

# 创建 CMD 批处理文件（可选）
@"
@echo off
set PORT=3456
if "%~1"=="" goto :run
setlocal EnableDelayedExpansion
set "arg=%~1"
if "!arg:~0,1!" geq "0" if "!arg:~0,1!" leq "9" (
    set PORT=%~1
    shift
)
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "$BIN_DIR\deepvcode.ps1" %*
"@ | Set-Content "$BIN_DIR\deepvcode.cmd" -Encoding ASCII -ErrorAction SilentlyContinue

Write-Host "✅ 命令已创建：$BIN_DIR\deepvcode.ps1" -ForegroundColor Green

# ── 启动测试 ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "🚀 启动代理测试 ..."

# 杀掉占用端口的进程
Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
}
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*proxy.js*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1

# 启动代理
Start-Process -FilePath "node" -ArgumentList "$INSTALL_DIR\proxy.js", $PORT -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\deepvcode-proxy.log" -RedirectStandardError "$env:TEMP\deepvcode-proxy.err"

$started = $false
for ($i = 1; $i -le 3; $i++) {
    Start-Sleep -Seconds 1
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/health" -UseBasicParsing -ErrorAction SilentlyContinue
        if ($response.Content -like "*ok*") {
            $started = $true
            break
        }
    } catch {}
}

if (-not $started) {
    Write-Host "❌ 代理启动测试失败，查看日志：" -ForegroundColor Red
    Write-Host "   stdout: $env:TEMP\deepvcode-proxy.log"
    Write-Host "   stderr: $env:TEMP\deepvcode-proxy.err"
    exit 1
}

Write-Host "✅ 代理运行正常" -ForegroundColor Green

# ── 完成 ───────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "==================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "==================================" -ForegroundColor Green
Write-Host ""
Write-Host "使用方法："
Write-Host "  deepvcode          启动代理并进入 Claude Code" -ForegroundColor Yellow
Write-Host "  deepvcode --help   查看 Claude Code 帮助" -ForegroundColor Yellow
Write-Host ""
Write-Host "注意事项："
Write-Host "  - Claude Code 已配置为默认走 DeepVCode 代理"
Write-Host "  - 若要恢复原始配置，还原备份：Copy-Item ${SETTINGS}.bak $SETTINGS"
Write-Host "  - token 到期后，在 VSCode 中重新登录 DeepVCode 即可，无需重新安装"
Write-Host ""
