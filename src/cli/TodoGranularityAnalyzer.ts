import { promises as fs } from 'fs';
import path from 'path';

export type TodoGranularityTarget = {
  sessionId: string;
  filePath: string;
};

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'unknown';

export type TodoContextUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  truncated: boolean;
  recordCount: number;
  source: 'window' | 'session' | 'equal_share';
};

export type TodoGranularitySuggestion = {
  todoId: string;
  content: string;
  granularityScore: number;
  reason: string;
  splitHint: string;
  sessionId: string;
  contextTokens: number | null;
};

export type TodoGranularityItem = {
  sessionId: string;
  todoId: string;
  content: string;
  status: TodoStatus;
  rawStatus: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  completedAtMs: number | null;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  source: 'todo_file' | 'jsonl_snapshot';
  granularityScore: number;
  granularitySignals: string[];
  contextUsage: TodoContextUsage | null;
};

export type TodoGranularityBucket = {
  score: number;
  count: number;
  share: number;
  truncationRate: number | null;
  completionRate: number | null;
  stuckRate: number | null;
};

export type TodoGranularityAnalysis = {
  items: TodoGranularityItem[];
  buckets: TodoGranularityBucket[];
  suggestions: TodoGranularitySuggestion[];
  warnings: string[];
  sessionsScanned: number;
  sessionsWithTodos: number;
  sessionsWithTodoFiles: number;
  sessionsUsingSnapshotFallback: number;
  todoFilesFound: number;
  todosWithContext: number;
  pearsonR: number | null;
  correlationLabel: string;
};

type AnalyzerOptions = {
  todosRoot: string | null;
};

type TodoSeed = {
  sessionId: string;
  todoId: string;
  content: string;
  status: TodoStatus;
  rawStatus: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  completedAtMs: number | null;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  source: 'todo_file' | 'jsonl_snapshot';
};

type UsageRecord = {
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  contextUsedPercent: number | null;
  contextWindowTokens: number | null;
  truncated: boolean;
};

export class TodoGranularityAnalyzer {
  private readonly todosRoot: string | null;

  constructor(options: AnalyzerOptions) {
    this.todosRoot = options.todosRoot;
  }

  async analyze(targets: TodoGranularityTarget[]): Promise<TodoGranularityAnalysis> {
    const warnings: string[] = [];
    const todoFileIndex = await this.buildTodoFileIndex();
    const items: TodoGranularityItem[] = [];

    let sessionsWithTodos = 0;
    let sessionsWithTodoFiles = 0;
    let sessionsUsingSnapshotFallback = 0;

    for (const target of targets) {
      const todoFilePath = todoFileIndex.get(target.sessionId) ?? null;
      if (todoFilePath) {
        sessionsWithTodoFiles += 1;
      }

      let todoSeeds = todoFilePath ? await this.readTodoSeedsFromFile(todoFilePath, target.sessionId) : [];
      if (todoSeeds.length === 0) {
        const fallbackSeeds = await this.readTodoSeedsFromJsonlSnapshots(target.filePath, target.sessionId);
        if (fallbackSeeds.length > 0) {
          todoSeeds = fallbackSeeds;
          sessionsUsingSnapshotFallback += 1;
        }
      }

      if (todoSeeds.length === 0) {
        continue;
      }

      sessionsWithTodos += 1;
      const usageRecords = await this.readUsageRecords(target.filePath);
      const sessionTotals = this.sumUsage(usageRecords);
      const sessionBounds = this.getUsageBounds(usageRecords);

      for (const todoSeed of todoSeeds) {
        const scoreOutcome = this.scoreGranularity(todoSeed.content);
        const contextUsage = this.assignContextUsage(todoSeed, usageRecords, sessionTotals, sessionBounds, todoSeeds.length);
        items.push({
          ...todoSeed,
          granularityScore: scoreOutcome.score,
          granularitySignals: scoreOutcome.signals,
          contextUsage,
        });
      }
    }

    if (!this.todosRoot) {
      warnings.push('Could not find ~/.claude/todos, so the analysis used session JSONL snapshots only.');
    }

    if (items.length === 0) {
      warnings.push(
        'No analyzable todo data was found. The current Claude sessions may have empty todo files, or no todo snapshots were written.'
      );
    }

    const todosWithContext = items.filter((item) => item.contextUsage !== null).length;
    const pearsonR = this.computePearson(
      items
        .filter((item) => item.contextUsage !== null)
        .map((item) => [item.granularityScore, item.contextUsage?.totalTokens ?? 0] as const)
    );
    const correlationLabel = this.describeCorrelation(pearsonR);
    const buckets = this.buildBuckets(items);
    const suggestions = this.buildSuggestions(items);

    if (items.length > 0 && items.length < 10) {
      warnings.push('Fewer than 10 todos were found, so treat the correlation as directional rather than conclusive.');
    }
    if (todosWithContext === 0 && items.length > 0) {
      warnings.push('Todos were found, but there were not enough usage/token records to attribute context usage.');
    }

    return {
      items,
      buckets,
      suggestions,
      warnings,
      sessionsScanned: targets.length,
      sessionsWithTodos,
      sessionsWithTodoFiles: Math.min(sessionsWithTodoFiles, targets.length),
      sessionsUsingSnapshotFallback,
      todoFilesFound: todoFileIndex.size,
      todosWithContext,
      pearsonR,
      correlationLabel,
    };
  }

