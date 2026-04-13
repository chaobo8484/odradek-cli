import { promises as fs } from 'fs';
import path from 'path';
import { countTokensBySource } from './tokenEstimateBySource.js';
import { estimateTokenCount } from './tokenEstimate.js';

export type TranscriptSource = 'claude' | 'codex' | 'cursor';

export type ClaudeTranscriptTarget = {
  sessionId: string;
  filePath: string;
  source?: TranscriptSource;
};

export type ClaudeTranscriptMessage = {
  order: number;
  timestampMs: number;
  role: 'user' | 'assistant' | 'system' | 'unknown';
  text: string;
  isCompactSummary: boolean;
  isSynthetic: boolean;
};

export type ClaudeTranscriptFileRange = {
  startLine: number;
  numLines: number;
  totalLines: number;
};

export type ClaudeTranscriptObservation = {
  id: string;
  sessionId: string;
  filePath: string;
  source: TranscriptSource;
  sourceToolName: string;
  order: number;
  timestampMs: number;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  resultContent: string;
  resultTokens: number;
  estimatedTokens: number;
  isError: boolean;
  cwd: string;
  rawTargetPath: string;
  targetPath: string;
  command: string;
  writePayload: string;
  stdout: string;
  stderr: string;
  interrupted: boolean;
  successFlag: boolean | null;
  fileRange: ClaudeTranscriptFileRange | null;
  resultPaths: string[];
  durationMs: number | null;
  numFiles: number | null;
  truncated: boolean;
  userModified: boolean | null;
  structuredPatchText: string;
  structuredPatchCount: number;
  oldString: string;
  newString: string;
  sourceToolAssistantUUID: string;
  parentToolUseId: string;
  isTaskTool: boolean;
  isSubagentProgress: boolean;
};

export type ClaudeTranscriptContextItem = {
  order: number;
  tokenCount: number;
};

export type ClaudeTranscriptSession = {
  sessionId: string;
  filePath: string;
  source: TranscriptSource;
  workspaceRoot: string;
  model: string;
  contextWindowTokens: number | null;
  startTimestampMs: number;
  endTimestampMs: number;
  messages: ClaudeTranscriptMessage[];
  observations: ClaudeTranscriptObservation[];
  items: ClaudeTranscriptContextItem[];
};

export type TranscriptTarget = ClaudeTranscriptTarget;
export type TranscriptMessage = ClaudeTranscriptMessage;
export type TranscriptObservation = ClaudeTranscriptObservation;
export type TranscriptContextItem = ClaudeTranscriptContextItem;
export type TranscriptSession = ClaudeTranscriptSession;

type Envelope = {
  role: ClaudeTranscriptMessage['role'];
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
  timestampMs: number;
  cwd: string;
};

type PartialObservation = {
  id: string;
  sessionId: string;
  filePath: string;
  source: TranscriptSource;
  sourceToolName: string;
  order: number;
  timestampMs: number;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  resultContent?: string;
  resultTokens?: number;
  estimatedTokens?: number;
  isError?: boolean;
  cwd: string;
  rawTargetPath: string;
  targetPath: string;
  command: string;
  writePayload: string;
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  successFlag?: boolean | null;
  fileRange?: ClaudeTranscriptFileRange | null;
  resultPaths?: string[];
  durationMs?: number | null;
  numFiles?: number | null;
  truncated?: boolean;
  userModified?: boolean | null;
  structuredPatchText?: string;
  structuredPatchCount?: number;
  oldString?: string;
  newString?: string;
  sourceToolAssistantUUID?: string;
  parentToolUseId?: string;
  isTaskTool?: boolean;
  isSubagentProgress?: boolean;
};

type StructuredToolResultMeta = {
  preferredContent: string;
  stdout: string;
  stderr: string;
  interrupted: boolean;
  success: boolean | null;
  fileRange: ClaudeTranscriptFileRange | null;
  rawResultPaths: string[];
  durationMs: number | null;
  numFiles: number | null;
  truncated: boolean;
  userModified: boolean | null;
  structuredPatchText: string;
  structuredPatchCount: number;
  oldString: string;
  newString: string;
};

const TOOL_MUTATION_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch']);
const DIRECTORY_TOOLS = new Set(['ls', 'glob']);

export async function parseClaudeTranscriptSession(
  target: ClaudeTranscriptTarget
): Promise<ClaudeTranscriptSession | null> {
  const source = resolveTranscriptSource(target);
  return source === 'codex'
    ? parseCodexTranscriptSession({ ...target, source })
    : parseClaudeTranscriptSessionInternal({ ...target, source });
}

