# Feature: Claude Code Context Signal Analyzer

## Overview

这是 StratoScope CLI 的核心功能模块：**Context Signal Analyzer**。

它通过解析 Claude Code 在 `~/.claude/projects/` 中留下的 JSONL 会话记录，对一次或多次 session 中消耗的 context 进行分类、量化与噪音识别，帮助开发者理解"Claude Code 在每次请求中到底摄入了什么信息"，并定位哪些信息对任务执行没有实质贡献。

---

## 数据源

### 主数据源：Session JSONL 文件

```
~/.claude/projects/<project-path-hash>/
  ├── <session-uuid>.jsonl        # 每个 session 一个文件
  ├── sessions-index.json         # session 元数据索引（摘要、token 数、时间戳）
  └── settings.json
```

**项目路径哈希规则**：将项目绝对路径中的 `/` 替换为 `-`，例如：
- `/Users/you/projects/my-app` → `-Users-you-projects-my-app`

### JSONL 行结构

每一行是一个独立的 JSON 事件对象，核心字段如下：

```json
{
  "type": "user" | "assistant",
  "uuid": "<message-uuid>",
  "parentUuid": "<parent-uuid>",
  "sessionId": "<session-uuid>",
  "timestamp": "2025-03-22T10:00:00.000Z",
  "cwd": "/path/to/project",
  "gitBranch": "main",
  "isSidechain": false,
  "message": {
    "role": "user" | "assistant",
    "content": "<string>" | [<content-block>, ...]
  }
}
```

**Content Block 类型（assistant 消息）**：

| block type     | 说明                             |
|----------------|----------------------------------|
| `text`         | 模型文字回复                     |
| `tool_use`     | 工具调用请求（含参数）           |
| `tool_result`  | 工具调用返回结果（注入至下轮上下文）|

**常见 Tool 类型**：

| tool name  | 上下文来源                           |
|------------|--------------------------------------|
| `Read`     | 读取文件内容，完整文本注入上下文     |
| `Write`    | 写入文件，参数含完整文件内容         |
| `Edit`     | 编辑文件，含 old/new 内容 diff 块   |
| `Bash`     | 执行 shell 命令，stdout/stderr 注入 |
| `LS`       | 列出目录结构，以文本形式返回         |
| `Grep`     | 文件搜索结果，含匹配行上下文         |
| `WebSearch`| 搜索结果文本片段                     |
| `TodoWrite`| 任务列表状态（每轮可能重复写入）     |

---

## 核心功能：Context 分类与噪音识别

### 1. Token 来源分类（Context Anatomy）

将一个 session 中所有注入 context 的内容按来源分类并量化：

```
┌─────────────────────────────────────────────────┐
│  Context Anatomy — Session: eb5b0174            │
│  Total estimated tokens: 48,320                 │
├──────────────────────┬──────────┬───────────────┤
│  来源类型            │ 估算 tokens │ 占比         │
├──────────────────────┼──────────┼───────────────┤
│  File Reads (Read)   │  21,400  │  44.3%        │
│  Bash Output         │  12,800  │  26.5%        │
│  User Prompts        │   5,200  │  10.8%        │
│  Assistant Text      │   4,900  │  10.1%        │
│  LS / Directory      │   2,100  │   4.3%        │
│  Grep Results        │   1,400  │   2.9%        │
│  TodoWrite           │     520  │   1.1%        │
└──────────────────────┴──────────┴───────────────┘
```

### 2. 噪音识别规则（Noise Detection）

工具基于以下规则标记潜在噪音：

**Rule N1 — 重复文件读取（Redundant Reads）**
- 同一文件在同一 session 内被 `Read` 超过 1 次
- 且两次读取之间没有对该文件的 `Write` 或 `Edit` 操作
- 后续读取标记为 `REDUNDANT`

**Rule N2 — 无关 Bash 输出（Large Unacted Output）**
- Bash 工具返回的 stdout 超过 N tokens（默认 500）
- 但该输出内容未被后续任何 assistant message 中明确引用
- 标记为 `LIKELY_NOISE`

**Rule N3 — 宽泛 LS 扫描（Broad Directory Listing）**
- `LS` 调用的目录为项目根或高层级目录
- 返回的条目数量超过阈值（默认 50 条）
- 标记为 `BROAD_SCAN`

**Rule N4 — 重复 Todo 注入（TodoWrite Repetition）**
- `TodoWrite` 的内容在连续多轮中基本不变（相似度 > 90%）
- 重复轮次标记为 `STALE_INJECT`

**Rule N5 — 低利用率文件（Low-Utilization Read）**
- 文件被完整读入（`Read` 工具），但 token 量大
- 后续 assistant 的引用行数 < 文件总行数的 10%
- 标记为 `LOW_UTILIZATION`

