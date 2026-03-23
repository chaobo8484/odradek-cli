# Context 消耗 × Todo 粒度相关性分析

> 本文件描述 StratoScope 的一个核心分析模块。  
> 阅读对象：AI agent。请在实现任何相关功能前完整阅读本文件。

---

## 一句话描述

**分析 Claude Code 中 todo 任务的描述粒度，与该任务执行期间 context 窗口消耗量之间的统计相关性，从而给出 todo 拆分粒度的优化建议。**

---

## 核心假设（需通过数据验证）

| 假设 | 预期方向 | 验证方法 |
|------|----------|----------|
| 粗粒度 todo 导致更高的 context 消耗 | 正相关 | 计算粒度分数与 token 消耗的 Pearson 相关系数 |
| 粗粒度 todo 更容易触发 context 截断 | 正相关 | 统计截断事件在各粒度区间的分布 |
| 细粒度 todo 完成率更高 | 负相关 | 对比各粒度区间的 completionRate |
| 粗粒度 todo 更容易卡住（stuck） | 正相关 | 对比各粒度区间的 stuckInProgress 比率 |

> ⚠️ agent 注意：以上均为假设，不要在代码中硬编码结论。分析结果应原样输出，由用户判断。

---

## 概念定义

### Todo 粒度（Granularity）

粒度是对一个 todo 任务"范围大小"的量化评分，范围 **1–5**：

| 分值 | 含义 | 典型示例 |
|------|------|----------|
| 1 | 极细：单一、可验证的操作 | "修复 `reader.js` 第 42 行的空指针" |
| 2 | 细：单函数 / 单文件范围 | "给 `analyzeCompletion` 加单元测试" |
| 3 | 中：单模块 / 单功能范围 | "实现 `blocking.js` 的阻断检测逻辑" |
| 4 | 粗：跨模块 / 多文件 | "重构整个 analyzer 层，统一错误处理" |
| 5 | 极粗：系统级 / 架构级 | "把 CLI 工具改造成支持插件的平台" |

### Context 消耗（Context Usage）

单次 todo 执行期间，Claude Code session 消耗的 token 数。

数据来源优先级：
1. Claude Code session 日志中的 `usage.input_tokens` + `usage.output_tokens`
2. 若日志不可用，用**会话持续时长作为代理指标**（duration_min）

### 截断事件（Truncation Event）

session 日志中出现以下任一信号，判定为发生了 context 截断：
- 日志包含 `"context_window_exceeded"` 或类似错误字段
- `usage.input_tokens` 超过模型上下文上限的 **85%**（保守阈值）
- 会话中出现"我需要你提供之前的内容"类语义（需 NLP 判断，当前阶段可跳过）

---

## 数据来源与获取方式

### 所需数据

```
1. Todo 列表            ← ~/.claude/todos/<session_id>.json
2. Session 使用日志     ← ~/.claude/logs/<session_id>.jsonl  （待确认路径）
3. 两者的关联键         ← session_id（todo 文件名即 session_id）
```

### 关联逻辑

```
session_id
    ├── todos/<session_id>.json   → 该 session 的所有 todo 条目
    └── logs/<session_id>.jsonl   → 该 session 的 token 使用记录
```

每个 todo 与 session 日志通过 `session_id` + `时间区间` 关联：

```
todo.createdAt  ──┐
                  ├──→ 筛选该时间窗口内的日志行 → 累计 token 消耗
todo.completedAt ─┘
```

> ⚠️ agent 注意：日志路径和字段名**尚未实地验证**。  
> 实现前必须先运行探针脚本确认（见"第一步"章节）。

---

## 粒度评分算法

### 方案 A：规则启发式（推荐用于 MVP）

对 todo 的 `content` 文本提取以下特征，加权求和得到粒度分：