async function parseClaudeTranscriptSessionInternal(
  target: ClaudeTranscriptTarget & { source: 'claude' | 'cursor' }
): Promise<ClaudeTranscriptSession | null> {
  const raw = await readTextFile(target.filePath);
  if (raw === null) {
    return null;
  }

  const lines = splitJsonl(raw);
  const messages: ClaudeTranscriptMessage[] = [];
  const observations = new Map<string, PartialObservation>();
  const items: ClaudeTranscriptContextItem[] = [];
  const cwdCounts = new Map<string, number>();
  let startTimestampMs = 0;
  let endTimestampMs = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseJsonLine(lines[index]);
    if (!parsed) {
      continue;
    }

    const envelope = extractEnvelope(parsed);
    const timestampMs = envelope?.timestampMs || parseTimestamp(getValueAtPath(parsed, ['timestamp'])) || 0;
    const cwd = envelope?.cwd || getStringAtPaths(parsed, [['cwd']]) || '';
    updateSessionBounds(cwdCounts, cwd, timestampMs, (value) => {
      startTimestampMs = startTimestampMs === 0 ? value : Math.min(startTimestampMs, value);
      endTimestampMs = Math.max(endTimestampMs, value);
    });

    if (!envelope) {
      continue;
    }

    if (envelope.text) {
      const isCompactSummary = isCompactSummaryPayload(parsed);
      messages.push({
        order: index,
        timestampMs,
        role: envelope.role,
        text: envelope.text,
        isCompactSummary,
        isSynthetic: isCompactSummary || isSyntheticMessagePayload(parsed),
      });
      items.push({ order: index, tokenCount: await countTokensBySource(envelope.text, target.source || 'claude') });
    }

    for (const toolUse of envelope.toolUses) {
      const partial = buildObservationSeed(target, {
        source: target.source,
        sourceToolName: toolUse.name,
        name: toolUse.name,
        id: toolUse.id,
        order: index,
        timestampMs,
        input: toolUse.input,
        cwd,
        rawInputText: stringifyValue(toolUse.input),
      });
      partial.sourceToolAssistantUUID = getStringAtPaths(parsed, [['sourceToolAssistantUUID']]) || '';
      partial.parentToolUseId =
        getStringAtPaths(parsed, [['parentToolUseID'], ['parentToolUseId'], ['data', 'parentToolUseID']]) || '';
      partial.isTaskTool = toolUse.name.toLowerCase() === 'task';
      partial.isSubagentProgress = isSubagentProgressPayload(parsed);
      observations.set(toolUse.id, mergeObservation(observations.get(toolUse.id), partial));
    }

    for (const toolResult of envelope.toolResults) {
      const existing = observations.get(toolResult.toolUseId);
      const toolName = existing?.name ?? 'unknown';
      const meta = extractClaudeToolResultMeta(parsed, toolName);
      observations.set(
        toolResult.toolUseId,
        buildObservationResult(target, existing, {
          source: target.source,
          sourceToolName: existing?.sourceToolName ?? toolName,
          name: toolName,
          id: toolResult.toolUseId,
          order: existing?.order ?? index,
          timestampMs: existing?.timestampMs ?? timestampMs,
          cwd: existing?.cwd ?? cwd,
          input: existing?.input ?? {},
          inputText: existing?.inputText ?? '',
          preferredContent: pickPreferredToolResultContent(toolResult.content, meta),
          isError: toolResult.isError,
          meta,
        })
      );
    }
  }

  return finalizeSession(target, { source: target.source, model: 'unknown', contextWindowTokens: null }, {
    cwdCounts,
    startTimestampMs,
    endTimestampMs,
    messages,
    observations,
    items,
  });
}

