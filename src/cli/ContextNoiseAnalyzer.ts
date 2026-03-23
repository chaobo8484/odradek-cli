import { promises as fs } from 'fs';
import path from 'path';
import { estimateTokenCount } from './tokenEstimate.js';

export type ContextNoiseTarget = {
  sessionId: string;
  filePath: string;
};

export type ContextNoiseAction = 'delete' | 'keep';
export type ContextNoiseSeverity = 'high' | 'medium' | 'low';
export type ContextNoiseRule = 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
export type ContextNoiseBucketKey =
  | 'file_read'
  | 'bash_output'
  | 'directory_listing'
  | 'grep_output'
  | 'todo_write'
  | 'user_prompt'
  | 'assistant_text'
  | 'other';

export type ContextNoiseBucket = {
  key: ContextNoiseBucketKey;
  label: string;
  tokenCount: number;
  count: number;
  share: number;
};

export type ContextNoiseSignal = {
  rule: ContextNoiseRule;
  severity: ContextNoiseSeverity;
  action: ContextNoiseAction;
  sessionId: string;
  target: string;
  wastedTokens: number;
  occurrences: number;
  reason: string;
  recommendation: string;
};

export type ContextNoiseKeepCandidate = {
  sessionId: string;
  target: string;
  tokenCount: number;
  score: number;
  reason: string;
};

export type ContextNoiseReadRecord = {
  sessionId: string;
  path: string;
  tokenCount: number;
  order: number;
  resultContent: string;
  wasReferencedLater: boolean;
};

export type ContextNoiseAnalysis = {
  sessionsScanned: number;
  sessionsAnalyzed: number;
  sessionsWithSignals: number;
  totalEstimatedTokens: number;
  totalNoiseTokens: number;
  buckets: ContextNoiseBucket[];
  signals: ContextNoiseSignal[];
  keepCandidates: ContextNoiseKeepCandidate[];
  readRecords: ContextNoiseReadRecord[];
  warnings: string[];
};

type NormalizedMessage = {
  order: number;
  timestampMs: number;
  role: 'user' | 'assistant' | 'system' | 'unknown';
  text: string;
};

type ToolObservation = {
  id: string;
  sessionId: string;
  filePath: string;
  order: number;
  timestampMs: number;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  resultContent: string;
  resultTokens: number;
  isError: boolean;
  cwd: string;
  targetPath: string;
  command: string;
};

type ContextItem = {
  sessionId: string;
  order: number;
  tokenCount: number;
  key: ContextNoiseBucketKey;
};

type ParsedSession = {
  sessionId: string;
  filePath: string;
  messages: NormalizedMessage[];
  observations: ToolObservation[];
  items: ContextItem[];
};

type PartialObservation = {
  id: string;
  sessionId: string;
  filePath: string;
  order: number;
  timestampMs: number;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  resultContent?: string;
  resultTokens?: number;
  isError?: boolean;
  cwd: string;
  targetPath: string;
  command: string;
};

const TOOL_MUTATION_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const DIRECTORY_TOOLS = new Set(['ls', 'glob']);
const DEFAULT_BASH_NOISE_THRESHOLD = 500;
const DEFAULT_READ_NOISE_THRESHOLD = 700;
const DEFAULT_BROAD_SCAN_ENTRIES = 50;