```javascript
function scoreGranularity(content) {
  let score = 1; // 基础分

  // 特征 1：动词范围
  const broadVerbs = ['重构', '改造', '迁移', '优化整个', '统一', 'refactor', 'migrate', 'redesign'];
  const narrowVerbs = ['修复', '修改', '添加', '删除', '更新', '补充', 'fix', 'add', 'remove', 'update'];
  if (broadVerbs.some(v => content.includes(v))) score += 2;
  else if (narrowVerbs.some(v => content.includes(v))) score += 0;

  // 特征 2：涉及文件/模块数量（通过连接词推断）
  const multiFileSignals = ['整个', '所有', '全部', 'all', 'entire', '层', 'layer', '系统', 'system'];
  if (multiFileSignals.some(s => content.includes(s))) score += 1;

  // 特征 3：文本长度（粗任务描述往往更长）
  if (content.length > 50) score += 0.5;
  if (content.length > 100) score += 0.5;

  // 特征 4：包含具体文件名 / 函数名（细粒度信号）
  const hasSpecificRef = /[`'"][\w./]+[`'"]/.test(content) || /第\s*\d+\s*行/.test(content);
  if (hasSpecificRef) score -= 1;

  return Math.max(1, Math.min(5, Math.round(score)));
}
```

### 方案 B：LLM 评分（精度更高，成本更高）

调用 Claude API，让模型对 todo 内容打粒度分：

```javascript
// 系统 prompt
const GRANULARITY_SYSTEM = `
你是一个分析开发任务粒度的助手。
给定一个 todo 任务描述，输出 1-5 的粒度分：
1=极细（单行/单函数）2=细（单文件）3=中（单模块）4=粗（跨模块）5=极粗（架构级）
只输出数字，不要解释。
`.trim();

// 调用示例
const score = await callClaude(GRANULARITY_SYSTEM, todo.content);
```

> MVP 阶段优先使用方案 A，方案 B 作为 `--llm-score` flag 的可选增强。

---

## 模块设计

### 新增文件

```
src/analyzer/
├── completion.js       # 已有
├── blocking.js         # 已有
├── granularity.js      # 【新增】粒度评分
├── context_usage.js    # 【新增】context 消耗提取
└── correlation.js      # 【新增】相关性计算 & 建议生成
```

### granularity.js 职责

- 输入：todo 数组
- 输出：每个 todo 附加 `granularityScore: 1-5` 字段
- 暴露：`scoreGranularity(content: string): number`

### context_usage.js 职责

- 输入：session_id
- 输出：该 session 的 `{ totalTokens, inputTokens, outputTokens, truncated: boolean }`
- 若日志不存在：返回 `null`，调用方需处理缺失值

### correlation.js 职责

- 输入：带有 `granularityScore` 和 `contextUsage` 的 todo 数组
- 输出：
  ```javascript
  {
    pearsonR: number,          // 粒度 vs token 消耗的相关系数
    truncationByGranularity: { // 各粒度区间的截断率
      1: 0.02, 2: 0.05, 3: 0.12, 4: 0.31, 5: 0.58
    },
    completionByGranularity: { // 各粒度区间的完成率
      1: 0.95, 2: 0.88, ...
    },
    suggestions: Suggestion[]  // 优化建议
  }
  ```

### Suggestion 数据结构

```typescript
interface Suggestion {
  todoId: string;
  content: string;          // 原始 todo 文本
  granularityScore: number; // 当前粒度分
  reason: string;           // 为什么建议拆分
  splitHint: string;        // 拆分方向提示（自然语言）
}
```

---

## CLI 命令扩展

```bash
# 新增子命令
strato analyze --granularity          # 输出粒度分析报告
strato analyze --granularity --llm-score  # 使用 LLM 打分（需 API Key）
strato suggest                         # 仅输出待拆分的 todo 建议列表
```

### 报告输出格式

```
╔══════════════════════════════════════════════╗
║   StratoScope · Context × Granularity Report  ║
╚══════════════════════════════════════════════╝