async function parseCodexTranscriptSession(
  target: ClaudeTranscriptTarget & { source: 'codex' }
): Promise<ClaudeTranscriptSession | null> {
  const raw = await readTextFile(target.filePath);
  if (raw === null) {
    return null;
  }

  const lines = splitJsonl(raw);
  const messages: ClaudeTranscriptMessage[] = [];
  const observations = new Map<string, PartialObservation>();
  const items: ClaudeTranscriptContextItem[] = [];
  const cwdCounts = new Map<string, number>();
  let startTimestampMs = 0;
  let endTimestampMs = 0;
  let model = 'unknown';
  let contextWindowTokens: number | null = null;
  let fallbackCwd = '';

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseJsonLine(lines[index]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const lineType = getStringAtPaths(record, [['type']]) || '';
    const payload = getObjectAtPath(record, ['payload']);
    const timestampMs = parseTimestamp(record.timestamp) || parseTimestamp(getValueAtPath(payload, ['timestamp'])) || 0;
    updateSessionBounds(cwdCounts, '', timestampMs, (value) => {
      startTimestampMs = startTimestampMs === 0 ? value : Math.min(startTimestampMs, value);
      endTimestampMs = Math.max(endTimestampMs, value);
    });

    if (lineType === 'session_meta' || lineType === 'turn_context') {
      const cwd = getStringAtPaths(payload, [['cwd']]) || getStringAtPaths(record, [['cwd']]) || '';
      if (cwd) {
        fallbackCwd = cwd;
        cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
      }
      model = getStringAtPaths(payload, [['model'], ['model_name']]) || model;
      contextWindowTokens =
        toNullableNumber(getValueAtPath(payload, ['model_context_window'])) ??
        toNullableNumber(getValueAtPath(payload, ['context_window_tokens'])) ??
        contextWindowTokens;
      continue;
    }

    if (lineType === 'event_msg') {
      if ((getStringAtPaths(payload, [['type']]) || '') === 'token_count') {
        contextWindowTokens =
          toNullableNumber(getValueAtPath(payload, ['info', 'model_context_window'])) ??
          toNullableNumber(getValueAtPath(payload, ['model_context_window'])) ??
          contextWindowTokens;
      }
      continue;
    }

    if (lineType !== 'response_item' || !payload) {
      continue;
    }

    const payloadType = getStringAtPaths(payload, [['type']]) || '';
    if (payloadType === 'message') {
      const role =
        (getStringAtPaths(payload, [['role']]) || '') === 'assistant'
          ? 'assistant'
          : (getStringAtPaths(payload, [['role']]) || '') === 'user'
          ? 'user'
          : 'unknown';
      if (role === 'unknown') {
        continue;
      }
      const text = normalizeCodexMessageText(getValueAtPath(payload, ['content']));
      if (!text) {
        continue;
      }
      messages.push({
        order: index,
        timestampMs,
        role,
        text,
        isCompactSummary: false,
        isSynthetic: false,
      });
      items.push({ order: index, tokenCount: await countTokensBySource(text, target.source) });
      continue;
    }

    if (payloadType === 'function_call') {
      const sourceToolName = getStringAtPaths(payload, [['name']]) || 'unknown';
      const rawArguments = getStringAtPaths(payload, [['arguments']]) || '';
      const input = parseCodexFunctionArguments(rawArguments, sourceToolName);
      const toolName = normalizeCodexToolName(sourceToolName, input);
      const cwd =
        getStringAtPaths(input, [['workdir'], ['cwd'], ['working_directory'], ['workingDirectory']]) || fallbackCwd;
      if (cwd) {
        fallbackCwd = cwd;
        cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
      }
      const id = getStringAtPaths(payload, [['call_id'], ['callId']]) || `call-${index + 1}`;
      observations.set(
        id,
        mergeObservation(
          observations.get(id),
          buildObservationSeed(target, {
            source: 'codex',
            sourceToolName,
            name: toolName,
            id,
            order: index,
            timestampMs,
            input,
            cwd,
            rawInputText: rawArguments || stringifyValue(input),
          })
        )
      );
      continue;
    }

    if (payloadType === 'function_call_output') {
      const id = getStringAtPaths(payload, [['call_id'], ['callId']]) || `call-${index + 1}`;
      const existing = observations.get(id);
      const sourceToolName = existing?.sourceToolName ?? 'unknown';
      const toolName = existing?.name ?? normalizeCodexToolName(sourceToolName, existing?.input ?? {});
      const meta = extractCodexToolResultMeta(getStringAtPaths(payload, [['output']]) || '', toolName);
      observations.set(
        id,
        buildObservationResult(target, existing, {
          source: 'codex',
          sourceToolName,
          name: toolName,
          id,
          order: existing?.order ?? index,
          timestampMs: existing?.timestampMs ?? timestampMs,
          cwd: existing?.cwd ?? fallbackCwd,
          input: existing?.input ?? {},
          inputText: existing?.inputText ?? '',
          preferredContent: pickPreferredToolResultContent(getStringAtPaths(payload, [['output']]) || '', meta),
          isError: meta.success === false,
          meta,
        })
      );
    }
  }

  return finalizeSession(target, { source: 'codex', model, contextWindowTokens }, {
    cwdCounts,
    startTimestampMs,
    endTimestampMs,
    messages,
    observations,
    items,
  });
}

