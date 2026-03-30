<div align="center">

# Odradek
<img src=".images/odradek.jpg" alt="Odradek Logo" width="75%"/>

[![License](https://img.shields.io/github/license/chaobo8484/odradek-cli)](https://github.com/chaobo8484/odradek-cli/blob/main/LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
[![X](https://img.shields.io/badge/X-Follow-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/Xiayin8484)

[English](README.md) | **简体中文**

</div>

## 项目概述

Odradek 是一个面向 Claude Code 工作流的终端 CLI(正在努力适配更多的Agent)。它把交互式聊天、Provider 切换、Prompt / Skill 资产扫描、Claude JSONL 诊断，以及 evidence-first 的 noise evaluation 放进了同一个 workspace-aware 工具里。

<img src=".images/homepage.png" alt="Odradek Homepage">

## 为什么用 Odradek

- 在终端里同时完成聊天和工作流诊断，不用频繁切换工具。
- 用 `/provider` 和 `/model` 在同一会话中切换 Claude 与 OpenRouter。
- 在 Prompt、Rules、Agent、Skill 悄悄膨胀上下文之前先把它们扫描清楚。
- 解析 Claude JSONL 记录，查看 token 结构和上下文压力。
- 基于 outcome、process、context、validation 四个维度执行证据优先的 noise evaluation。
- 在证据不足时保持保守，缺什么就返回 `N/A`，而不是猜测。

## 预览

<div align="center">
<table>
<tr>
<td><img src="./images/chat.png" alt="截图1" width="100%"/></td>
<td><img src="./images/chatwithllm.png" alt="截图2" width="100%"/></td>
</tr>
<tr>
<td><img src="./images/noiseeval.png" alt="截图3" width="100%"/></td>
<td><img src="./images/noiseeval1.png" alt="截图4" width="100%"/></td>
</tr>
</table>
</div>


## 功能分区

| 分区 | 能力说明 | 关键命令 |
| --- | --- | --- |
| 运行态控制 | Provider / Model 切换、信任校验、项目上下文开关、工作区状态 | `/state`、`/provider`、`/model`、`/trustpath`、`/projectcontext` |
| Prompt 与 Skill 资产 | Prompt / Rules / Agent 扫描、规则提取、Skills 总览、分层系统提示词 | `/scan_prompt`、`/rules`、`/skills` |
| 会话诊断 | Token 结构、上下文健康度、证据优先 noise evaluation、Todo 粒度分析 | `/scan_tokens`、`/context_health`、`/noise_eval`、`/todo_granularity` |
| 对话工具 | 帮助、历史记录、折叠展开、导出 | `/help`、`/history`、`/collapse`、`/expand`、`/export` |

## 环境要求

- Node.js `>= 20`
- npm `>= 9`

## 生产态安装

如果你是普通用户，只想使用 Odradek 请按照以下步骤安装配置。

全局安装：

```bash
npm install -g odradek-cli
odradek
```

或

```bash
npx odradek-cli@latest
```


## 生产态配置

Odradek 会从环境变量读取 Provider 配置。对于已经安装好的 CLI，推荐通过下面任一位置提供配置：

- 应用级 `.env` 或 `.env.local`
- 当前工作区的 `.env` 或 `.env.local`
- Shell 环境变量

推荐的应用级路径：

```text
Windows: %APPDATA%/odradek-cli/.env
macOS:   ~/Library/Application Support/odradek-cli/.env
Linux:   ~/.config/odradek-cli/.env
```

工作区配置文件会在应用级目录之后加载，所以你可以为某个仓库单独覆盖默认配置。

Claude 示例：

```env
ODRADEK_ACTIVE_PROVIDER=claude
ODRADEK_CLAUDE_API_KEY=your_claude_api_key
ODRADEK_CLAUDE_BASE_URL=https://api.anthropic.com/v1
# ODRADEK_CLAUDE_MODEL=claude-sonnet-4-20250514
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

OpenRouter 示例：

```env
ODRADEK_ACTIVE_PROVIDER=openrouter
ODRADEK_OPENROUTER_API_KEY=your_openrouter_api_key
ODRADEK_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
ODRADEK_OPENROUTER_MODEL=provider/model-name
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

Qwen 示例：

```env
ODRADEK_ACTIVE_PROVIDER=qwen
ODRADEK_QWEN_API_KEY=your_dashscope_api_key
ODRADEK_QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ODRADEK_QWEN_MODEL=qwen3.5-plus
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

## 首次运行

启动已经安装好的 CLI：

```bash
odradek
```

推荐先运行的几个命令：

```text
/state
/provider
/model
/noise_eval current
```

首次启动时，Odradek 会先询问是否信任当前工作目录。之后通常只需要 `.env`、`/provider` 和 `/model` 就能把会话准备好。

## 配置参考

无论是已安装的 CLI、本地开发、CI/CD 还是内部部署，都更推荐使用环境变量或 `.env` 文件。

Windows 配置文件路径：

```text
%APPDATA%/odradek-cli/config.json
```

优先级从高到低：

1. `/model` 设置的会话级模型覆盖
2. Shell 环境变量或 `.env`
3. 本地配置文件和内置默认值

环境变量：

| 变量名 | 说明 |
| --- | --- |
| `ODRADEK_ACTIVE_PROVIDER` | 当前运行 Provider，支持 `claude` 或 `openrouter` |
| `ODRADEK_CLAUDE_API_KEY` | Claude API Key |
| `ODRADEK_CLAUDE_BASE_URL` | Claude 兼容接口地址 |
| `ODRADEK_CLAUDE_MODEL` | 默认 Claude 模型 |
| `ODRADEK_OPENROUTER_API_KEY` | OpenRouter API Key |
| `ODRADEK_OPENROUTER_BASE_URL` | OpenRouter 接口地址 |
| `ODRADEK_OPENROUTER_MODEL` | 默认 OpenRouter 模型 |
| `ODRADEK_PROJECT_CONTEXT_ENABLED` | 是否启用自动项目上下文注入 |
| `ANTHROPIC_API_KEY` | Claude 兼容 Key 的后备变量名 |
| `ANTHROPIC_BASE_URL` | Claude 兼容地址的后备变量名 |
| `OPENROUTER_API_KEY` | OpenRouter Key 的后备变量名 |

## 分层 System Prompt

Odradek 会在每次模型请求前自动加载分层的 system prompts。

工作区内的 Prompt 文件路径：

```text
.odradek/system-prompts/base.md
.odradek/system-prompts/providers/<provider>.md
.odradek/system-prompts/models/<model>.md
```

例如：

```text
.odradek/system-prompts/providers/claude.md
.odradek/system-prompts/models/claude-sonnet-4-6.md
```

加载顺序：

1. `base.md`
2. `providers/<provider>.md`
3. `models/<model>.md`

Odradek 也支持位于配置目录旁边的应用级 Prompt 目录：

```text
%APPDATA%/odradek-cli/system-prompts/
```

工作区级 Prompt 会在应用级 Prompt 之后加载，所以你可以只针对某个仓库微调行为，而不影响全局默认配置。

## 开发

只有在你想修改源码、测试未发布功能或参与贡献时，才需要走这条路径。

1. 安装依赖

```bash
npm install
```

2. 复制环境变量模板

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

3. 启动开发态 CLI

```bash
npm run dev
```

4. 在本地构建并运行发布产物

```bash
npm run build
npm start
```

5. 可选：用本地源码测试全局命令名

```bash
npm link
odradek
```

如果你想从本地联调版本切回正式发布版本，可以执行：

```bash
npm unlink -g odradek-cli
```

核心脚本：

```bash
npm run dev    # 启动开发态 CLI
npm run build  # 编译 TypeScript 到 dist/
npm start      # 运行已构建版本
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示所有可用命令 |
| `/state` | 查看工作区、运行态、配置和信任状态 |
| `/provider [claude\|openrouter\|qwen]` | 切换当前 Provider |
| `/model [model-name\|clear]` | 切换或清除当前会话模型覆盖 |
| `/trustpath` | 信任当前工作目录 |
| `/trustcheck` | 检查当前目录是否已被信任 |
| `/projectcontext [on\|off\|status]` | 控制或查看项目上下文注入状态 |
| `/skills [path]` | 扫描本地 `SKILL.md` 并显示 Skills 总览 |
| `/scan_prompt` | 扫描项目中的 Prompt、Rules、Agent 资产 |
| `/rules [path]` | 提取指定工作区里写明的 rules / instructions |
| `/scan_tokens [current\|all\|path]` | 解析 Claude JSONL 的 token 结构 |
| `/context_health [current\|all\|path]` | 查看 JSONL 里的上下文窗口健康度 |
| `/noise_eval [current\|all\|path]` | 执行 evidence-first noise evaluation |
| `/context_noise [current\|all\|path]` | `/noise_eval` 的兼容别名 |
| `/todo_granularity [current\|all\|path]` | 分析 Todo 粒度与上下文负载 |
| `/history` | 查看全部对话消息 |
| `/collapse [id\|all]` | 折叠历史消息 |
| `/expand [id\|all]` | 展开历史消息 |
| `/export [filename]` | 导出对话历史 |
| `/exit` 或 `/quit` | 退出 CLI |

## 项目结构

```text
src/
|- cli/
|- config/
|- llm/
`- index.ts
```

## 发布流程

如果你是贡献者，准备发布新的 npm 版本，请走这条路径。

1. 构建发布包

```bash
npm run build
```

2. 检查最终发布内容

```bash
npm pack --dry-run
```

3. 发布到 npm

```bash
npm publish
```

如果你使用的是 scoped public package，请使用：

```bash
npm publish --access public
```

4. 验证生产态安装路径

```bash
npx odradek-cli@latest
```

## 发布前检查

```bash
npm run build
npm pack --dry-run
```

发布前建议确认：

- 不要提交 `.env`
- 确保 `dist/` 已生成
- API Key 只通过环境变量注入
- 检查 `npm pack --dry-run` 只包含预期文件

## 反馈BUG

 你可以在 [GitHub issue](https://github.com/chaobo8484/odradek-cli/issues) 提交你遇到的 BUG 以及一些问题.如果你对项目有一些建议,你可以反馈到我下方的Email

## 关于

作为一位个人开发者.欢迎各类技术交流、项目合作以及职业邀约。请通过以下方式与我取得联系：

| 联系方式 | 地址 | 备注 |
|---------|------|------|
| Email | stratospherelabs@protonmail.com | 反馈 |
| Email | chaobo_pro at outlook dot com | 个人 |
| X (Twitter) | [@Xiayin8484](https://x.com/Xiayin8484) | 社交媒体 |

## Star 历史

<a href="https://www.star-history.com/?repos=chaobo8484%2Fodradek-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&legend=top-left" />
 </picture>
</a>