📐 Granularity Distribution (52 todos)
  Score 1 ████████░░░░░░░░  8  (15%)
  Score 2 █████████████░░░  18  (35%)
  Score 3 ██████░░░░░░░░░░  12  (23%)
  Score 4 ████░░░░░░░░░░░░   9  (17%)
  Score 5 ██░░░░░░░░░░░░░░   5  (10%)

📈 Correlation: Granularity → Context Usage
  Pearson R = 0.71  (strong positive)
  → 粒度越粗，context 消耗越高，相关性显著

⚡ Truncation Rate by Granularity
  Score 1-2  ██░░░░░░░░  3.5%
  Score 3    ████░░░░░░  12%
  Score 4-5  █████████░  44%

🔧 Split Suggestions (4 todos)
  ① "重构整个 analyzer 层，统一错误处理"  [score: 4]
     → 建议拆为：(a) 梳理现有错误处理模式
                 (b) 定义统一错误类型
                 (c) 逐模块替换

  ② "优化 CLI 的整体用户体验"  [score: 5]
     → 过于宽泛，建议先列出具体体验问题再拆分
```

---

## 实现顺序（agent 请按此顺序执行）

```
Step 1  【探针】确认 session 日志路径与字段结构
        → 写 probe_logs.js，打印日志文件样本

Step 2  【context_usage.js】实现日志读取与 token 统计
        → 先处理"日志存在"的路径，null 处理留到最后

Step 3  【granularity.js】实现规则启发式评分（方案 A）
        → 用 5 条真实 todo 手动验证打分是否合理

Step 4  【correlation.js】实现 Pearson 相关系数计算
        → 用 simple-statistics 库，不要手写统计公式

Step 5  【reporter.js 扩展】添加粒度报告的渲染逻辑

Step 6  【bin/strato.js 扩展】注册 --granularity flag

Step 7  【可选】实现方案 B LLM 打分，加在 --llm-score flag 后
```

---

## 依赖清单

```bash
npm install simple-statistics   # Pearson 相关系数计算
# chalk、cli-table3、commander 已在主模块安装
```

---

## 边界情况处理规范

| 情况 | 处理方式 |
|------|----------|
| todo 无对应 session 日志 | `contextUsage = null`，排除在相关性计算之外，但保留在粒度分布统计中 |
| session 跨越多个 todo | 按时间窗口比例分配 token（简化：均分） |
| 样本量 < 10 | 不输出相关系数，输出警告："样本量不足，结果仅供参考" |
| 粒度评分歧义（规则冲突） | 就高不就低，并在 `--verbose` 模式下输出评分细节 |
| LLM 打分返回非数字 | 回退到规则评分（方案 A），记录 warn |

---

## 与其他模块的关系

```
reader.js          →  提供原始 todo 数组
granularity.js     →  为每个 todo 附加 granularityScore
context_usage.js   →  为每个 todo 附加 contextUsage
correlation.js     →  消费以上两个字段，输出分析结果
blocking.js        →  可复用：粒度高的 todo 与 stuckInProgress 的交集是重点关注对象
reporter.js        →  渲染最终报告
```

---

## 未来扩展方向（当前阶段不实现）

- 与 ContextLens 对接：将粒度 × context 数据导出为 ContextLens 可读的 JSON 格式
- 时序分析：粒度偏好是否随项目推进而变化
- 跨项目对比：不同项目的粒度基线差异
- 自动拆分建议：调用 LLM 直接生成拆分后的 todo 列表（而非仅提示）

---

## 待确认项（实现前必须解决）

- [ ] `~/.claude/logs/` 路径是否存在，文件格式是 JSONL 还是 JSON
- [ ] session 日志中 token 消耗的确切字段名（`usage.input_tokens`？`tokens_used`？）
- [ ] 截断事件是否有明确的日志字段，还是需要用阈值推断
- [ ] `in_progress` 状态的进入时间字段名（同 CLAUDE.md 中的待确认项）