function finalizeSession(
  target: ClaudeTranscriptTarget,
  meta: { source: TranscriptSource; model: string; contextWindowTokens: number | null },
  state: {
    cwdCounts: Map<string, number>;
    startTimestampMs: number;
    endTimestampMs: number;
    messages: ClaudeTranscriptMessage[];
    observations: Map<string, PartialObservation>;
    items: ClaudeTranscriptContextItem[];
  }
): ClaudeTranscriptSession {
  const normalizedObservations = Array.from(state.observations.values())
    .map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      filePath: item.filePath,
      source: item.source,
      sourceToolName: item.sourceToolName,
      order: item.order,
      timestampMs: item.timestampMs,
      name: item.name,
      input: item.input,
      inputText: item.inputText,
      resultContent: item.resultContent ?? '',
      resultTokens: item.resultTokens ?? 0,
      estimatedTokens:
        item.estimatedTokens ??
        estimateObservationTokens(item.name, item.input, item.resultContent ?? '', item.sourceToolName),
      isError: item.isError ?? false,
      cwd: item.cwd,
      rawTargetPath: item.rawTargetPath,
      targetPath: item.targetPath,
      command: item.command,
      writePayload: item.writePayload,
      stdout: item.stdout ?? '',
      stderr: item.stderr ?? '',
      interrupted: item.interrupted ?? false,
      successFlag: item.successFlag ?? null,
      fileRange: item.fileRange ?? null,
      resultPaths: uniqStrings(item.resultPaths ?? []),
      durationMs: item.durationMs ?? null,
      numFiles: item.numFiles ?? null,
      truncated: item.truncated ?? false,
      userModified: item.userModified ?? null,
      structuredPatchText: item.structuredPatchText ?? '',
      structuredPatchCount: item.structuredPatchCount ?? 0,
      oldString: item.oldString ?? '',
      newString: item.newString ?? '',
      sourceToolAssistantUUID: item.sourceToolAssistantUUID ?? '',
      parentToolUseId: item.parentToolUseId ?? '',
      isTaskTool: item.isTaskTool ?? item.name.toLowerCase() === 'task',
      isSubagentProgress: item.isSubagentProgress ?? false,
    }))
    .sort((a, b) => a.order - b.order || a.timestampMs - b.timestampMs);

  for (const observation of normalizedObservations) {
    if (observation.estimatedTokens > 0) {
      state.items.push({ order: observation.order, tokenCount: observation.estimatedTokens });
    }
  }

  return {
    sessionId: target.sessionId,
    filePath: target.filePath,
    source: meta.source,
    workspaceRoot: resolveMostCommonPath(state.cwdCounts),
    model: meta.model || 'unknown',
    contextWindowTokens: meta.contextWindowTokens,
    startTimestampMs: state.startTimestampMs,
    endTimestampMs: state.endTimestampMs,
    messages: state.messages,
    observations: normalizedObservations,
    items: state.items,
  };
}

function buildObservationSeed(
  target: ClaudeTranscriptTarget,
  input: {
    source: TranscriptSource;
    sourceToolName: string;
    name: string;
    id: string;
    order: number;
    timestampMs: number;
    input: Record<string, unknown>;
    cwd: string;
    rawInputText: string;
  }
): PartialObservation {
  const rawTargetPath = extractToolTargetPath(input.name, input.input, input.sourceToolName);
  return {
    id: input.id,
    sessionId: target.sessionId,
    filePath: target.filePath,
    source: input.source,
    sourceToolName: input.sourceToolName,
    order: input.order,
    timestampMs: input.timestampMs,
    name: input.name,
    input: input.input,
    inputText: input.rawInputText,
    cwd: input.cwd,
    rawTargetPath,
    targetPath: resolveObservationPath(rawTargetPath, input.cwd),
    command: extractToolCommand(input.name, input.input, input.sourceToolName),
    writePayload: extractWritePayload(input.name, input.input, input.sourceToolName, input.rawInputText),
    sourceToolAssistantUUID: '',
    parentToolUseId: '',
    isTaskTool: input.sourceToolName.toLowerCase() === 'task',
    isSubagentProgress: false,
  };
}