  private async buildTodoFileIndex(): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    if (!this.todosRoot) {
      return index;
    }

    let entries: Array<{ name: string; fullPath: string }> = [];
    try {
      const dirEntries = await fs.readdir(this.todosRoot, { withFileTypes: true });
      entries = dirEntries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map((entry) => ({ name: entry.name, fullPath: path.join(this.todosRoot as string, entry.name) }));
    } catch {
      return index;
    }

    for (const entry of entries) {
      const sessionId = this.extractSessionIdFromTodoFileName(entry.name);
      if (sessionId && !index.has(sessionId)) {
        index.set(sessionId, entry.fullPath);
      }
    }

    return index;
  }

  private extractSessionIdFromTodoFileName(fileName: string): string {
    const match = fileName.match(/^([0-9a-f-]{36})(?:-agent-\1)?\.json$/i);
    if (match) {
      return match[1];
    }
    const loose = fileName.match(/^([0-9a-f-]{36})/i);
    return loose ? loose[1] : '';
  }

  private async readTodoSeedsFromFile(filePath: string, sessionId: string): Promise<TodoSeed[]> {
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : [];
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item, index) => this.normalizeTodoSeed(item, sessionId, 'todo_file', index))
      .filter((item): item is TodoSeed => item !== null);
  }

  private async readTodoSeedsFromJsonlSnapshots(filePath: string, sessionId: string): Promise<TodoSeed[]> {
    let raw = '';
    let fileTimestampMs = 0;
    try {
      raw = await fs.readFile(filePath, 'utf8');
      const stat = await fs.stat(filePath);
      fileTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    } catch {
      return [];
    }

    const snapshots = new Map<string, TodoSeed>();
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index += 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]) as unknown;
      } catch {
        continue;
      }

      const timestampMs = this.extractTimestampMs(parsed) || fileTimestampMs;
      const todos = this.extractTodosArray(parsed);
      if (!todos || todos.length === 0) {
        continue;
      }

      todos.forEach((item, itemIndex) => {
        const normalized = this.normalizeTodoSeed(item, sessionId, 'jsonl_snapshot', itemIndex);
        if (!normalized) {
          return;
        }

        const snapshotSeed: TodoSeed = {
          ...normalized,
          firstSeenAtMs: normalized.firstSeenAtMs ?? timestampMs,
          lastSeenAtMs: normalized.lastSeenAtMs ?? timestampMs,
          createdAtMs: normalized.createdAtMs ?? timestampMs,
          updatedAtMs: normalized.updatedAtMs ?? timestampMs,
          completedAtMs: normalized.completedAtMs,
        };
        const key = this.buildTodoSnapshotKey(snapshotSeed);
        const existing = snapshots.get(key);
        if (!existing) {
          snapshots.set(key, snapshotSeed);
          return;
        }

        existing.content = snapshotSeed.content || existing.content;
        existing.rawStatus = snapshotSeed.rawStatus || existing.rawStatus;
        existing.status =
          snapshotSeed.status !== 'unknown'
            ? snapshotSeed.status
            : existing.status !== 'unknown'
            ? existing.status
            : 'unknown';
        existing.createdAtMs = this.minTimestamp(existing.createdAtMs, snapshotSeed.createdAtMs);
        existing.updatedAtMs = this.maxTimestamp(existing.updatedAtMs, snapshotSeed.updatedAtMs ?? timestampMs);
        existing.firstSeenAtMs = this.minTimestamp(existing.firstSeenAtMs, snapshotSeed.firstSeenAtMs ?? timestampMs);
        existing.lastSeenAtMs = this.maxTimestamp(existing.lastSeenAtMs, snapshotSeed.lastSeenAtMs ?? timestampMs);
        existing.completedAtMs = this.maxTimestamp(existing.completedAtMs, snapshotSeed.completedAtMs);
      });
    }

    return Array.from(snapshots.values()).map((seed) => {
      if (seed.status === 'completed' && seed.completedAtMs === null) {
        return {
          ...seed,
          completedAtMs: seed.lastSeenAtMs ?? seed.updatedAtMs,
        };
      }
      return seed;
    });
  }

  private buildTodoSnapshotKey(seed: TodoSeed): string {
    const normalizedContent = seed.content.trim().toLowerCase();
    if (seed.todoId && !seed.todoId.startsWith('todo-')) {
      return seed.todoId;
    }
    return `${seed.sessionId}:${normalizedContent}`;
  }

  private normalizeTodoSeed(
    payload: unknown,
    sessionId: string,
    source: 'todo_file' | 'jsonl_snapshot',
    index: number
  ): TodoSeed | null {
    if (typeof payload === 'string') {
      const content = payload.trim();
      if (!content) {
        return null;
      }
      return {
        sessionId,
        todoId: `todo-${index + 1}`,
        content,
        status: 'unknown',
        rawStatus: '',
        createdAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        firstSeenAtMs: null,
        lastSeenAtMs: null,
        source,
      };
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const content =
      this.getStringAtPaths(record, [
        ['content'],
        ['text'],
        ['title'],
        ['task'],
        ['description'],
        ['message'],
      ]) ?? '';
    if (!content.trim()) {
      return null;
    }

    const todoId =
      this.getStringAtPaths(record, [['id'], ['todoId'], ['uuid'], ['key']]) ??
      `todo-${index + 1}-${this.slugify(content).slice(0, 18)}`;
    const rawStatus =
      this.getStringAtPaths(record, [['status'], ['state'], ['phase'], ['todoStatus']]) ??
      (record.completed === true ? 'completed' : '');
    const status = this.normalizeStatus(rawStatus, record);

    const createdAtMs = this.getTimestampAtPaths(record, [
      ['createdAt'],
      ['created_at'],
      ['startedAt'],
      ['startTime'],
      ['addedAt'],
    ]);
    const updatedAtMs = this.getTimestampAtPaths(record, [
      ['updatedAt'],
      ['updated_at'],
      ['lastUpdatedAt'],
      ['modifiedAt'],
      ['modified_at'],
    ]);
    const completedAtMs = this.getTimestampAtPaths(record, [
      ['completedAt'],
      ['completed_at'],
      ['finishedAt'],
      ['doneAt'],
      ['done_at'],
    ]);

    return {
      sessionId,
      todoId,
      content: content.trim(),
      status,
      rawStatus,
      createdAtMs,
      updatedAtMs,
      completedAtMs,
      firstSeenAtMs: createdAtMs,
      lastSeenAtMs: updatedAtMs ?? completedAtMs,
      source,
    };
  }

  private normalizeStatus(rawStatus: string, record: Record<string, unknown>): TodoStatus {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized) {
      if (/(done|complete|completed|finished|closed|resolved)/i.test(normalized)) {
        return 'completed';
      }
      if (/(progress|doing|active|running|started)/i.test(normalized)) {
        return 'in_progress';
      }
      if (/(todo|pending|open|queued|ready)/i.test(normalized)) {
        return 'pending';
      }
    }

    if (record.completed === true || record.done === true) {
      return 'completed';
    }

    return 'unknown';
  }

  private async readUsageRecords(filePath: string): Promise<UsageRecord[]> {
    let raw = '';
    let fileTimestampMs = 0;
    try {
      raw = await fs.readFile(filePath, 'utf8');
      const stat = await fs.stat(filePath);
      fileTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    } catch {
      return [];
    }

    const records: UsageRecord[] = [];
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      const record = this.extractUsageRecord(parsed, line, fileTimestampMs);
      if (record) {
        records.push(record);
      }
    }

    return records.sort((a, b) => a.timestampMs - b.timestampMs);
  }

  private extractUsageRecord(payload: unknown, rawLine: string, fileTimestampMs: number): UsageRecord | null {
    const usageObject =
      this.getObjectAtPath(payload, ['message', 'usage']) ??
      this.getObjectAtPath(payload, ['usage']) ??
      this.getObjectAtPath(payload, ['response', 'usage']);

    const inputTokens = this.getNumberAtPaths(usageObject, [['input_tokens'], ['inputTokens']]) ?? 0;
    const outputTokens = this.getNumberAtPaths(usageObject, [['output_tokens'], ['outputTokens']]) ?? 0;
    const cacheCreationTokens =
      this.getNumberAtPaths(usageObject, [['cache_creation_input_tokens'], ['cacheCreationInputTokens']]) ?? 0;
    const cacheReadTokens =
      this.getNumberAtPaths(usageObject, [['cache_read_input_tokens'], ['cacheReadInputTokens']]) ?? 0;
    const contextUsedPercent =
      this.getNumberAtPaths(payload, [
        ['stdin', 'context_window', 'used_percentage'],
        ['context_window', 'used_percentage'],
        ['contextWindow', 'usedPercentage'],
        ['current_usage', 'used_percentage'],
      ]) ?? null;
    const contextWindowTokens =
      this.getNumberAtPaths(payload, [
        ['stdin', 'context_window', 'max_tokens'],
        ['context_window', 'max_tokens'],
        ['contextWindow', 'maxTokens'],
      ]) ?? null;

    const truncated = this.detectTruncation(payload, rawLine, contextUsedPercent);
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    if (totalTokens <= 0 && !truncated && contextUsedPercent === null) {
      return null;
    }

    return {
      timestampMs: this.extractTimestampMs(payload) || fileTimestampMs,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens,
      contextUsedPercent,
      contextWindowTokens,
      truncated,
    };
  }

  private detectTruncation(payload: unknown, rawLine: string, contextUsedPercent: number | null): boolean {
    if (contextUsedPercent !== null && contextUsedPercent >= 85) {
      return true;
    }

    const joined = JSON.stringify(payload) + rawLine;
    return /(context_window_exceeded|maximum context length|prompt is too long|truncat|autocompact)/i.test(joined);
  }

  private sumUsage(records: UsageRecord[]): TodoContextUsage {
    return records.reduce<TodoContextUsage>(
      (sum, record) => ({
        totalTokens: sum.totalTokens + record.totalTokens,
        inputTokens: sum.inputTokens + record.inputTokens,
        outputTokens: sum.outputTokens + record.outputTokens,
        cacheCreationTokens: sum.cacheCreationTokens + record.cacheCreationTokens,
        cacheReadTokens: sum.cacheReadTokens + record.cacheReadTokens,
        truncated: sum.truncated || record.truncated,
        recordCount: sum.recordCount + 1,
        source: 'session',
      }),
      {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        truncated: false,
        recordCount: 0,
        source: 'session',
      }
    );
  }

  private getUsageBounds(records: UsageRecord[]): { startMs: number | null; endMs: number | null } {
    if (records.length === 0) {
      return { startMs: null, endMs: null };
    }

    return {
      startMs: records[0].timestampMs,
      endMs: records[records.length - 1].timestampMs,
    };
  }

  private assignContextUsage(
    todo: TodoSeed,
    usageRecords: UsageRecord[],
    sessionTotals: TodoContextUsage,
    sessionBounds: { startMs: number | null; endMs: number | null },
    sessionTodoCount: number
  ): TodoContextUsage | null {
    if (usageRecords.length === 0 || sessionTotals.totalTokens <= 0) {
      return null;
    }

    const windowStart =
      todo.createdAtMs ??
      todo.firstSeenAtMs ??
      todo.updatedAtMs ??
      todo.lastSeenAtMs ??
      sessionBounds.startMs;
    let windowEnd =
      todo.completedAtMs ??
      todo.updatedAtMs ??
      todo.lastSeenAtMs ??
      todo.firstSeenAtMs ??
      sessionBounds.endMs;

    if (windowStart === null) {
      return sessionTodoCount === 1 ? sessionTotals : this.buildEqualShareUsage(sessionTotals, sessionTodoCount);
    }
    if (windowEnd === null || windowEnd < windowStart) {
      windowEnd = sessionBounds.endMs ?? windowStart;
    }

    const relevant = usageRecords.filter((record) => record.timestampMs >= windowStart && record.timestampMs <= windowEnd);
    if (relevant.length > 0) {
      const summed = this.sumUsage(relevant);
      return { ...summed, source: 'window' };
    }

    if (sessionTodoCount === 1) {
      return sessionTotals;
    }

    return this.buildEqualShareUsage(sessionTotals, sessionTodoCount);
  }

  private buildEqualShareUsage(sessionTotals: TodoContextUsage, sessionTodoCount: number): TodoContextUsage | null {
    if (sessionTodoCount <= 0 || sessionTotals.totalTokens <= 0) {
      return null;
    }

    return {
      totalTokens: Math.round(sessionTotals.totalTokens / sessionTodoCount),
      inputTokens: Math.round(sessionTotals.inputTokens / sessionTodoCount),
      outputTokens: Math.round(sessionTotals.outputTokens / sessionTodoCount),
      cacheCreationTokens: Math.round(sessionTotals.cacheCreationTokens / sessionTodoCount),
      cacheReadTokens: Math.round(sessionTotals.cacheReadTokens / sessionTodoCount),
      truncated: sessionTotals.truncated,
      recordCount: sessionTotals.recordCount,
      source: 'equal_share',
    };
  }

  private scoreGranularity(content: string): { score: number; signals: string[] } {
    let score = 1;
    const signals: string[] = [];
    const normalized = content.trim().toLowerCase();

    const broadSignals = [
      /重构/,
      /改造/,
      /迁移/,
      /统一/,
      /整体/,
      /整个/,
      /全局/,
      /架构/,
      /平台/,
      /模块/,
      /refactor/,
      /migrate/,
      /redesign/,
      /overhaul/,
      /system/,
      /module/,
      /layer/,
    ];
    const narrowSignals = [
      /修复/,
      /修改/,
      /补充/,
      /新增/,
      /删除/,
      /边界条件/,
      /函数/,
      /单测/,
      /fix/,
      /update/,
      /test/,
      /function/,
    ];
    const multiScopeSignals = [/所有/, /全部/, /多处/, /多个/, /跨/, /across/, /all\b/, /entire/, /whole/];
    const specificRefSignals = [/[`'"][\w./\\-]+[`'"]/, /第\s*\d+\s*行/, /\b[A-Z][A-Za-z0-9_]+\(/, /\b[\w.-]+\.[a-z]{2,4}\b/i];

    if (broadSignals.some((pattern) => pattern.test(normalized))) {
      score += 2;
      signals.push('Contains cross-module or architecture-level action words');
    } else if (narrowSignals.some((pattern) => pattern.test(normalized))) {
      signals.push('Contains localized fix-oriented action words');
    }

    if (multiScopeSignals.some((pattern) => pattern.test(normalized))) {
      score += 1;
      signals.push('Contains multi-file or broad-scope signals');
    }

    if (content.length > 50) {
      score += 0.5;
      signals.push('Description is long, which often implies broader scope');
    }
    if (content.length > 100) {
      score += 0.5;
    }

    if (specificRefSignals.some((pattern) => pattern.test(content))) {
      score -= 1;
      signals.push('Contains concrete file, function, or line references');
    }

    const finalScore = Math.max(1, Math.min(5, Math.round(score)));
    return {
      score: finalScore,
      signals,
    };
  }

  private buildBuckets(items: TodoGranularityItem[]): TodoGranularityBucket[] {
    const total = items.length;
    return [1, 2, 3, 4, 5].map((score) => {
      const scoped = items.filter((item) => item.granularityScore === score);
      const withContext = scoped.filter((item) => item.contextUsage !== null);
      const completionRate = scoped.length > 0 ? scoped.filter((item) => item.status === 'completed').length / scoped.length : null;
      const stuckRate =
        scoped.length > 0
          ? scoped.filter((item) => item.status === 'in_progress' && item.completedAtMs === null).length / scoped.length
          : null;
      const truncationRate =
        withContext.length > 0
          ? withContext.filter((item) => item.contextUsage?.truncated).length / withContext.length
          : null;

      return {
        score,
        count: scoped.length,
        share: total > 0 ? scoped.length / total : 0,
        truncationRate,
        completionRate,
        stuckRate,
      };
    });
  }

  private buildSuggestions(items: TodoGranularityItem[]): TodoGranularitySuggestion[] {
    if (items.length === 0) {
      return [];
    }

    const tokenValues = items
      .map((item) => item.contextUsage?.totalTokens ?? 0)
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const highTokenThreshold =
      tokenValues.length > 0 ? tokenValues[Math.max(0, Math.floor(tokenValues.length * 0.75) - 1)] : 0;

    return items
      .map((item) => {
        const reasons: string[] = [];
        let priority = 0;

        if (item.granularityScore >= 4) {
          reasons.push('The described scope is broad');
          priority += item.granularityScore * 2;
        }
        if ((item.contextUsage?.totalTokens ?? 0) >= highTokenThreshold && highTokenThreshold > 0) {
          reasons.push('The associated context usage is relatively high');
          priority += 2;
        }
        if (item.contextUsage?.truncated) {
          reasons.push('The execution window showed clear context pressure or truncation signals');
          priority += 4;
        }
        if (item.status === 'in_progress' && item.completedAtMs === null) {
          reasons.push('The task is still in progress and is a good candidate for smaller follow-up steps');
          priority += 1;
        }

        if (priority <= 0) {
          return null;
        }

        return {
          priority,
          suggestion: {
            todoId: item.todoId,
            content: item.content,
            granularityScore: item.granularityScore,
            reason: reasons.join('; '),
            splitHint: this.buildSplitHint(item.content),
            sessionId: item.sessionId,
            contextTokens: item.contextUsage?.totalTokens ?? null,
          },
        };
      })
      .filter((item): item is { priority: number; suggestion: TodoGranularitySuggestion } => item !== null)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          (b.suggestion.contextTokens ?? 0) - (a.suggestion.contextTokens ?? 0) ||
          a.suggestion.content.localeCompare(b.suggestion.content)
      )
      .slice(0, 6)
      .map((item) => item.suggestion);
  }

  private buildSplitHint(content: string): string {
    const normalized = content.trim().toLowerCase();

    if (/(重构|refactor|rewrite|改造)/i.test(normalized)) {
      return 'Split it into four steps: map the current state, define the target boundary, migrate one submodule at a time, and add tests. Keep each todo scoped to one directory or one responsibility.';
    }
    if (/(优化|improve|enhance|提升)/i.test(normalized)) {
      return 'Turn the optimization goal into something testable first, then split it into single-purpose changes such as performance, readability, error handling, or interaction.';
    }
    if (/(支持|support|接入|integrate)/i.test(normalized)) {
      return 'Break it into data preparation, core logic integration, command or UI exposure, and regression testing as separate todos.';
    }
    if (/(整个|整体|全局|所有|all|entire|system|module|layer)/i.test(normalized)) {
      return 'Split it by directory, module, or file. Each todo should target one concrete object and include a verifiable done condition.';
    }

    return 'Split the task into 2-4 more verifiable subtasks. Ideally each todo should describe one file, one function, or one behavior change.';
  }

  private computePearson(values: ReadonlyArray<readonly [number, number]>): number | null {
    if (values.length < 2) {
      return null;
    }

    const xs = values.map(([x]) => x);
    const ys = values.map(([, y]) => y);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;

    let numerator = 0;
    let xVariance = 0;
    let yVariance = 0;
    for (let index = 0; index < values.length; index += 1) {
      const xDelta = xs[index] - meanX;
      const yDelta = ys[index] - meanY;
      numerator += xDelta * yDelta;
      xVariance += xDelta * xDelta;
      yVariance += yDelta * yDelta;
    }

    if (xVariance <= 0 || yVariance <= 0) {
      return null;
    }

    return numerator / Math.sqrt(xVariance * yVariance);
  }

  private describeCorrelation(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
      return 'insufficient sample size';
    }

    const absValue = Math.abs(value);
    const strength =
      absValue >= 0.7 ? 'strong' : absValue >= 0.4 ? 'moderate' : absValue >= 0.2 ? 'weak' : 'very weak';
    const direction = value > 0 ? 'positive correlation' : value < 0 ? 'negative correlation' : 'no clear correlation';
    return `${strength} ${direction}`;
  }

  private extractTodosArray(payload: unknown): unknown[] | null {
    const direct = this.getValueAtPath(payload, ['todos']);
    if (Array.isArray(direct)) {
      return direct;
    }

    const nested = this.getValueAtPath(payload, ['message', 'todos']);
    return Array.isArray(nested) ? nested : null;
  }

  private getTimestampAtPaths(payload: unknown, paths: string[][]): number | null {
    for (const keyPath of paths) {
      const value = this.getValueAtPath(payload, keyPath);
      const timestamp = this.parseTimestamp(value);
      if (timestamp !== null) {
        return timestamp;
      }
    }
    return null;
  }

  private extractTimestampMs(payload: unknown): number {
    const timestamp =
      this.getTimestampAtPaths(payload, [
        ['timestamp'],
        ['created_at'],
        ['createdAt'],
        ['time'],
        ['message', 'timestamp'],
        ['message', 'created_at'],
        ['message', 'createdAt'],
      ]) ?? 0;
    return timestamp;
  }

  private getObjectAtPath(payload: unknown, keyPath: string[]): Record<string, unknown> | null {
    const value = this.getValueAtPath(payload, keyPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private getStringAtPaths(payload: unknown, keyPaths: string[][]): string | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private getNumberAtPaths(payload: unknown, keyPaths: string[][]): number | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, value);
      }
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return Math.max(0, parsed);
        }
      }
    }
    return null;
  }

  private getValueAtPath(payload: unknown, keyPath: string[]): unknown {
    let current: unknown = payload;
    for (const key of keyPath) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1000000000000) {
        return value;
      }
      if (value > 1000000000) {
        return value * 1000;
      }
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) {
        return null;
      }
      if (numeric > 1000000000000) {
        return numeric;
      }
      if (numeric > 1000000000) {
        return numeric * 1000;
      }
      return null;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private minTimestamp(left: number | null, right: number | null): number | null {
    if (left === null) {
      return right;
    }
    if (right === null) {
      return left;
    }
    return Math.min(left, right);
  }

  private maxTimestamp(left: number | null, right: number | null): number | null {
    if (left === null) {
      return right;
    }
    if (right === null) {
      return left;
    }
    return Math.max(left, right);
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