export class ContextNoiseAnalyzer {
  async analyze(targets: ContextNoiseTarget[]): Promise<ContextNoiseAnalysis> {
    const warnings: string[] = [];
    const sessions: ParsedSession[] = [];

    for (const target of targets) {
      const parsed = await this.parseSession(target);
      if (!parsed) {
        warnings.push(`Failed to parse session: ${target.filePath}`);
        continue;
      }
      sessions.push(parsed);
    }

    const totalEstimatedTokens = sessions.reduce(
      (sum, session) => sum + session.items.reduce((sessionSum, item) => sessionSum + item.tokenCount, 0),
      0
    );
    const buckets = this.buildBuckets(sessions, totalEstimatedTokens);
    const signals = sessions.flatMap((session) => this.detectSignals(session));
    const keepCandidates = sessions.flatMap((session) => this.detectKeepCandidates(session, signals));
    const totalNoiseTokens = signals.reduce((sum, signal) => sum + signal.wastedTokens, 0);
    const sessionsWithSignals = new Set(signals.map((signal) => signal.sessionId)).size;

    if (sessions.length === 0) {
      warnings.push('No analyzable Claude session JSONL files were found.');
    }

    return {
      sessionsScanned: targets.length,
      sessionsAnalyzed: sessions.length,
      sessionsWithSignals,
      totalEstimatedTokens,
      totalNoiseTokens,
      buckets,
      signals: signals
        .sort((a, b) => b.wastedTokens - a.wastedTokens || a.sessionId.localeCompare(b.sessionId) || a.rule.localeCompare(b.rule))
        .slice(0, 18),
      keepCandidates: keepCandidates
        .sort((a, b) => b.score - a.score || b.tokenCount - a.tokenCount || a.target.localeCompare(b.target))
        .slice(0, 8),
      readRecords: sessions
        .flatMap((session) =>
          session.observations
            .filter((observation) => observation.name.toLowerCase() === 'read' && observation.targetPath && observation.resultTokens > 0)
            .map((observation) => ({
              sessionId: session.sessionId,
              path: this.toDisplayPath(observation.targetPath),
              tokenCount: observation.resultTokens,
              order: observation.order,
              resultContent: observation.resultContent,
              wasReferencedLater: this.wasReadUsedLater(session, observation),
            }))
        )
        .sort((a, b) => b.tokenCount - a.tokenCount || a.path.localeCompare(b.path)),
      warnings: Array.from(new Set(warnings)),
    };
  }

  private async parseSession(target: ContextNoiseTarget): Promise<ParsedSession | null> {
    let raw = '';
    try {
      raw = await fs.readFile(target.filePath, 'utf8');
    } catch {
      return null;
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const messages: NormalizedMessage[] = [];
    const observations = new Map<string, PartialObservation>();
    const items: ContextItem[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]) as unknown;
      } catch {
        continue;
      }

      const envelope = this.extractEnvelope(parsed);
      if (!envelope) {
        continue;
      }

      const timestampMs = envelope.timestampMs || this.parseTimestamp(this.getValueAtPath(parsed, ['timestamp'])) || 0;
      if (envelope.text) {
        messages.push({
          order: index,
          timestampMs,
          role: envelope.role,
          text: envelope.text,
        });
        const bucketKey = envelope.role === 'assistant' ? 'assistant_text' : envelope.role === 'user' ? 'user_prompt' : 'other';
        items.push({
          sessionId: target.sessionId,
          order: index,
          tokenCount: estimateTokenCount(envelope.text),
          key: bucketKey,
        });
      }

      for (const toolUse of envelope.toolUses) {
        const partial: PartialObservation = {
          id: toolUse.id,
          sessionId: target.sessionId,
          filePath: target.filePath,
          order: index,
          timestampMs,
          name: toolUse.name,
          input: toolUse.input,
          inputText: this.stringifyValue(toolUse.input),
          cwd: envelope.cwd,
          targetPath: this.extractToolTargetPath(toolUse.name, toolUse.input),
          command: this.extractToolCommand(toolUse.name, toolUse.input),
        };
        const existing = observations.get(toolUse.id);
        observations.set(toolUse.id, {
          ...existing,
          ...partial,
          resultContent: existing?.resultContent,
          resultTokens: existing?.resultTokens,
          isError: existing?.isError,
        });
      }