function buildObservationResult(
  target: ClaudeTranscriptTarget,
  existing: PartialObservation | undefined,
  input: {
    source: TranscriptSource;
    sourceToolName: string;
    name: string;
    id: string;
    order: number;
    timestampMs: number;
    cwd: string;
    input: Record<string, unknown>;
    inputText: string;
    preferredContent: string;
    isError: boolean;
    meta: StructuredToolResultMeta;
  }
): PartialObservation {
  return {
    id: input.id,
    sessionId: target.sessionId,
    filePath: target.filePath,
    source: input.source,
    sourceToolName: input.sourceToolName,
    order: input.order,
    timestampMs: input.timestampMs,
    name: input.name,
    input: input.input,
    inputText: input.inputText,
    cwd: input.cwd,
    rawTargetPath: existing?.rawTargetPath ?? '',
    targetPath: existing?.targetPath ?? '',
    command: existing?.command ?? '',
    writePayload: existing?.writePayload ?? '',
    resultContent: input.preferredContent,
    resultTokens: estimateTokenCount(input.preferredContent),
    estimatedTokens: estimateObservationTokens(input.name, input.input, input.preferredContent, input.sourceToolName),
    isError: input.isError,
    stdout: input.meta.stdout,
    stderr: input.meta.stderr,
    interrupted: input.meta.interrupted,
    successFlag: input.meta.success,
    fileRange: input.meta.fileRange,
    resultPaths: input.meta.rawResultPaths,
    durationMs: input.meta.durationMs,
    numFiles: input.meta.numFiles,
    truncated: input.meta.truncated,
    userModified: input.meta.userModified,
    structuredPatchText: input.meta.structuredPatchText,
    structuredPatchCount: input.meta.structuredPatchCount,
    oldString: input.meta.oldString,
    newString: input.meta.newString,
    sourceToolAssistantUUID: existing?.sourceToolAssistantUUID ?? '',
    parentToolUseId: existing?.parentToolUseId ?? '',
    isTaskTool: existing?.isTaskTool ?? input.sourceToolName.toLowerCase() === 'task',
    isSubagentProgress: existing?.isSubagentProgress ?? false,
  };
}

function mergeObservation(existing: PartialObservation | undefined, next: PartialObservation): PartialObservation {
  return {
    ...existing,
    ...next,
    resultContent: existing?.resultContent,
    resultTokens: existing?.resultTokens,
    estimatedTokens: existing?.estimatedTokens,
    isError: existing?.isError,
    stdout: existing?.stdout,
    stderr: existing?.stderr,
    interrupted: existing?.interrupted,
    successFlag: existing?.successFlag,
    fileRange: existing?.fileRange,
    resultPaths: existing?.resultPaths,
    durationMs: existing?.durationMs,
    numFiles: existing?.numFiles,
    truncated: existing?.truncated,
    userModified: existing?.userModified,
    structuredPatchText: existing?.structuredPatchText,
    structuredPatchCount: existing?.structuredPatchCount,
    oldString: existing?.oldString,
    newString: existing?.newString,
  };
}

function resolveTranscriptSource(target: ClaudeTranscriptTarget): TranscriptSource {
  if (target.source) {
    return target.source;
  }
  const normalizedPath = target.filePath.replace(/\\/g, '/').toLowerCase();
  if (normalizedPath.includes('/.cursor/projects/') || normalizedPath.includes('/agent-transcripts/')) {
    return 'cursor';
  }
  return normalizedPath.includes('/.codex/sessions/') || normalizedPath.includes('/.codex/archived_sessions/')
    ? 'codex'
    : 'claude';
}

function extractEnvelope(payload: unknown): Envelope | null {
  const direct = readMessageShape(payload);
  if (direct) {
    return direct;
  }
  const nested =
    getObjectAtPath(payload, ['message', 'message']) ??
    getObjectAtPath(payload, ['message']) ??
    getObjectAtPath(payload, ['data', 'message', 'message']) ??
    getObjectAtPath(payload, ['data', 'message']);
  return nested ? readMessageShape(nested, payload) : null;
}

function readMessageShape(messagePayload: unknown, fallbackPayload?: unknown): Envelope | null {
  if (!messagePayload || typeof messagePayload !== 'object' || Array.isArray(messagePayload)) {
    return null;
  }
  const record = messagePayload as Record<string, unknown>;
  if (typeof record.role !== 'string' && record.content === undefined) {
    return null;
  }

  const role =
    record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : record.role === 'system' ? 'system' : 'unknown';
  const blocks = normalizeContentBlocks(record.content);
  const text: string[] = [];
  const toolUses: Envelope['toolUses'] = [];
  const toolResults: Envelope['toolResults'] = [];

  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id && block.name) {
      toolUses.push({ id: block.id, name: block.name, input: block.input });
    } else if (block.type === 'tool_result' && block.toolUseId) {
      toolResults.push({ toolUseId: block.toolUseId, content: block.text, isError: block.isError });
    } else if (block.text) {
      text.push(block.text);
    }
  }

  return {
    role,
    text: normalizeMessageText(text.join('\n')),
    toolUses,
    toolResults,
    timestampMs:
      parseTimestamp(record.timestamp) ||
      parseTimestamp(getValueAtPath(fallbackPayload, ['data', 'message', 'timestamp'])) ||
      parseTimestamp(getValueAtPath(fallbackPayload, ['timestamp'])) ||
      0,
    cwd: getStringAtPaths(fallbackPayload, [['cwd']]) || getStringAtPaths(record, [['cwd']]) || '',
  };
}

