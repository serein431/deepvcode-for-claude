# DeepVCode → Claude Code

将 DeepVCode VSCode 插件的 API 额度分享给 Claude Code CLI 使用。

## 前置要求

- [Claude Code](https://claude.ai/code) 已安装（`npm install -g @anthropic-ai/claude-code`）
- [VSCode](https://code.visualstudio.com/) 已安装 DeepVCode 插件并**已登录**
- Node.js（Claude Code 自带，通常已满足）

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main/install.sh | bash
```

或者克隆后本地安装：

```bash
git clone https://github.com/serein431/deepvcode-for-claude.git
cd deepvcode-for-claude
bash install.sh
```

## Windows 安装

### `install.ps1` 脚本怎么用

本地脚本执行（推荐）：

```powershell
cd deepvcode-for-claude
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install.ps1
```

远程一键执行（不落地文件）：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
iwr https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main/install.ps1 -UseBasicParsing | iex
```

如果当前在 CMD 里：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main/install.ps1 -UseBasicParsing | iex"
```

安装完成后，打开新终端执行：

```powershell
deepvcode
```

---

在 **PowerShell** 中执行（无需管理员）：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
iwr https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main/install.ps1 -UseBasicParsing | iex
```

如果你在 **CMD** 里执行，请用：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/serein431/deepvcode-for-claude/main/install.ps1 -UseBasicParsing | iex"
```

或者克隆后本地安装：

```powershell
git clone https://github.com/serein431/deepvcode-for-claude.git
cd deepvcode-for-claude
.\install.ps1
```

安装完成后，在新终端中运行：

```powershell
deepvcode
```

> Windows 下配置文件位置：
> - Token 文件：`%USERPROFILE%\.deepv\jwt-token.json`
> - Claude 配置：`%USERPROFILE%\.claude\settings.json`
> - 代理文件：`%USERPROFILE%\.deepvcode-proxy\`
> - 日志：`%TEMP%\deepvcode-proxy.log`

## 使用

安装完成后，每次使用时运行：

```bash
deepvcode
```

这会自动启动代理并进入 Claude Code。

## 上游代理配置（让 DeepVCode 请求都走代理）

`proxy.js` 会优先读取以下环境变量作为上游代理：

- `DEEPVCODE_UPSTREAM_PROXY`（推荐，优先级最高）
- `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`

示例：

```bash
# 按你的代理软件实际地址填写，不一定是 7890
export DEEPVCODE_UPSTREAM_PROXY="http://127.0.0.1:<你的代理端口>"
deepvcode
```

Windows PowerShell：

```powershell
$env:DEEPVCODE_UPSTREAM_PROXY = "http://127.0.0.1:<你的代理端口>"
deepvcode
```

常见端口仅供参考（以你本机配置为准）：`7890`、`1080`、`8080`、`8888`。

启动时会打印 `上游代理`，用于确认当前是走代理还是直连。

## 工作原理

```
Claude Code  →  本地代理（:3456）  →  DeepVCode 后端
Anthropic 格式              GenAI 格式
```

1. 代理监听本地 3456 端口
2. 将 Claude Code 的 Anthropic 格式请求转换为 DeepVCode 的 Google GenAI 格式
3. 使用 `~/.deepv/jwt-token.json` 中的 JWT Token 认证（DeepVCode 插件登录后自动生成）
4. 将响应转换回 Anthropic 格式返回给 Claude Code

## Token 过期

Token 过期后，在 VSCode 中重新登录 DeepVCode 插件即可，无需重新安装。

## 恢复原始配置

### Mac/Linux

```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
```

### Windows

```powershell
Copy-Item $env:USERPROFILE\.claude\settings.json.bak $env:USERPROFILE\.claude\settings.json
```