      for (const toolResult of envelope.toolResults) {
        const existing = observations.get(toolResult.toolUseId);
        const merged: PartialObservation = {
          id: toolResult.toolUseId,
          sessionId: target.sessionId,
          filePath: target.filePath,
          order: existing?.order ?? index,
          timestampMs: existing?.timestampMs ?? timestampMs,
          name: existing?.name ?? 'unknown',
          input: existing?.input ?? {},
          inputText: existing?.inputText ?? '',
          cwd: existing?.cwd ?? envelope.cwd,
          targetPath: existing?.targetPath ?? '',
          command: existing?.command ?? '',
          resultContent: toolResult.content,
          resultTokens: estimateTokenCount(toolResult.content),
          isError: toolResult.isError,
        };
        observations.set(toolResult.toolUseId, merged);
      }
    }

    const normalizedObservations = Array.from(observations.values())
      .map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        filePath: item.filePath,
        order: item.order,
        timestampMs: item.timestampMs,
        name: item.name,
        input: item.input,
        inputText: item.inputText,
        resultContent: item.resultContent ?? '',
        resultTokens: item.resultTokens ?? 0,
        isError: item.isError ?? false,
        cwd: item.cwd,
        targetPath: item.targetPath,
        command: item.command,
      }))
      .sort((a, b) => a.order - b.order || a.timestampMs - b.timestampMs);

    normalizedObservations.forEach((observation) => {
      const key = this.classifyObservation(observation);
      if (observation.resultTokens <= 0 && !(observation.name.toLowerCase() === 'todowrite' && observation.inputText)) {
        return;
      }
      items.push({
        sessionId: observation.sessionId,
        order: observation.order,
        tokenCount:
          observation.resultTokens > 0
            ? observation.resultTokens
            : observation.name.toLowerCase() === 'todowrite'
            ? estimateTokenCount(observation.inputText)
            : 0,
        key,
      });
    });

    return {
      sessionId: target.sessionId,
      filePath: target.filePath,
      messages,
      observations: normalizedObservations,
      items,
    };
  }

  private extractEnvelope(payload: unknown): {
    role: 'user' | 'assistant' | 'system' | 'unknown';
    text: string;
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
    timestampMs: number;
    cwd: string;
  } | null {
    const direct = this.readMessageShape(payload);
    if (direct) {
      return direct;
    }

    const nestedMessage =
      this.getObjectAtPath(payload, ['data', 'message', 'message']) ??
      this.getObjectAtPath(payload, ['data', 'message']);
    if (nestedMessage) {
      const envelope = this.readMessageShape(nestedMessage, payload);
      if (envelope) {
        return envelope;
      }
    }

    return null;
  }

  private readMessageShape(
    messagePayload: Record<string, unknown> | unknown,
    fallbackPayload?: unknown
  ): {
    role: 'user' | 'assistant' | 'system' | 'unknown';
    text: string;
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
    timestampMs: number;
    cwd: string;
  } | null {
    if (!messagePayload || typeof messagePayload !== 'object' || Array.isArray(messagePayload)) {
      return null;
    }

    const record = messagePayload as Record<string, unknown>;
    const roleValue = typeof record.role === 'string' ? record.role : '';
    const content = record.content;
    if (!roleValue && content === undefined) {
      return null;
    }

    const role =
      roleValue === 'assistant'
        ? 'assistant'
        : roleValue === 'user'
        ? 'user'
        : roleValue === 'system'
        ? 'system'
        : 'unknown';
    const blocks = this.normalizeContentBlocks(content);
    const textSegments: string[] = [];
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    const toolResults: Array<{ toolUseId: string; content: string; isError: boolean }> = [];

    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (block.id && block.name) {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        continue;
      }

      if (block.type === 'tool_result') {
        if (block.toolUseId) {
          toolResults.push({
            toolUseId: block.toolUseId,
            content: block.text,
            isError: block.isError,
          });
        }
        continue;
      }

      if (block.text) {
        textSegments.push(block.text);
      }
    }

    const text = this.normalizeMessageText(textSegments.join('\n'));
    const timestampMs =
      this.parseTimestamp(record.timestamp) ||
      this.parseTimestamp(this.getValueAtPath(fallbackPayload, ['data', 'message', 'timestamp'])) ||
      this.parseTimestamp(this.getValueAtPath(fallbackPayload, ['timestamp'])) ||
      0;
    const cwd =
      this.getStringAtPaths(fallbackPayload, [['cwd']]) ??
      this.getStringAtPaths(record, [['cwd']]) ??
      '';

    return {
      role,
      text,
      toolUses,
      toolResults,
      timestampMs,
      cwd,
    };
  }

  private normalizeContentBlocks(content: unknown): Array<{
    type: 'text' | 'tool_use' | 'tool_result';
    text: string;
    id: string;
    name: string;
    input: Record<string, unknown>;
    toolUseId: string;
    isError: boolean;
  }> {
    if (typeof content === 'string') {
      return [
        {
          type: 'text',
          text: content,
          id: '',
          name: '',
          input: {},
          toolUseId: '',
          isError: false,
        },
      ];
    }

    if (!Array.isArray(content)) {
      return [];
    }

    return content
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const record = item as Record<string, unknown>;
        const type = typeof record.type === 'string' ? record.type : 'text';
        if (type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            text: '',
            id: typeof record.id === 'string' ? record.id : '',
            name: typeof record.name === 'string' ? record.name : '',
            input:
              record.input && typeof record.input === 'object' && !Array.isArray(record.input)
                ? (record.input as Record<string, unknown>)
                : {},
            toolUseId: '',
            isError: false,
          };
        }

        if (type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            text: this.normalizeToolResultContent(record.content),
            id: '',
            name: '',
            input: {},
            toolUseId: typeof record.tool_use_id === 'string' ? record.tool_use_id : '',
            isError: record.is_error === true,
          };
        }

        return {
          type: 'text' as const,
          text:
            typeof record.text === 'string'
              ? record.text
              : typeof record.content === 'string'
              ? record.content
              : '',
          id: '',
          name: '',
          input: {},
          toolUseId: '',
          isError: false,
        };
      })
      .filter(
        (
          item
        ): item is {
          type: 'text' | 'tool_use' | 'tool_result';
          text: string;
          id: string;
          name: string;
          input: Record<string, unknown>;
          toolUseId: string;
          isError: boolean;
        } => item !== null
      );
  }

  private normalizeToolResultContent(content: unknown): string {
    if (typeof content === 'string') {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const record = item as Record<string, unknown>;
            if (typeof record.text === 'string') {
              return record.text;
            }
            if (typeof record.content === 'string') {
              return record.content;
            }
          }
          return '';
        })
        .join('\n')
        .trim();
    }
    return '';
  }

  private normalizeMessageText(input: string): string {
    const normalized = input.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) {
      return '';
    }
    if (
      normalized.includes('<local-command-caveat>') ||
      normalized.includes('<local-command-stdout>') ||
      normalized.includes('<command-name>')
    ) {
      return '';
    }
    return normalized;
  }

  private buildBuckets(sessions: ParsedSession[], totalEstimatedTokens: number): ContextNoiseBucket[] {
    const bucketMeta: Record<ContextNoiseBucketKey, string> = {
      file_read: 'File Reads',
      bash_output: 'Bash Output',
      directory_listing: 'Directory Listing',
      grep_output: 'Grep Output',
      todo_write: 'TodoWrite',
      user_prompt: 'User Prompts',
      assistant_text: 'Assistant Text',
      other: 'Other',
    };

    const bucketMap = new Map<ContextNoiseBucketKey, { tokenCount: number; count: number }>();
    for (const session of sessions) {
      for (const item of session.items) {
        const current = bucketMap.get(item.key) ?? { tokenCount: 0, count: 0 };
        current.tokenCount += item.tokenCount;
        current.count += 1;
        bucketMap.set(item.key, current);
      }
    }

    return Array.from(bucketMap.entries())
      .map(([key, value]) => ({
        key,
        label: bucketMeta[key],
        tokenCount: value.tokenCount,
        count: value.count,
        share: totalEstimatedTokens > 0 ? value.tokenCount / totalEstimatedTokens : 0,
      }))
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label));
  }

  private detectSignals(session: ParsedSession): ContextNoiseSignal[] {
    const signals: ContextNoiseSignal[] = [];
    signals.push(...this.detectRedundantReads(session));
    signals.push(...this.detectBroadScans(session));
    signals.push(...this.detectLargeUnusedBash(session));
    signals.push(...this.detectTodoWriteRepetition(session));
    signals.push(...this.detectLowUtilizationReads(session, signals));
    return signals;
  }

  private detectRedundantReads(session: ParsedSession): ContextNoiseSignal[] {
    const signals: ContextNoiseSignal[] = [];
    const lastMutationOrder = new Map<string, number>();
    const lastRead = new Map<string, ToolObservation>();

    for (const observation of session.observations) {
      const name = observation.name.toLowerCase();
      if (TOOL_MUTATION_NAMES.has(name)) {
        const normalizedPath = this.normalizePathKey(observation.targetPath);
        if (normalizedPath) {
          lastMutationOrder.set(normalizedPath, observation.order);
        }
        continue;
      }

      if (name !== 'read') {
        continue;
      }

      const normalizedPath = this.normalizePathKey(observation.targetPath);
      if (!normalizedPath || observation.resultTokens <= 0) {
        continue;
      }

      const previousRead = lastRead.get(normalizedPath);
      const lastMutation = lastMutationOrder.get(normalizedPath) ?? -1;
      if (previousRead && lastMutation <= previousRead.order) {
        signals.push({
          rule: 'N1',
          severity: observation.resultTokens >= 1200 ? 'high' : 'medium',
          action: 'delete',
          sessionId: session.sessionId,
          target: this.toDisplayPath(observation.targetPath),
          wastedTokens: observation.resultTokens,
          occurrences: 1,
          reason: 'The same file was read again before any write or edit changed it.',
          recommendation: 'Delete this duplicate file context and keep only the latest useful read.',
        });
      }

      lastRead.set(normalizedPath, observation);
    }

    return signals;
  }

  private detectBroadScans(session: ParsedSession): ContextNoiseSignal[] {
    const signals: ContextNoiseSignal[] = [];

    for (const observation of session.observations) {
      const kind = this.classifyObservation(observation);
      if (kind !== 'directory_listing') {
        continue;
      }

      const entryCount = this.estimateEntryCount(observation.resultContent);
      if (entryCount < DEFAULT_BROAD_SCAN_ENTRIES && observation.resultTokens < DEFAULT_BASH_NOISE_THRESHOLD) {
        continue;
      }

      const target = observation.targetPath
        ? this.toDisplayPath(observation.targetPath)
        : this.truncateCommand(observation.command || observation.inputText);
      const isRootish = this.isRootLikeScan(observation);
      if (!isRootish && entryCount < DEFAULT_BROAD_SCAN_ENTRIES * 2) {
        continue;
      }

      signals.push({
        rule: 'N3',
        severity: observation.resultTokens >= 1000 || entryCount >= 80 ? 'high' : 'medium',
        action: 'delete',
        sessionId: session.sessionId,
        target,
        wastedTokens: observation.resultTokens,
        occurrences: Math.max(1, entryCount),
        reason: `Broad directory listing pulled in ${entryCount} entries with little task focus.`,
        recommendation: 'Delete this broad scan from context and replace it with a narrower path or targeted file search.',
      });
    }

    return signals;
  }

  private detectLargeUnusedBash(session: ParsedSession): ContextNoiseSignal[] {
    const signals: ContextNoiseSignal[] = [];

    for (const observation of session.observations) {
      if (observation.name.toLowerCase() !== 'bash') {
        continue;
      }
      if (this.classifyObservation(observation) === 'directory_listing') {
        continue;
      }
      if (observation.resultTokens < DEFAULT_BASH_NOISE_THRESHOLD) {
        continue;
      }
      if (this.wasObservationReferencedLater(session, observation)) {
        continue;
      }

      signals.push({
        rule: 'N2',
        severity: observation.resultTokens >= 1400 ? 'high' : 'medium',
        action: 'delete',
        sessionId: session.sessionId,
        target: this.truncateCommand(observation.command || 'Bash output'),
        wastedTokens: observation.resultTokens,
        occurrences: 1,
        reason: 'Large shell output was captured, but later steps did not appear to use it.',
        recommendation: 'Delete this shell output from context unless it directly drives the next action.',
      });
    }

    return signals;
  }

  private detectTodoWriteRepetition(session: ParsedSession): ContextNoiseSignal[] {
    const signals: ContextNoiseSignal[] = [];
    let previousTodo: ToolObservation | null = null;

    for (const observation of session.observations) {
      if (observation.name.toLowerCase() !== 'todowrite') {
        continue;
      }

      if (previousTodo) {
        const similarity = this.computeSimilarity(previousTodo.inputText, observation.inputText);
        if (similarity >= 0.9) {
          signals.push({
            rule: 'N4',
            severity: similarity >= 0.98 ? 'medium' : 'low',
            action: 'delete',
            sessionId: session.sessionId,
            target: 'TodoWrite payload',
            wastedTokens: estimateTokenCount(observation.inputText),
            occurrences: 1,
            reason: 'Todo state was injected again with almost no change.',
            recommendation: 'Delete repeated todo payloads and keep only the latest materially changed todo list.',
          });
        }
      }

      previousTodo = observation;
    }

    return signals;
  }

  private detectLowUtilizationReads(session: ParsedSession, existingSignals: ContextNoiseSignal[]): ContextNoiseSignal[] {
    const signals: ContextNoiseSignal[] = [];
    const alreadyFlaggedTargets = new Set(
      existingSignals.filter((signal) => signal.rule === 'N1').map((signal) => `${signal.sessionId}:${signal.target}`)
    );

    for (const observation of session.observations) {
      if (observation.name.toLowerCase() !== 'read') {
        continue;
      }
      if (observation.resultTokens < DEFAULT_READ_NOISE_THRESHOLD) {
        continue;
      }

      const target = this.toDisplayPath(observation.targetPath);
      if (alreadyFlaggedTargets.has(`${session.sessionId}:${target}`)) {
        continue;
      }
      if (this.wasReadUsedLater(session, observation)) {
        continue;
      }

      signals.push({
        rule: 'N5',
        severity: observation.resultTokens >= 1800 ? 'high' : 'medium',
        action: 'delete',
        sessionId: session.sessionId,
        target,
        wastedTokens: observation.resultTokens,
        occurrences: 1,
        reason: 'A large file read entered context, but later steps did not reference or modify that file.',
        recommendation: 'Delete this file context, or replace it with a smaller excerpt tied to the active task.',
      });
    }

    return signals;
  }

  private detectKeepCandidates(session: ParsedSession, signals: ContextNoiseSignal[]): ContextNoiseKeepCandidate[] {
    const noisyTargets = new Set(
      signals
        .filter((signal) => signal.sessionId === session.sessionId && signal.action === 'delete')
        .map((signal) => signal.target.toLowerCase())
    );
    const keepCandidates: ContextNoiseKeepCandidate[] = [];

    for (const observation of session.observations) {
      const name = observation.name.toLowerCase();
      if (name === 'read' && observation.targetPath && observation.resultTokens > 0) {
        const displayPath = this.toDisplayPath(observation.targetPath);
        if (noisyTargets.has(displayPath.toLowerCase())) {
          continue;
        }

        const laterMutation = session.observations.some((next) => {
          if (next.order <= observation.order) {
            return false;
          }
          if (!TOOL_MUTATION_NAMES.has(next.name.toLowerCase())) {
            return false;
          }
          return this.normalizePathKey(next.targetPath) === this.normalizePathKey(observation.targetPath);
        });
        if (laterMutation) {
          keepCandidates.push({
            sessionId: session.sessionId,
            target: displayPath,
            tokenCount: observation.resultTokens,
            score: observation.resultTokens + 1200,
            reason: 'Keep: this read led to a later edit/write on the same file.',
          });
          continue;
        }

        const laterMentions = this.countLaterMentions(session, observation);
        if (laterMentions >= 2) {
          keepCandidates.push({
            sessionId: session.sessionId,
            target: displayPath,
            tokenCount: observation.resultTokens,
            score: observation.resultTokens + laterMentions * 200,
            reason: 'Keep: this file kept showing up in later tool inputs or assistant reasoning.',
          });
        }
      }

      if (
        name === 'bash' &&
        observation.resultTokens >= DEFAULT_BASH_NOISE_THRESHOLD &&
        this.wasObservationReferencedLater(session, observation)
      ) {
        keepCandidates.push({
          sessionId: session.sessionId,
          target: this.truncateCommand(observation.command || 'Bash output'),
          tokenCount: observation.resultTokens,
          score: observation.resultTokens + 600,
          reason: 'Keep: this shell output was reused later and likely informed a follow-up action.',
        });
      }
    }

    for (const message of session.messages) {
      if (message.role !== 'user' || message.text.length === 0) {
        continue;
      }
      const toolFanout = session.observations.filter((observation) => observation.order > message.order && observation.order <= message.order + 12).length;
      if (toolFanout >= 3) {
        keepCandidates.push({
          sessionId: session.sessionId,
          target: this.truncateCommand(message.text),
          tokenCount: estimateTokenCount(message.text),
          score: 500 + toolFanout * 80,
          reason: 'Keep: this user prompt clearly drove the subsequent context gathering.',
        });
      }
    }

    return keepCandidates;
  }

  private wasReadUsedLater(session: ParsedSession, observation: ToolObservation): boolean {
    const normalizedPath = this.normalizePathKey(observation.targetPath);
    if (!normalizedPath) {
      return this.wasObservationReferencedLater(session, observation);
    }

    const laterMutation = session.observations.some((next) => {
      if (next.order <= observation.order) {
        return false;
      }
      if (!TOOL_MUTATION_NAMES.has(next.name.toLowerCase())) {
        return false;
      }
      return this.normalizePathKey(next.targetPath) === normalizedPath;
    });
    if (laterMutation) {
      return true;
    }

    return this.wasObservationReferencedLater(session, observation);
  }

  private wasObservationReferencedLater(session: ParsedSession, observation: ToolObservation): boolean {
    const anchors = this.extractReferenceAnchors(observation);
    if (anchors.length === 0) {
      return false;
    }

    const futureMessages = session.messages
      .filter((message) => message.order > observation.order)
      .slice(0, 10)
      .map((message) => message.text.toLowerCase())
      .join('\n');
    const futureInputs = session.observations
      .filter((next) => next.order > observation.order)
      .slice(0, 10)
      .map((next) => `${next.inputText}\n${next.command}`.toLowerCase())
      .join('\n');
    const futureText = `${futureMessages}\n${futureInputs}`;

    return anchors.some((anchor) => futureText.includes(anchor.toLowerCase()));
  }

  private countLaterMentions(session: ParsedSession, observation: ToolObservation): number {
    const anchors = this.extractReferenceAnchors(observation);
    if (anchors.length === 0) {
      return 0;
    }

    let mentions = 0;
    const futureMessages = session.messages.filter((message) => message.order > observation.order);
    const futureObservations = session.observations.filter((next) => next.order > observation.order);

    for (const message of futureMessages) {
      const lower = message.text.toLowerCase();
      if (anchors.some((anchor) => lower.includes(anchor.toLowerCase()))) {
        mentions += 1;
      }
    }

    for (const next of futureObservations) {
      const lower = `${next.inputText}\n${next.command}`.toLowerCase();
      if (anchors.some((anchor) => lower.includes(anchor.toLowerCase()))) {
        mentions += 1;
      }
    }

    return mentions;
  }

  private extractReferenceAnchors(observation: ToolObservation): string[] {
    const anchors = new Set<string>();
    const displayPath = this.toDisplayPath(observation.targetPath);
    if (displayPath) {
      anchors.add(displayPath.toLowerCase());
      anchors.add(path.basename(displayPath).toLowerCase());
    }

    const contentAnchors = this.extractKeywords(observation.resultContent).slice(0, 8);
    contentAnchors.forEach((anchor) => anchors.add(anchor.toLowerCase()));
    return Array.from(anchors).filter((anchor) => anchor.length >= 3);
  }

  private extractKeywords(text: string): string[] {
    const seen = new Set<string>();
    const matches = text.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}|\b[A-Za-z][A-Za-z0-9]{4,}\b|[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const match of matches) {
      const normalized = match.trim().toLowerCase();
      if (normalized.length < 3) {
        continue;
      }
      if (/^(this|that|from|with|have|were|will|would|should|about|there|their|error|warning)$/i.test(normalized)) {
        continue;
      }
      seen.add(normalized);
      if (seen.size >= 16) {
        break;
      }
    }
    return Array.from(seen);
  }

  private classifyObservation(observation: ToolObservation): ContextNoiseBucketKey {
    const name = observation.name.toLowerCase();
    if (name === 'read') {
      return 'file_read';
    }
    if (name === 'grep') {
      return 'grep_output';
    }
    if (name === 'todowrite') {
      return 'todo_write';
    }
    if (DIRECTORY_TOOLS.has(name)) {
      return 'directory_listing';
    }
    if (name === 'bash') {
      return this.isDirectoryListingCommand(observation.command, observation.resultContent) ? 'directory_listing' : 'bash_output';
    }
    return 'other';
  }

  private extractToolTargetPath(name: string, input: Record<string, unknown>): string {
    return (
      this.getStringAtPaths(input, [['file_path'], ['filePath'], ['path'], ['directory'], ['dir'], ['cwd']]) ??
      (name.toLowerCase() === 'bash' ? this.extractPathFromCommand(this.extractToolCommand(name, input)) : '') ??
      ''
    );
  }

  private extractToolCommand(name: string, input: Record<string, unknown>): string {
    if (name.toLowerCase() !== 'bash') {
      return this.getStringAtPaths(input, [['description']]) ?? '';
    }
    return this.getStringAtPaths(input, [['command'], ['cmd']]) ?? '';
  }

  private extractPathFromCommand(command: string): string {
    if (!command) {
      return '';
    }
    const quoted = command.match(/["']([A-Za-z]:[\\/][^"']+|\.{0,2}[\\/][^"']+)["']/);
    if (quoted?.[1]) {
      return quoted[1];
    }
    const bare = command.match(/(?:ls|dir|tree|find|Get-ChildItem|rg --files)\s+([A-Za-z]:[\\/][^\s]+|\.{0,2}[\\/][^\s]+)/i);
    return bare?.[1] ?? '';
  }

  private estimateEntryCount(resultContent: string): number {
    return resultContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }

  private isDirectoryListingCommand(command: string, resultContent: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (
      /(^|\s)(ls|dir|tree|find|get-childitem)(\s|$)/i.test(normalized) ||
      normalized.includes('rg --files')
    ) {
      return true;
    }

    const entryCount = this.estimateEntryCount(resultContent);
    const looksLikePaths = resultContent
      .split(/\r?\n/)
      .slice(0, 10)
      .filter((line) => /[\\/]/.test(line) || /\.[A-Za-z0-9]+$/.test(line.trim())).length;
    return entryCount >= 10 && looksLikePaths >= 6;
  }

  private isRootLikeScan(observation: ToolObservation): boolean {
    const command = observation.command.toLowerCase();
    const targetPath = this.normalizePathKey(observation.targetPath);
    const cwd = this.normalizePathKey(observation.cwd);
    if (!targetPath) {
      return true;
    }
    if (targetPath === '.' || targetPath === './' || targetPath === '.\\') {
      return true;
    }
    if (cwd && targetPath === cwd) {
      return true;
    }
    if (command.includes(' .') || command.includes(' "./') || command.includes(" '.\\")) {
      return true;
    }
    const relativeDepth = targetPath.replace(/^[a-z]:/i, '').split(/[\\/]+/).filter(Boolean).length;
    return relativeDepth <= 3;
  }

  private normalizePathKey(inputPath: string): string {
    return inputPath.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  }

  private toDisplayPath(inputPath: string): string {
    if (!inputPath) {
      return '';
    }
    return inputPath.replace(/\//g, path.sep);
  }

  private truncateCommand(value: string, maxLength: number = 72): string {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLength) {
      return singleLine;
    }
    return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private computeSimilarity(left: string, right: string): number {
    const normalizedLeft = left.replace(/\s+/g, ' ').trim();
    const normalizedRight = right.replace(/\s+/g, ' ').trim();
    if (!normalizedLeft || !normalizedRight) {
      return 0;
    }
    if (normalizedLeft === normalizedRight) {
      return 1;
    }
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
      const shorter = Math.min(normalizedLeft.length, normalizedRight.length);
      const longer = Math.max(normalizedLeft.length, normalizedRight.length);
      return shorter / longer;
    }

    const leftTokens = new Set(this.extractKeywords(normalizedLeft));
    const rightTokens = new Set(this.extractKeywords(normalizedRight));
    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return 0;
    }

    let intersection = 0;
    leftTokens.forEach((token) => {
      if (rightTokens.has(token)) {
        intersection += 1;
      }
    });
    const union = new Set([...leftTokens, ...rightTokens]).size;
    return union > 0 ? intersection / union : 0;
  }

  private stringifyValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
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
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
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

  private parseTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1000000000000) {
        return value;
      }
      if (value > 1000000000) {
        return value * 1000;
      }
      return 0;
    }

    if (typeof value !== 'string') {
      return 0;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) {
        return 0;
      }
      if (numeric > 1000000000000) {
        return numeric;
      }
      if (numeric > 1000000000) {
        return numeric * 1000;
      }
      return 0;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
}