function normalizeContentBlocks(content: unknown): Array<{
  type: 'text' | 'tool_use' | 'tool_result';
  text: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
  isError: boolean;
}> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, id: '', name: '', input: {}, toolUseId: '', isError: false }];
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
      const type = getStringAtPaths(record, [['type']]) || 'text';
      if (type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          text: '',
          id: getStringAtPaths(record, [['id']]) || '',
          name: getStringAtPaths(record, [['name']]) || '',
          input: getObjectAtPath(record, ['input']) ?? {},
          toolUseId: '',
          isError: false,
        };
      }
      if (type === 'tool_result') {
        return {
          type: 'tool_result' as const,
          text: normalizeToolResultContent(record.content),
          id: '',
          name: '',
          input: {},
          toolUseId: getStringAtPaths(record, [['tool_use_id']]) || '',
          isError: getValueAtPath(record, ['is_error']) === true,
        };
      }
      return {
        type: 'text' as const,
        text:
          getStringAtPaths(record, [['text'], ['content']]) ||
          '',
        id: '',
        name: '',
        input: {},
        toolUseId: '',
        isError: false,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return stripSystemReminder(content).trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return '';
      }
      const record = item as Record<string, unknown>;
      return getStringAtPaths(record, [['text'], ['content']]) || '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeCodexMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return normalizeMessageText(content);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return normalizeMessageText(
    content
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return '';
        }
        const record = item as Record<string, unknown>;
        const type = getStringAtPaths(record, [['type']]) || '';
        return type === 'input_text' || type === 'output_text' || type === 'text'
          ? getStringAtPaths(record, [['text'], ['content']]) || ''
          : '';
      })
      .filter(Boolean)
      .join('\n')
  );
}

function normalizeMessageText(input: string): string {
  const normalized = stripSystemReminder(input).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) {
    return '';
  }
  return normalized.includes('<local-command-caveat>') ||
    normalized.includes('<local-command-stdout>') ||
    normalized.includes('<command-name>')
    ? ''
    : normalized;
}

function stripSystemReminder(input: string): string {
  return input.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
}

function estimateObservationTokens(
  name: string,
  input: Record<string, unknown>,
  resultContent: string,
  sourceToolName?: string
): number {
  const minimumToolFootprint = name.toLowerCase() === 'read' ? 0 : 12;
  return Math.max(
    estimateTokenCount(resultContent),
    estimateTokenCount(stringifyValue(input)),
    estimateTokenCount(extractWritePayload(name, input, sourceToolName)),
    minimumToolFootprint
  );
}

function extractToolTargetPath(name: string, input: Record<string, unknown>, sourceToolName?: string): string {
  const direct =
    getStringAtPaths(input, [
      ['file_path'],
      ['filePath'],
      ['path'],
      ['directory'],
      ['dir'],
      ['cwd'],
      ['workdir'],
      ['working_directory'],
      ['workingDirectory'],
    ]) || '';
  if (direct) {
    return direct;
  }
  const normalized = name.toLowerCase();
  const sourceName = (sourceToolName ?? name).toLowerCase();
  return normalized === 'bash' || normalized === 'read' || normalized === 'grep' || normalized === 'ls' || sourceName === 'shell_command'
    ? extractPathFromCommand(extractToolCommand(name, input, sourceToolName))
    : '';
}

function extractToolCommand(name: string, input: Record<string, unknown>, sourceToolName?: string): string {
  const normalized = name.toLowerCase();
  const sourceName = (sourceToolName ?? name).toLowerCase();
  return normalized === 'bash' || normalized === 'read' || normalized === 'grep' || normalized === 'ls' || sourceName === 'shell_command'
    ? getStringAtPaths(input, [['command'], ['cmd']]) || ''
    : getStringAtPaths(input, [['description'], ['prompt']]) || '';
}

function extractWritePayload(
  name: string,
  input: Record<string, unknown>,
  sourceToolName?: string,
  rawInputText?: string
): string {
  const normalized = name.toLowerCase();
  const sourceName = (sourceToolName ?? name).toLowerCase();
  if (!TOOL_MUTATION_NAMES.has(normalized) && !TOOL_MUTATION_NAMES.has(sourceName)) {
    return '';
  }
  const direct = getStringAtPaths(input, [['content'], ['new_string'], ['newString'], ['newText'], ['text'], ['patch']]) || '';
  if (direct) {
    return direct;
  }
  const edits = getValueAtPath(input, ['edits']);
  if (Array.isArray(edits)) {
    return edits
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return '';
        }
        const record = item as Record<string, unknown>;
        return [
          getStringAtPaths(record, [['old_string'], ['oldString']]) || '',
          getStringAtPaths(record, [['new_string'], ['newString']]) || '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .filter(Boolean)
      .join('\n');
  }
  return sourceName === 'apply_patch' ? rawInputText?.trim() || '' : '';
}