### 3. Signal 识别

高信号内容为以下情形：
- 被 assistant 直接引用、修改或讨论的文件内容
- 导致代码变更（`Write`/`Edit`）的 Bash 输出
- 用户明确指令（User Prompt）
- CLAUDE.md 注入的项目指令

---

## CLI 接口设计

### 命令结构

```bash
# 分析当前项目最近一次 session
stratoscope analyze

# 分析指定项目目录
stratoscope analyze --project /path/to/project

# 分析指定 session ID
stratoscope analyze --session <session-uuid>

# 分析最近 N 次 session 的汇总趋势
stratoscope analyze --last 5

# 只输出噪音报告
stratoscope analyze --noise-only

# 输出为 JSON（供管道使用）
stratoscope analyze --format json
```

### 输出格式示例（默认 Terminal 视图）

```
╔══════════════════════════════════════════════════════╗
║  StratoScope — Context Analysis                     ║
║  Project: my-app   Session: eb5b01...  2025-03-22   ║
╚══════════════════════════════════════════════════════╝

📊 Context Anatomy
─────────────────────────────────────────────────
  File Reads          ████████████████░░░░  44%  21.4k tok
  Bash Output         █████████░░░░░░░░░░░  27%  12.8k tok
  User Prompts        ███░░░░░░░░░░░░░░░░░  11%   5.2k tok
  Assistant Text      ███░░░░░░░░░░░░░░░░░  10%   4.9k tok
  Other               ██░░░░░░░░░░░░░░░░░░   8%   3.9k tok

⚠️  Noise Signals Detected (3)
─────────────────────────────────────────────────
  [N1] REDUNDANT READ   src/utils/parser.ts     × 3 reads,  ~2,100 tok wasted
  [N3] BROAD_SCAN       LS /  (root, 87 entries)  ~900 tok
  [N5] LOW_UTILIZATION  package-lock.json       3,200 tok read, ~2 lines used

✅  High-Signal Content
─────────────────────────────────────────────────
  src/components/Editor.tsx    → edited 2×, high reference density
  User prompt turn 3           → triggered 4 tool calls
  CLAUDE.md                    → injected once, high instruction density

💡 Optimization Suggestions
─────────────────────────────────────────────────
  → Add package-lock.json to .claudeignore
  → Replace root LS with targeted path reads
  → Use Read-on-demand pattern for parser.ts
```

---

## 实现路径

### Phase 1 — JSONL 解析器（核心）

**输入**：一个 `.jsonl` session 文件路径  
**输出**：结构化的 `SessionTrace` 对象

```typescript
interface SessionTrace {
  sessionId: string;
  projectPath: string;
  turns: Turn[];
}

interface Turn {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string;
  textBlocks: TextBlock[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}

interface ToolCall {
  id: string;
  name: string;           // 'Read' | 'Bash' | 'LS' | 'Edit' | 'Write' | ...
  input: Record<string, unknown>;
  estimatedInputTokens: number;
}

interface ToolResult {
  toolCallId: string;
  content: string;
  estimatedTokens: number;
}
```

### Phase 2 — Token 估算器

由于 JSONL 中不总含精确 token 数，使用以下策略：
- 优先读取 `sessions-index.json` 中的 token usage 字段
- 降级方案：按 `chars / 4` 粗估（对于英文代码上下文误差在 ±15% 内）
- 对中文内容使用 `chars / 2` 估算

### Phase 3 — 噪音分析器

对 `SessionTrace` 运行规则引擎（N1–N5），每条规则输出：

```typescript
interface NoiseSignal {
  rule: 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
  severity: 'high' | 'medium' | 'low';
  target: string;          // 文件路径、工具名等
  wastedTokens: number;    // 估算浪费的 token 数
  recommendation: string;
}
```

### Phase 4 — CLI 渲染层

使用 `ink`（React for CLIs）或 `blessed` 实现终端 UI，支持：
- 颜色高亮 + ASCII 进度条
- 交互式 drill-down（按 Enter 展开某条噪音信号的详情）
- `--format json` 输出供下游管道消费

---

## 边界条件与限制

| 场景 | 处理方式 |
|------|----------|
| Session 经过 compaction | 检测 compaction 标记，在报告中注明"部分上下文已压缩，分析不完整" |
| Subagent session（isSidechain: true）| 单独标注，支持 `--include-agents` 合并分析 |
| 文件不存在 / 权限问题 | 跳过该 session，输出 warning |
| token 数超过 200k（长 session）| 自动分段分析，按 turn 区间报告 |

---

## 成功指标

- 解析一个 10MB JSONL 文件 < 2 秒
- 噪音识别准确率（人工校验）> 80%
- 用户能在 30 秒内定位"最大噪音来源"并采取对应优化行动