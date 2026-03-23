# Aeris

[![License](https://img.shields.io/github/license/chaobo8484/aeris-cli)](https://github.com/chaobo8484/aeris-cli/blob/main/LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-7C3AED?style=for-the-badge&logo=anthropic&logoColor=white)
[![X (formerly Twitter)](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Xiayin8484)

[English](README.md) | **简体中文**


用于分析、增强和诊断 Claude Code / Agent 工作流的 CLI 工具。

## 功能特性

- 交互式命令行聊天界面
- `/` 命令提示、方向键切换、`Tab` 自动补全
- 对话历史查看、折叠与展开
- Claude 模型配置、本地 API Key 管理与模型切换
- 当前工作目录信任检查
- 项目 Prompt / Rules / Agent 资产扫描
- Claude JSONL Token 结构分析与上下文健康检查
- 可选的 Project Context 注入

## 环境要求

- Node.js `>= 18`
- npm `>= 9`

## 安装

```bash
npm install
```

## 初始化配置

推荐优先使用环境变量或 `.env` 文件，便于本地开发、CI/CD 与服务器部署。

1. 复制示例配置

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

1. 填写 Claude API 信息

```env
AERIS_CLAUDE_API_KEY=your_api_key
AERIS_CLAUDE_BASE_URL=https://api.anthropic.com/v1
AERIS_CLAUDE_MODEL=your_claude_model
AERIS_PROJECT_CONTEXT_ENABLED=true
```

1. 启动项目

```bash
npm run dev
```

也可在 CLI 内通过 `/modelconfig` 写入本地配置文件。

**Windows 本地配置路径：**

```text
%APPDATA%/aeris-cli/config.json
```

**配置优先级（从高到低）：**

1. 系统环境变量 / `.env`
2. 本地配置文件（`/modelconfig`）
3. 内置默认值

**支持的环境变量：**


| 变量                              | 说明                 |
| ------------------------------- | ------------------ |
| `AERIS_CLAUDE_API_KEY`          | Claude API 密钥      |
| `AERIS_CLAUDE_BASE_URL`         | API 基础地址           |
| `AERIS_CLAUDE_MODEL`            | 模型名称               |
| `AERIS_PROJECT_CONTEXT_ENABLED` | 是否启用项目上下文          |
| `ANTHROPIC_API_KEY`             | 兼容 Anthropic 的密钥   |
| `ANTHROPIC_BASE_URL`            | 兼容 Anthropic 的基础地址 |


## 常用命令

```bash
npm run dev    # 开发
npm run build  # 生产构建
npm start      # 运行构建产物
```

首次启动时，Aeris 会要求确认是否信任当前工作目录。之后可通过 `/modelconfig`、`/apikey` 和 `/model` 调整运行配置。

## CLI 命令


| 命令                                       | 说明                           |
| ---------------------------------------- | ---------------------------- |
| `/help`                                  | 显示帮助                         |
| `/clear`                                 | 清空对话历史                       |
| `/history`                               | 显示全部消息                       |
| `/collapse [id 或 all]`                   | 折叠消息                         |
| `/expand [id 或 all]`                     | 展开消息                         |
| `/exit` / `/quit`                        | 退出程序                         |
| `/modelconfig`                           | 配置 Claude API 参数             |
| `/apikey [密钥或 clear]`                    | 更新或清除本地 API Key              |
| `/model [模型名]`                           | 切换当前模型                       |
| `/trustpath`                             | 信任当前工作目录                     |
| `/trustcheck`                            | 检查当前目录是否已信任                  |
| `/projectcontext [on、off 或 status]`      | 控制项目上下文注入                    |
| `/scan_prompt`                           | 扫描 Prompt / Rules / Agent 资产 |
| `/scan_tokens [current、all 或 path]`      | 解析 Claude JSONL Token 结构     |
| `/context_health [current、all 或 path]`   | 评估上下文窗口健康度                   |
| `/context_noise [current、all 或 path]`    | 分析上下文噪音                      |
| `/todo_granularity [current、all 或 path]` | 分析 Todo 粒度与上下文负载             |


## 项目结构

```text
src/
├─ cli/
├─ config/
├─ llm/
└─ index.ts
```

## 发布前检查

```bash
npm run build
npm pack --dry-run
```

建议确认：

- `.env` 未提交到仓库
- 已生成 `dist/` 构建产物
- API Key 仅通过环境变量或本地配置注入
- `npm pack --dry-run` 产物中只包含必要文件