function extractClaudeToolResultMeta(payload: unknown, toolName: string): StructuredToolResultMeta {
  const record = getValueAtPath(payload, ['toolUseResult']) ?? getValueAtPath(payload, ['data', 'toolUseResult']);
  if (!record) {
    return emptyToolResultMeta();
  }
  if (typeof record === 'string') {
    return { ...emptyToolResultMeta(), preferredContent: normalizeToolResultContent(record), stderr: record };
  }

  const fileRecord = getObjectAtPath(record, ['file']);
  const structuredPatch = getValueAtPath(record, ['structuredPatch']);
  const structuredPatchText = structuredPatch === undefined || structuredPatch === null ? '' : stringifyValue(structuredPatch);
  const rawResultPaths: string[] = [];
  const filePathValue = getStringAtPaths(fileRecord, [['filePath'], ['file_path']]);
  if (filePathValue) {
    rawResultPaths.push(filePathValue);
  }
  const filenames = getValueAtPath(record, ['filenames']);
  if (Array.isArray(filenames)) {
    filenames.forEach((item) => {
      if (typeof item === 'string' && item.trim()) {
        rawResultPaths.push(item.trim());
      }
    });
  }

  return {
    preferredContent: pickStructuredResultContent(
      toolName,
      getStringAtPaths(fileRecord, [['content']]) || '',
      rawResultPaths,
      structuredPatchText
    ),
    stdout: getStringAtPaths(record, [['stdout']]) || '',
    stderr: getStringAtPaths(record, [['stderr']]) || '',
    interrupted: getValueAtPath(record, ['interrupted']) === true,
    success: typeof getValueAtPath(record, ['success']) === 'boolean' ? (getValueAtPath(record, ['success']) as boolean) : null,
    fileRange: fileRecord
      ? {
          startLine: toPositiveNumber(getValueAtPath(fileRecord, ['startLine'])),
          numLines: toPositiveNumber(getValueAtPath(fileRecord, ['numLines'])),
          totalLines: toPositiveNumber(getValueAtPath(fileRecord, ['totalLines'])),
        }
      : null,
    rawResultPaths,
    durationMs: toNullableNumber(getValueAtPath(record, ['durationMs'])),
    numFiles: toNullableNumber(getValueAtPath(record, ['numFiles'])) ?? (Array.isArray(filenames) ? filenames.length : null),
    truncated: getValueAtPath(record, ['truncated']) === true,
    userModified: typeof getValueAtPath(record, ['userModified']) === 'boolean' ? (getValueAtPath(record, ['userModified']) as boolean) : null,
    structuredPatchText,
    structuredPatchCount: Array.isArray(structuredPatch) ? structuredPatch.length : structuredPatch ? 1 : 0,
    oldString: getStringAtPaths(record, [['oldString'], ['old_string']]) || '',
    newString: getStringAtPaths(record, [['newString'], ['new_string']]) || '',
  };
}

function extractCodexToolResultMeta(output: string, toolName: string): StructuredToolResultMeta {
  const trimmed = output.replace(/\r\n/g, '\n').trim();
  if (!trimmed) {
    return emptyToolResultMeta();
  }
  const exitCode = toNullableNumber(trimmed.match(/Exit code:\s*(-?\d+)/i)?.[1] ?? null);
  const body = (trimmed.match(/\bOutput:\n([\s\S]*)$/i)?.[1] ?? trimmed).trim();
  return {
    preferredContent: body || trimmed,
    stdout: body,
    stderr: exitCode !== null && exitCode !== 0 ? body || trimmed : '',
    interrupted: false,
    success: exitCode === null ? null : exitCode === 0,
    fileRange: null,
    rawResultPaths: [],
    durationMs: null,
    numFiles: null,
    truncated: /\btruncat(ed|ion)?\b/i.test(trimmed),
    userModified: null,
    structuredPatchText: toolName === 'write' ? body : '',
    structuredPatchCount: toolName === 'write' && body ? 1 : 0,
    oldString: '',
    newString: '',
  };
}

function emptyToolResultMeta(): StructuredToolResultMeta {
  return {
    preferredContent: '',
    stdout: '',
    stderr: '',
    interrupted: false,
    success: null,
    fileRange: null,
    rawResultPaths: [],
    durationMs: null,
    numFiles: null,
    truncated: false,
    userModified: null,
    structuredPatchText: '',
    structuredPatchCount: 0,
    oldString: '',
    newString: '',
  };
}

