# DeepVCode → Claude Code

将 DeepVCode VSCode 插件的 API 额度分享给 Claude Code CLI 使用。

## 前置要求

- [Claude Code](https://claude.ai/code) 已安装（`npm install -g @anthropic-ai/claude-code`）
- [VSCode](https://code.visualstudio.com/) 已安装 DeepVCode 插件并**已登录**
- Node.js（Claude Code 自带，通常已满足）

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/你的用户名/deepvcode-for-claude/main/install.sh | bash
```

或者克隆后本地安装：

```bash
git clone https://github.com/你的用户名/deepvcode-for-claude.git
cd deepvcode-for-claude
bash install.sh
```

## 使用

安装完成后，每次使用时运行：

```bash
deepvcode
```

这会自动启动代理并进入 Claude Code。

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

```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
```