function pickStructuredResultContent(toolName: string, fileContent: string, rawResultPaths: string[], structuredPatchText: string): string {
  if (toolName.toLowerCase() === 'read' && fileContent) {
    return fileContent;
  }
  if (rawResultPaths.length > 0 && DIRECTORY_TOOLS.has(toolName.toLowerCase())) {
    return rawResultPaths.join('\n');
  }
  if (structuredPatchText && TOOL_MUTATION_NAMES.has(toolName.toLowerCase())) {
    return structuredPatchText;
  }
  return '';
}

function pickPreferredToolResultContent(envelopeContent: string, meta: StructuredToolResultMeta): string {
  return meta.preferredContent || (!envelopeContent && (meta.stderr || meta.stdout)) || envelopeContent;
}

function resolveObservationPath(rawTargetPath: string, cwd: string): string {
  const trimmed = rawTargetPath.trim();
  if (!trimmed) {
    return '';
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  return cwd ? path.resolve(cwd, trimmed) : path.normalize(trimmed);
}

function normalizeCodexToolName(sourceToolName: string, input: Record<string, unknown>): string {
  const normalized = sourceToolName.trim().toLowerCase();
  if (normalized === 'apply_patch') {
    return 'write';
  }
  if (normalized === 'read_thread_terminal') {
    return 'read';
  }
  return normalized === 'shell_command' ? classifyShellCommand(getStringAtPaths(input, [['command'], ['cmd']]) || '') : 'other';
}

function classifyShellCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return 'bash';
  }
  if (/\brg\s+--files\b/.test(normalized) || /^(?:get-childitem|ls|dir|tree)\b/.test(normalized)) {
    return 'ls';
  }
  if (/^(?:get-content|cat|type|more)\b/.test(normalized) || /\|\s*(?:get-content|cat)\b/.test(normalized)) {
    return 'read';
  }
  if (/\b(?:select-string|grep|findstr)\b/.test(normalized) || (/\brg\b/.test(normalized) && !/\brg\s+--files\b/.test(normalized))) {
    return 'grep';
  }
  return 'bash';
}

function parseCodexFunctionArguments(rawArguments: string, sourceToolName: string): Record<string, unknown> {
  if (!rawArguments.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return sourceToolName.toLowerCase() === 'apply_patch' ? { patch: rawArguments } : {};
  }
}

function extractPathFromCommand(command: string): string {
  if (!command) {
    return '';
  }
  const quoted = command.match(/["']([A-Za-z]:[\\/][^"']+|\.{0,2}[\\/][^"']+)["']/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  return (
    command.match(
      /(?:get-content|cat|type|more|ls|dir|tree|find|get-childitem|rg --files|select-string|grep|findstr)\s+([A-Za-z]:[\\/][^\s|]+|\.{0,2}[\\/][^\s|]+)/i
    )?.[1] ?? ''
  );
}

function readTextFile(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').catch(() => null);
}

function splitJsonl(raw: string): string[] {
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function updateSessionBounds(
  cwdCounts: Map<string, number>,
  cwd: string,
  timestampMs: number,
  onTimestamp: (timestampMs: number) => void
): void {
  if (cwd) {
    cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
  }
  if (timestampMs > 0) {
    onTimestamp(timestampMs);
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getObjectAtPath(payload: unknown, keyPath: string[]): Record<string, unknown> | null {
  const value = getValueAtPath(payload, keyPath);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getStringAtPaths(payload: unknown, keyPaths: string[][]): string | null {
  for (const keyPath of keyPaths) {
    const value = getValueAtPath(payload, keyPath);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getValueAtPath(payload: unknown, keyPath: string[]): unknown {
  let current: unknown = payload;
  for (const key of keyPath) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1000000000 && value < 1000000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? (numeric > 1000000000 && numeric < 1000000000000 ? numeric * 1000 : numeric) : 0;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function resolveMostCommonPath(counts: Map<string, number>): string {
  let winner = '';
  let best = 0;
  counts.forEach((count, value) => {
    if (count > best) {
      best = count;
      winner = value;
    }
  });
  return winner ? path.resolve(winner) : '';
}

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function toPositiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isCompactSummaryPayload(payload: unknown): boolean {
  return getValueAtPath(payload, ['isCompactSummary']) === true || getValueAtPath(payload, ['data', 'isCompactSummary']) === true;
}

function isSubagentProgressPayload(payload: unknown): boolean {
  return getValueAtPath(payload, ['type']) === 'progress' && getValueAtPath(payload, ['data', 'type']) === 'agent_progress';
}

function isSyntheticMessagePayload(payload: unknown): boolean {
  const payloadType = getValueAtPath(payload, ['type']);
  return isCompactSummaryPayload(payload) || payloadType === 'progress' || payloadType === 'queue-operation' || payloadType === 'file-history-snapshot';
}
