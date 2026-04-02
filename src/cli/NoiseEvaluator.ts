import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import {
  parseClaudeTranscriptSession,
  type TranscriptSource,
  type ClaudeTranscriptContextItem as ContextItem,
  type ClaudeTranscriptSession as ParsedSession,
  type ClaudeTranscriptObservation as ToolObservation,
} from './ClaudeTranscriptParser.js';
import { PromptAssetScanner } from './PromptAssetScanner.js';
import { SkillScanner } from './SkillScanner.js';
import { estimateTokenCount } from './tokenEstimate.js';

const execFileAsync = promisify(execFile);

export type NoiseEvaluationTarget = {
  sessionId: string;
  filePath: string;
  source?: TranscriptSource;
};

export type NoiseMetricStatus = 'ok' | 'watch' | 'high' | 'na';
export type NoiseDimensionKey = 'outcome' | 'process' | 'context' | 'validation';
export type CoverageDimensionKey = NoiseDimensionKey | 'attribution';
export type EvidenceTrustLevel = 'T1' | 'T2' | 'T3';
export type EvidenceReliability = 'high' | 'medium' | 'low';
export type NoiseConfidence = 'high' | 'medium' | 'low';

export type NoiseMetric = {
  key: string;
  label: string;
  status: NoiseMetricStatus;
  value: string;
  trust: EvidenceTrustLevel;
  summary: string;
  missingEvidence: string[];
};

export type NoiseSignal = {
  dimension: NoiseDimensionKey;
  key: string;
  label: string;
  status: Exclude<NoiseMetricStatus, 'na' | 'ok'>;
  trust: EvidenceTrustLevel;
  sessionId: string;
  timestampLabel: string;
  target: string;
  tokenImpact: number;
  summary: string;
  evidence: string[];
  order: number;
};

export type NoiseDimensionReport = {
  key: NoiseDimensionKey;
  label: string;
  available: boolean;
  status: NoiseMetricStatus;
  confidence: NoiseConfidence;
  summary: string;
  observedFacts: string[];
  derivedFeatures: string[];
  semanticJudgments: string[];
  metrics: NoiseMetric[];
  signals: NoiseSignal[];
};

export type NoiseCoverageRow = {
  dimension: CoverageDimensionKey;
  available: boolean;
  sources: string[];
  reliability: EvidenceReliability;
  notes: string;
};

export type NoiseSessionSummary = {
  sessionId: string;
  filePath: string;
  workspaceRoot: string;
  startTime: string;
  endTime: string;
  totalTokens: number;
  totalToolCalls: number;
  readCalls: number;
  writeCalls: number;
  bashCalls: number;
};

export type NoiseFileHotspot = {
  path: string;
  reads: number;
  duplicateReads: number;
  tokens: number;
};

export type GitDiffFile = {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown';
  addedLines: number | null;
  deletedLines: number | null;
  attributed: boolean | null;
  generatedLike: boolean;
};

export type GitDiffSummary = {
  workspaceRoot: string;
  repoRoot: string;
  files: GitDiffFile[];
  totalChangedFiles: number;
  totalAddedLines: number;
  totalDeletedLines: number;
  generatedLikeFiles: number;
  topLevelAreas: string[];
  unattributedFiles: string[];
  attributedFiles: string[];
};

export type PromptAssetUsage = {
  relativePath: string;
  kind: 'prompt' | 'skill';
  label: string;
  totalReadTokens: number;
  duplicateReadTokens: number;
  readCount: number;
  usedLater: boolean;
};

export type NoiseEvaluationReport = {
  workspaceRoot: string;
  workspaceRootsSeen: string[];
  sessionsScanned: number;
  sessionsAnalyzed: number;
  totalEstimatedTokens: number;
  totalToolCalls: number;
  coverageGrade: 'A' | 'B' | 'C' | 'D';
  coverage: NoiseCoverageRow[];
  feasibleScope: string[];
  sessionSummaries: NoiseSessionSummary[];
  dimensions: NoiseDimensionReport[];
  git: GitDiffSummary | null;
  promptAssets: PromptAssetUsage[];
  fileHotspots: NoiseFileHotspot[];
  warnings: string[];
  nextActions: string[];
};

type UsageEvidence = {
  pathMutation: boolean;
  resultPathFollowup: boolean;
  sameDirectoryFollowup: boolean;
  pathMentioned: boolean;
  filenameMentioned: boolean;
  strongKeywordHit: boolean;
  weakKeywordHit: boolean;
};

type ProcessSummary = {
  totalRecoverableTokens: number;
  duplicateCalls: number;
  signals: NoiseSignal[];
  readRecords: Array<{
    sessionId: string;
    path: string;
    cwd: string;
    tokenCount: number;
    order: number;
    resultContent: string;
    usedLater: boolean;
  }>;
  fileHotspots: NoiseFileHotspot[];
  metrics: {
    duplicateReadTokens: number;
    staleReadTokens: number;
    bashDuplicateTokens: number;
    readBloatTokens: number;
    bashBloatTokens: number;
    missedSearches: number;
    writeNoops: number;
    redundantScans: number;
    editChurnFiles: number;
  };
};

type PromptSummary = {
  scannedAssets: number;
  scannedPromptFiles: number;
  scannedSkills: number;
  matchedAssets: PromptAssetUsage[];
  readOnlyLoadTokens: number;
  duplicatePromptReadTokens: number;
};

type ValidationSummary = {
  writesObserved: number;
  successfulValidationRuns: number;
  failedValidationRuns: number;
  validationAfterLastWrite: boolean;
  unsupportedClaims: number;
  signals: NoiseSignal[];
};

type OutcomeSummary = {
  git: GitDiffSummary | null;
};

type WorkspaceResolution = {
  workspaceRoot: string;
  workspaceRootsSeen: string[];
  multiWorkspace: boolean;
};

const TOOL_MUTATION_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const DIRECTORY_TOOLS = new Set(['ls', 'glob']);

const DUPLICATE_LOOKBACK_MS = 5 * 60 * 1000;
const DUPLICATE_LOOKBACK_STEPS = 20;
const STALE_INTERVENING_TOKENS = 4000;
const STALE_STEP_GAP = 12;
const READ_BLOAT_MIN_TOKENS = 1200;
const BASH_BLOAT_MIN_TOKENS = 900;
const BROAD_SCAN_ENTRY_THRESHOLD = 50;

const STOPWORDS = new Set([
  'this', 'that', 'from', 'with', 'have', 'were', 'will', 'would', 'should', 'about',
  'there', 'their', 'error', 'warning', 'result', 'value', 'type', 'name', 'data',
  'true', 'false', 'null', 'undefined', 'return', 'const', 'class', 'function',
  'import', 'export', 'async', 'await', 'string', 'number', 'boolean', 'object',
  'array', 'index', 'item', 'list', 'file', 'path', 'line', 'code', 'text', 'info',
  'debug', 'test', 'spec', 'util', 'helper', 'service', 'module', 'config', 'setup',
  'init', 'run', 'get', 'set', 'add', 'new', 'old', 'use', 'key', 'map', 'log',
]);

const GENERATED_LIKE_DIRECTORIES = new Set(['dist', 'build', 'coverage', 'out', '.next']);
const GENERATED_LIKE_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);

const VALIDATION_COMMAND_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'test', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i },
  { kind: 'lint', pattern: /\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b/i },
  { kind: 'build', pattern: /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i },
  { kind: 'typecheck', pattern: /\b(?:npm|pnpm|yarn|bun)\s+run\s+typecheck\b/i },
  { kind: 'typecheck', pattern: /\btsc(?:\s|$)/i },
  { kind: 'test', pattern: /\bvitest\b/i },
  { kind: 'test', pattern: /\bjest\b/i },
  { kind: 'test', pattern: /\bpytest\b/i },
  { kind: 'test', pattern: /\bcargo\s+test\b/i },
  { kind: 'test', pattern: /\bgo\s+test\b/i },
  { kind: 'lint', pattern: /\beslint\b/i },
];

const COMPLETION_CLAIM_PATTERNS: Array<{ key: string; explicitValidation: boolean; pattern: RegExp }> = [
  { key: 'done', explicitValidation: false, pattern: /\b(done|completed|implemented|fixed|refactored|updated)\b/i },
  { key: 'verified', explicitValidation: true, pattern: /\b(verified|validated|confirmed|tests?\s+pass(?:ed)?|build\s+pass(?:ed)?|lint\s+pass(?:ed)?)\b/i },
  { key: 'done_zh', explicitValidation: false, pattern: /(完成了|已经完成|已实现|已修复|重构了|已经更新)/ },
  { key: 'verified_zh', explicitValidation: true, pattern: /(测试通过|构建通过|验证通过|已经验证)/ },
];

export class NoiseEvaluator {
  private promptAssetScanner: PromptAssetScanner;
  private skillScanner: SkillScanner;

  constructor() {
    this.promptAssetScanner = new PromptAssetScanner();
    this.skillScanner = new SkillScanner();
  }

  async analyze(
    targets: NoiseEvaluationTarget[],
    options?: { workspaceHint?: string }
  ): Promise<NoiseEvaluationReport> {
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

    const workspaceResolution = this.resolveWorkspace(sessions, options?.workspaceHint ?? '');
    const totalEstimatedTokens = sessions.reduce(
      (sum, session) => sum + session.items.reduce((sessionSum, item) => sessionSum + item.tokenCount, 0),
      0
    );
    const totalToolCalls = sessions.reduce((sum, session) => sum + session.observations.length, 0);

    if (sessions.length === 0) {
      warnings.push('No analyzable session JSONL files were found.');
    }
    if (workspaceResolution.multiWorkspace) {
      warnings.push('Multiple workspace roots were detected. Outcome and prompt/context coverage are conservative.');
    }

    const processSummary = this.buildProcessSummary(sessions);
    const promptSummary =
      workspaceResolution.workspaceRoot && !workspaceResolution.multiWorkspace
        ? await this.buildPromptSummary(sessions, workspaceResolution.workspaceRoot, processSummary.readRecords)
        : null;
    const validationSummary = this.buildValidationSummary(sessions);
    const outcomeSummary =
      workspaceResolution.workspaceRoot && !workspaceResolution.multiWorkspace
        ? { git: await this.inspectGitDiff(workspaceResolution.workspaceRoot, sessions) }
        : { git: null };
    if (workspaceResolution.workspaceRoot && !workspaceResolution.multiWorkspace && !outcomeSummary.git) {
      warnings.push('Git diff inspection was unavailable, so outcome noise remains N/A.');
    }

    const sessionSummaries = this.buildSessionSummaries(sessions);
    const dimensions = [
      this.buildOutcomeDimension(outcomeSummary, sessions),
      this.buildProcessDimension(processSummary, totalEstimatedTokens, totalToolCalls, sessions.length),
      this.buildContextDimension(promptSummary, totalEstimatedTokens),
      this.buildValidationDimension(validationSummary, sessions.length),
    ];
    const coverage = this.buildCoverage(dimensions, outcomeSummary.git, promptSummary, processSummary);
    const coverageGrade = this.resolveCoverageGrade(coverage);
    const feasibleScope = this.buildFeasibleScope(outcomeSummary.git, promptSummary, validationSummary);
    const nextActions = this.buildNextActions(dimensions, outcomeSummary.git, promptSummary, validationSummary);

    return {
      workspaceRoot: workspaceResolution.workspaceRoot,
      workspaceRootsSeen: workspaceResolution.workspaceRootsSeen,
      sessionsScanned: targets.length,
      sessionsAnalyzed: sessions.length,
      totalEstimatedTokens,
      totalToolCalls,
      coverageGrade,
      coverage,
      feasibleScope,
      sessionSummaries,
      dimensions,
      git: outcomeSummary.git,
      promptAssets: promptSummary?.matchedAssets ?? [],
      fileHotspots: processSummary.fileHotspots,
      warnings: Array.from(new Set(warnings)),
      nextActions,
    };
  }

  private async parseSession(target: NoiseEvaluationTarget): Promise<ParsedSession | null> {
    return parseClaudeTranscriptSession(target);
  }

  private buildOutcomeDimension(outcomeSummary: OutcomeSummary, sessions: ParsedSession[]): NoiseDimensionReport {
    const git = outcomeSummary.git;
    if (!git) {
      return {
        key: 'outcome',
        label: 'Outcome Noise',
        available: false,
        status: 'na',
        confidence: 'low',
        summary: 'Outcome noise is N/A because Git diff evidence was unavailable for a single usable workspace.',
        observedFacts: ['Git diff inspection could not be completed from the available workspace evidence.'],
        derivedFeatures: [],
        semanticJudgments: ['Task relevance remains N/A without a stable diff scope and structured task spec.'],
        metrics: [
          {
            key: 'working_tree_scope',
            label: 'Working tree scope',
            status: 'na',
            value: 'N/A',
            trust: 'T1',
            summary: 'A single Git workspace is required to inspect final outcome changes.',
            missingEvidence: ['single workspace root', 'git diff'],
          },
        ],
        signals: [],
      };
    }

    const unattributedShare =
      git.totalChangedFiles > 0 ? git.unattributedFiles.length / git.totalChangedFiles : 0;
    const generatedLikeShare =
      git.totalChangedFiles > 0 ? git.generatedLikeFiles / git.totalChangedFiles : 0;
    const status: NoiseMetricStatus =
      git.unattributedFiles.length >= 3 || unattributedShare >= 0.5
        ? 'high'
        : git.generatedLikeFiles > 0 || git.topLevelAreas.length >= 4
        ? 'watch'
        : 'ok';
    const summary =
      git.totalChangedFiles === 0
        ? 'Working tree is clean, so no outcome noise is visible in the current diff.'
        : status === 'high'
        ? 'The current working tree shows broad or unattributed changes, so outcome noise risk is elevated.'
        : status === 'watch'
        ? 'The current working tree is partially attributable, but blast radius or generated-like files need inspection.'
        : 'Current working tree changes are narrow and attributable to observed write targets.';

    return {
      key: 'outcome',
      label: 'Outcome Noise',
      available: true,
      status,
      confidence: sessions.some((session) => session.observations.some((observation) => TOOL_MUTATION_NAMES.has(observation.name.toLowerCase())))
        ? 'medium'
        : 'low',
      summary,
      observedFacts: [
        `${git.totalChangedFiles} changed file(s) in the current working tree.`,
        `${git.totalAddedLines + git.totalDeletedLines} changed line(s) where line counts were available.`,
      ],
      derivedFeatures: [
        `${git.unattributedFiles.length} changed file(s) were not matched to observed write targets.`,
        `${git.generatedLikeFiles} generated-like or lockfile path(s) changed.`,
        `${git.topLevelAreas.length} top-level area(s) were touched.`,
      ],
      semanticJudgments: ['Task relevance remains N/A without a structured task spec or hunk-level rubric.'],
      metrics: [
        {
          key: 'changed_files',
          label: 'Changed files',
          status: git.totalChangedFiles >= 12 ? 'watch' : 'ok',
          value: String(git.totalChangedFiles),
          trust: 'T1',
          summary: 'Direct count of current working tree files that differ from Git base state.',
          missingEvidence: [],
        },
        {
          key: 'unattributed_files',
          label: 'Unattributed diff files',
          status: git.unattributedFiles.length >= 3 || unattributedShare >= 0.5 ? 'high' : git.unattributedFiles.length > 0 ? 'watch' : 'ok',
          value: `${git.unattributedFiles.length}/${git.totalChangedFiles}`,
          trust: 'T2',
          summary: 'Changed files not aligned with observed write targets increase attribution uncertainty.',
          missingEvidence: [],
        },
        {
          key: 'generated_like_files',
          label: 'Generated-like files',
          status: generatedLikeShare >= 0.3 && git.generatedLikeFiles > 0 ? 'watch' : git.generatedLikeFiles > 0 ? 'watch' : 'ok',
          value: String(git.generatedLikeFiles),
          trust: 'T2',
          summary: 'Generated-like paths are outcome-risk indicators, not automatic proof of noise.',
          missingEvidence: [],
        },
        {
          key: 'task_relevance',
          label: 'Task relevance',
          status: 'na',
          value: 'N/A',
          trust: 'T3',
          summary: 'Final-change relevance is intentionally left N/A until a stable task spec or approved semantic rubric is available.',
          missingEvidence: ['structured task spec or approved semantic rubric'],
        },
      ],
      signals: git.unattributedFiles.slice(0, 8).map((filePath, index) => ({
        dimension: 'outcome',
        key: 'unattributed_diff_file',
        label: 'Unattributed diff file',
        status: 'watch',
        trust: 'T2',
        sessionId: '',
        timestampLabel: 'n/a',
        target: filePath,
        tokenImpact: 0,
        summary: 'This changed file does not align with observed write targets from the scanned sessions.',
        evidence: [`file=${filePath}`],
        order: index,
      })),
    };
  }

  private buildProcessDimension(
    processSummary: ProcessSummary,
    totalEstimatedTokens: number,
    totalToolCalls: number,
    sessionCount: number
  ): NoiseDimensionReport {
    if (sessionCount === 0) {
      return {
        key: 'process',
        label: 'Process Noise',
        available: false,
        status: 'na',
        confidence: 'low',
        summary: 'Process noise is N/A because no tool-level session evidence was parsed.',
        observedFacts: ['No analyzable session logs were available.'],
        derivedFeatures: [],
        semanticJudgments: [],
        metrics: [
          {
            key: 'process_evidence',
            label: 'Process evidence',
            status: 'na',
            value: 'N/A',
            trust: 'T1',
            summary: 'Tool-level session logs are required for process analysis.',
            missingEvidence: ['session JSONL tool traces'],
          },
        ],
        signals: [],
      };
    }

    const recoverableShare =
      totalEstimatedTokens > 0 ? processSummary.totalRecoverableTokens / totalEstimatedTokens : 0;
    const status: NoiseMetricStatus =
      recoverableShare >= 0.25 || processSummary.signals.filter((signal) => signal.status === 'high').length >= 3
        ? 'high'
        : recoverableShare >= 0.1 || processSummary.signals.length > 0
        ? 'watch'
        : 'ok';

    return {
      key: 'process',
      label: 'Process Noise',
      available: true,
      status,
      confidence: 'high',
      summary:
        status === 'high'
          ? 'Repeated reads, commands, scans, or write loops are consuming substantial recoverable budget.'
          : status === 'watch'
          ? 'Some redundant exploration is visible, but it is still bounded.'
          : 'Process noise is currently limited in the scanned sessions.',
      observedFacts: [
        `${sessionCount} session(s) yielded ${totalToolCalls} tool call(s).`,
        `${processSummary.signals.length} process-noise signal(s) were detected with deterministic rules.`,
      ],
      derivedFeatures: [
        `${this.formatPercent(recoverableShare)} recoverable-token share.`,
        `${processSummary.duplicateCalls} duplicate-style calls.`,
      ],
      semanticJudgments: [],
      metrics: [
        {
          key: 'recoverable_token_share',
          label: 'Recoverable token share',
          status: recoverableShare >= 0.25 ? 'high' : recoverableShare >= 0.1 ? 'watch' : 'ok',
          value: this.formatPercent(recoverableShare),
          trust: 'T2',
          summary: 'Estimated share of session load tied to duplicate, stale, or unused process actions.',
          missingEvidence: [],
        },
        {
          key: 'missed_searches',
          label: 'Missed searches',
          status: processSummary.metrics.missedSearches >= 4 ? 'watch' : processSummary.metrics.missedSearches > 0 ? 'watch' : 'ok',
          value: String(processSummary.metrics.missedSearches),
          trust: 'T2',
          summary: 'Repeated empty searches usually indicate preventable process noise.',
          missingEvidence: [],
        },
        {
          key: 'write_noops',
          label: 'No-op writes',
          status: processSummary.metrics.writeNoops >= 2 ? 'high' : processSummary.metrics.writeNoops > 0 ? 'watch' : 'ok',
          value: String(processSummary.metrics.writeNoops),
          trust: 'T2',
          summary: 'Identical write payloads to the same file imply avoidable rework.',
          missingEvidence: [],
        },
        {
          key: 'edit_churn_files',
          label: 'Edit churn files',
          status: processSummary.metrics.editChurnFiles >= 2 ? 'watch' : processSummary.metrics.editChurnFiles > 0 ? 'watch' : 'ok',
          value: String(processSummary.metrics.editChurnFiles),
          trust: 'T2',
          summary: 'Files rewritten many times in one session are a stable rework signal.',
          missingEvidence: [],
        },
      ],
      signals: processSummary.signals,
    };
  }

  private buildContextDimension(promptSummary: PromptSummary | null, totalEstimatedTokens: number): NoiseDimensionReport {
    if (!promptSummary) {
      return {
        key: 'context',
        label: 'Context Noise',
        available: false,
        status: 'na',
        confidence: 'low',
        summary: 'Context noise is N/A because prompt assets could not be aligned to a single workspace.',
        observedFacts: ['Prompt and skill asset coverage could not be resolved to one workspace root.'],
        derivedFeatures: [],
        semanticJudgments: ['Prompt usefulness is intentionally not inferred from static files alone.'],
        metrics: [
          {
            key: 'prompt_alignment',
            label: 'Prompt alignment',
            status: 'na',
            value: 'N/A',
            trust: 'T1',
            summary: 'Context noise requires both prompt inventory and prompt-read evidence inside one workspace.',
            missingEvidence: ['single workspace root', 'prompt asset scan'],
          },
        ],
        signals: [],
      };
    }

    const readOnlyShare =
      totalEstimatedTokens > 0 ? promptSummary.readOnlyLoadTokens / totalEstimatedTokens : 0;
    const duplicateShare =
      totalEstimatedTokens > 0 ? promptSummary.duplicatePromptReadTokens / totalEstimatedTokens : 0;
    const status: NoiseMetricStatus =
      readOnlyShare >= 0.12 || duplicateShare >= 0.05
        ? 'high'
        : readOnlyShare >= 0.04 || promptSummary.matchedAssets.some((asset) => !asset.usedLater)
        ? 'watch'
        : 'ok';

    const signals: NoiseSignal[] = [];
    for (const asset of promptSummary.matchedAssets) {
      if (!asset.usedLater && asset.totalReadTokens > 0) {
        signals.push({
          dimension: 'context',
          key: 'read_only_prompt_asset',
          label: 'Read-only prompt asset',
          status: asset.totalReadTokens >= 1200 ? 'high' : 'watch',
          trust: 'T2',
          sessionId: '',
          timestampLabel: 'n/a',
          target: asset.relativePath,
          tokenImpact: asset.totalReadTokens,
          summary: 'This prompt or skill asset was loaded into context without clear downstream reuse evidence.',
          evidence: [`reads=${asset.readCount}`, `tokens=${asset.totalReadTokens}`],
          order: 0,
        });
      }
      if (asset.duplicateReadTokens > 0) {
        signals.push({
          dimension: 'context',
          key: 'duplicate_prompt_read',
          label: 'Duplicate prompt read',
          status: asset.duplicateReadTokens >= 1000 ? 'high' : 'watch',
          trust: 'T2',
          sessionId: '',
          timestampLabel: 'n/a',
          target: asset.relativePath,
          tokenImpact: asset.duplicateReadTokens,
          summary: 'This prompt or skill asset was read repeatedly with identical content.',
          evidence: [`duplicateTokens=${asset.duplicateReadTokens}`],
          order: 0,
        });
      }
    }

    return {
      key: 'context',
      label: 'Context Noise',
      available: true,
      status,
      confidence: 'medium',
      summary:
        status === 'high'
          ? 'Prompt/skill assets are adding measurable load without enough observed reuse.'
          : status === 'watch'
          ? 'Some prompt assets appear to be read-only or reread, so the context layer needs tightening.'
          : 'Prompt/skill context usage is relatively tight in the scanned sessions.',
      observedFacts: [
        `${promptSummary.scannedPromptFiles} prompt file(s) and ${promptSummary.scannedSkills} skill(s) were scanned.`,
        `${promptSummary.matchedAssets.length} asset(s) were matched to actual Read activity.`,
      ],
      derivedFeatures: [
        `${this.formatPercent(readOnlyShare)} read-only prompt-load share.`,
        `${this.formatPercent(duplicateShare)} duplicate prompt-read share.`,
      ],
      semanticJudgments: ['Whether an unread asset is useful stays outside final scoring; unread assets are inventory, not noise.'],
      metrics: [
        {
          key: 'read_only_prompt_load',
          label: 'Read-only prompt load',
          status: readOnlyShare >= 0.12 ? 'high' : readOnlyShare >= 0.04 ? 'watch' : 'ok',
          value: this.formatPercent(readOnlyShare),
          trust: 'T2',
          summary: 'Token share spent on prompt/skill assets that showed no downstream reuse evidence.',
          missingEvidence: [],
        },
        {
          key: 'duplicate_prompt_reads',
          label: 'Duplicate prompt reads',
          status: promptSummary.duplicatePromptReadTokens >= 1000 ? 'watch' : promptSummary.duplicatePromptReadTokens > 0 ? 'watch' : 'ok',
          value: String(promptSummary.duplicatePromptReadTokens),
          trust: 'T2',
          summary: 'Repeated identical prompt reads create avoidable context pressure.',
          missingEvidence: [],
        },
      ],
      signals: signals.sort((a, b) => this.compareSignals(a, b)).slice(0, 16),
    };
  }

  private buildValidationDimension(validationSummary: ValidationSummary, sessionCount: number): NoiseDimensionReport {
    if (sessionCount === 0) {
      return {
        key: 'validation',
        label: 'Validation Noise',
        available: false,
        status: 'na',
        confidence: 'low',
        summary: 'Validation noise is N/A because no session evidence was parsed.',
        observedFacts: ['No analyzable assistant messages or tool traces were available.'],
        derivedFeatures: [],
        semanticJudgments: [],
        metrics: [
          {
            key: 'validation_evidence',
            label: 'Validation evidence',
            status: 'na',
            value: 'N/A',
            trust: 'T1',
            summary: 'Validation analysis requires assistant claims and tool-run evidence.',
            missingEvidence: ['session JSONL conversation events'],
          },
        ],
        signals: [],
      };
    }

    const status: NoiseMetricStatus =
      validationSummary.unsupportedClaims > 0 || (validationSummary.writesObserved > 0 && !validationSummary.validationAfterLastWrite)
        ? 'high'
        : validationSummary.failedValidationRuns > 0
        ? 'watch'
        : 'ok';

    return {
      key: 'validation',
      label: 'Validation Noise',
      available: true,
      status,
      confidence: 'high',
      summary:
        status === 'high'
          ? 'Completion or verification claims are not adequately backed by post-change validation evidence.'
          : status === 'watch'
          ? 'Validation exists, but failures or gaps still need follow-up.'
          : 'Validation evidence is present and aligned with the observed write path.',
      observedFacts: [
        `${validationSummary.writesObserved} write-like action(s) were observed.`,
        `${validationSummary.successfulValidationRuns} successful validation run(s) and ${validationSummary.failedValidationRuns} failed run(s) were detected.`,
      ],
      derivedFeatures: [
        `${validationSummary.unsupportedClaims} unsupported completion/verification claim(s).`,
        validationSummary.validationAfterLastWrite
          ? 'At least one successful validation command ran after the last write.'
          : 'No successful validation command ran after the last write.',
      ],
      semanticJudgments: [],
      metrics: [
        {
          key: 'unsupported_claims',
          label: 'Unsupported claims',
          status: validationSummary.unsupportedClaims > 0 ? 'high' : 'ok',
          value: String(validationSummary.unsupportedClaims),
          trust: 'T2',
          summary: 'Assistant completion or verification claims need matching validation evidence.',
          missingEvidence: [],
        },
        {
          key: 'post_change_validation',
          label: 'Post-change validation',
          status:
            validationSummary.writesObserved > 0 && !validationSummary.validationAfterLastWrite
              ? 'high'
              : validationSummary.validationAfterLastWrite
              ? 'ok'
              : 'watch',
          value: validationSummary.validationAfterLastWrite ? 'present' : 'missing',
          trust: 'T2',
          summary: 'The most important validation signal is a successful test/build/lint command after the last write.',
          missingEvidence: [],
        },
      ],
      signals: validationSummary.signals,
    };
  }

  private buildCoverage(
    dimensions: NoiseDimensionReport[],
    git: GitDiffSummary | null,
    promptSummary: PromptSummary | null,
    processSummary: ProcessSummary
  ): NoiseCoverageRow[] {
    const outcome = dimensions.find((dimension) => dimension.key === 'outcome');
    const process = dimensions.find((dimension) => dimension.key === 'process');
    const context = dimensions.find((dimension) => dimension.key === 'context');
    const validation = dimensions.find((dimension) => dimension.key === 'validation');
    const attributionAvailable = Boolean(git) && processSummary.readRecords.length > 0;

    return [
      {
        dimension: 'outcome',
        available: Boolean(outcome?.available),
        sources: git ? ['git diff', 'git status'] : [],
        reliability: git ? 'medium' : 'low',
        notes: git
          ? 'Current working tree is available, but task relevance stays N/A without a structured task spec.'
          : 'No single Git workspace was available.',
      },
      {
        dimension: 'process',
        available: Boolean(process?.available),
        sources: process?.available ? ['session JSONL tool traces'] : [],
        reliability: process?.available ? 'high' : 'low',
        notes: process?.available
          ? 'Process signals are deterministic and derived from tool logs.'
          : 'Tool-level session evidence is missing.',
      },
      {
        dimension: 'validation',
        available: Boolean(validation?.available),
        sources: validation?.available ? ['session JSONL assistant messages', 'tool traces'] : [],
        reliability: validation?.available ? 'high' : 'low',
        notes: validation?.available
          ? 'Validation relies on explicit assistant claims and observed validation commands.'
          : 'Assistant messages or tool traces are missing.',
      },
      {
        dimension: 'context',
        available: Boolean(context?.available),
        sources: promptSummary ? ['prompt asset files', 'skill files', 'session read traces'] : [],
        reliability: promptSummary ? 'medium' : 'low',
        notes: promptSummary
          ? 'Prompt usefulness is evaluated conservatively from actual reads plus downstream reuse evidence.'
          : 'Prompt assets could not be aligned to one workspace.',
      },
      {
        dimension: 'attribution',
        available: attributionAvailable,
        sources: attributionAvailable ? ['git diff', 'observed write targets'] : [],
        reliability: attributionAvailable ? 'medium' : 'low',
        notes: attributionAvailable
          ? 'Attribution is current-state alignment only; it does not reconstruct full edit causality.'
          : 'Need both Git diff scope and observed write targets.',
      },
    ];
  }

  private resolveCoverageGrade(rows: NoiseCoverageRow[]): 'A' | 'B' | 'C' | 'D' {
    const available = new Map(rows.map((row) => [row.dimension, row.available]));
    const outcome = available.get('outcome') === true;
    const process = available.get('process') === true;
    const validation = available.get('validation') === true;
    const context = available.get('context') === true;
    const attribution = available.get('attribution') === true;

    if (outcome && process && validation && context && attribution) {
      return 'A';
    }
    if (outcome && validation && context && (process || attribution)) {
      return 'B';
    }
    if (outcome) {
      return 'C';
    }
    return 'D';
  }

  private buildFeasibleScope(
    git: GitDiffSummary | null,
    promptSummary: PromptSummary | null,
    validationSummary: ValidationSummary
  ): string[] {
    const scope: string[] = [];
    if (git) {
      scope.push('Current working tree blast radius, generated-like changes, and attribution gaps can be measured now.');
      scope.push('Task relevance of final diffs remains N/A until a stable task spec or approved semantic rubric exists.');
    } else {
      scope.push('Outcome noise is limited to N/A reporting because Git scope is unavailable or multi-root.');
    }

    scope.push('Process noise can be measured now from duplicate reads, repeated commands, empty searches, no-op writes, broad scans, and edit churn.');

    if (promptSummary) {
      scope.push('Context noise can be measured now for prompt/skill assets that were actually read during the scanned sessions.');
    } else {
      scope.push('Prompt/context coverage is conservative because prompt assets were not aligned to a single workspace.');
    }

    if (validationSummary.writesObserved > 0) {
      scope.push('Validation noise can be measured now from post-change validation presence and unsupported completion claims.');
    } else {
      scope.push('Validation noise is still measurable, but no write path was observed in the scanned sessions.');
    }

    return scope;
  }

  private buildNextActions(
    dimensions: NoiseDimensionReport[],
    git: GitDiffSummary | null,
    promptSummary: PromptSummary | null,
    validationSummary: ValidationSummary
  ): string[] {
    const actions: string[] = [];
    const process = dimensions.find((dimension) => dimension.key === 'process');
    const context = dimensions.find((dimension) => dimension.key === 'context');
    const validation = dimensions.find((dimension) => dimension.key === 'validation');
    const outcome = dimensions.find((dimension) => dimension.key === 'outcome');

    if (process?.status === 'high' || process?.status === 'watch') {
      actions.push('Reduce duplicate reads and repeated shell runs first; these are the most stable recoverable process costs.');
    }
    if (context?.status === 'high' || context?.status === 'watch') {
      actions.push('Move large prompt assets to on-demand retrieval and avoid rereading unchanged rule files.');
    }
    if (validation?.status === 'high' || validation?.status === 'watch') {
      actions.push('Require one successful validation command after the last write, and echo the exact command in the completion message.');
    }
    if (outcome?.status === 'high' || outcome?.status === 'watch') {
      actions.push('Inspect unattributed or generated-like files in the current diff before trusting outcome conclusions.');
    }
    if (!git) {
      actions.push('For formal outcome scoring, run the evaluator on a single workspace with Git history available.');
    }
    if (!promptSummary) {
      actions.push('For stable context scoring, evaluate one workspace root at a time so prompt assets can be matched reliably.');
    }
    if (validationSummary.writesObserved === 0) {
      actions.push('No write path was observed; validation conclusions will remain conservative until write events are captured.');
    }

    return Array.from(new Set(actions)).slice(0, 6);
  }

  private buildSessionSummaries(sessions: ParsedSession[]): NoiseSessionSummary[] {
    return sessions
      .map((session) => ({
        sessionId: session.sessionId,
        filePath: session.filePath,
        workspaceRoot: session.workspaceRoot,
        startTime: this.formatTimestamp(session.startTimestampMs),
        endTime: this.formatTimestamp(session.endTimestampMs),
        totalTokens: session.items.reduce((sum, item) => sum + item.tokenCount, 0),
        totalToolCalls: session.observations.length,
        readCalls: session.observations.filter((observation) => observation.name.toLowerCase() === 'read').length,
        writeCalls: session.observations.filter((observation) => TOOL_MUTATION_NAMES.has(observation.name.toLowerCase())).length,
        bashCalls: session.observations.filter((observation) => observation.name.toLowerCase() === 'bash').length,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.sessionId.localeCompare(b.sessionId));
  }

  private resolveWorkspace(sessions: ParsedSession[], workspaceHint: string): WorkspaceResolution {
    const roots = new Set<string>();
    for (const session of sessions) {
      if (session.workspaceRoot) {
        roots.add(session.workspaceRoot);
      }
    }

    const workspaceRootsSeen = Array.from(roots).sort((a, b) => a.localeCompare(b));
    if (workspaceHint && workspaceRootsSeen.length === 0) {
      return {
        workspaceRoot: path.resolve(workspaceHint),
        workspaceRootsSeen: [path.resolve(workspaceHint)],
        multiWorkspace: false,
      };
    }
    if (workspaceHint && workspaceRootsSeen.length === 1) {
      const normalizedHint = path.resolve(workspaceHint);
      const onlyRoot = workspaceRootsSeen[0];
      if (normalizedHint === onlyRoot || onlyRoot.startsWith(normalizedHint) || normalizedHint.startsWith(onlyRoot)) {
        return {
          workspaceRoot: onlyRoot,
          workspaceRootsSeen,
          multiWorkspace: false,
        };
      }
    }
    if (workspaceRootsSeen.length === 1) {
      return {
        workspaceRoot: workspaceRootsSeen[0],
        workspaceRootsSeen,
        multiWorkspace: false,
      };
    }
    return {
      workspaceRoot: '',
      workspaceRootsSeen,
      multiWorkspace: workspaceRootsSeen.length > 1,
    };
  }

  private async inspectGitDiff(workspaceRoot: string, sessions: ParsedSession[]): Promise<GitDiffSummary | null> {
    const repoRoot = await this.runGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
    if (!repoRoot?.stdout.trim()) {
      return null;
    }

    const normalizedRepoRoot = path.resolve(repoRoot.stdout.trim());
    const statusResult = await this.runGit(normalizedRepoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!statusResult) {
      return null;
    }

    const numstatResult = await this.runGit(normalizedRepoRoot, ['diff', '--numstat', '--relative', 'HEAD', '--']);
    const numstatMap = new Map<string, { addedLines: number | null; deletedLines: number | null }>();
    for (const line of (numstatResult?.stdout ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = trimmed.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!match) {
        continue;
      }
      numstatMap.set(this.normalizeRelativePath(match[3]), {
        addedLines: match[1] === '-' ? null : Number(match[1]),
        deletedLines: match[2] === '-' ? null : Number(match[2]),
      });
    }

    const mutatedFiles = new Set<string>();
    for (const session of sessions) {
      for (const observation of session.observations) {
        if (!TOOL_MUTATION_NAMES.has(observation.name.toLowerCase()) || !observation.targetPath) {
          continue;
        }
        if (!this.isInsideRoot(observation.targetPath, normalizedRepoRoot)) {
          continue;
        }
        mutatedFiles.add(this.normalizeRelativePath(path.relative(normalizedRepoRoot, observation.targetPath)));
      }
    }

    const files: GitDiffFile[] = [];
    for (const line of statusResult.stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parsed = this.parseGitStatusLine(line);
      if (!parsed) {
        continue;
      }

      const relativePath = this.normalizeRelativePath(parsed.path);
      const absolutePath = path.resolve(normalizedRepoRoot, relativePath);
      let counts = numstatMap.get(relativePath) ?? null;
      if (!counts && parsed.status === 'untracked') {
        counts = await this.estimateUntrackedFileNumstat(absolutePath);
      }

      files.push({
        path: relativePath,
        status: parsed.status,
        addedLines: counts?.addedLines ?? null,
        deletedLines: counts?.deletedLines ?? null,
        attributed: mutatedFiles.size > 0 ? mutatedFiles.has(relativePath) : null,
        generatedLike: this.isGeneratedLikePath(relativePath),
      });
    }

    const totalAddedLines = files.reduce((sum, file) => sum + (file.addedLines ?? 0), 0);
    const totalDeletedLines = files.reduce((sum, file) => sum + (file.deletedLines ?? 0), 0);
    const generatedLikeFiles = files.filter((file) => file.generatedLike).length;
    const unattributedFiles = files.filter((file) => file.attributed === false).map((file) => file.path);
    const attributedFiles = files.filter((file) => file.attributed === true).map((file) => file.path);
    const topLevelAreas = Array.from(
      new Set(
        files
          .map((file) => file.path.split('/').filter(Boolean)[0] ?? '(root)')
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    return {
      workspaceRoot,
      repoRoot: normalizedRepoRoot,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      totalChangedFiles: files.length,
      totalAddedLines,
      totalDeletedLines,
      generatedLikeFiles,
      topLevelAreas,
      unattributedFiles,
      attributedFiles,
    };
  }

  private buildProcessSummary(sessions: ParsedSession[]): ProcessSummary {
    const signals: NoiseSignal[] = [];
    const readRecords: ProcessSummary['readRecords'] = [];
    let duplicateCalls = 0;
    const metrics: ProcessSummary['metrics'] = {
      duplicateReadTokens: 0,
      staleReadTokens: 0,
      bashDuplicateTokens: 0,
      readBloatTokens: 0,
      bashBloatTokens: 0,
      missedSearches: 0,
      writeNoops: 0,
      redundantScans: 0,
      editChurnFiles: 0,
    };

    for (const session of sessions) {
      const flaggedIds = new Set<string>();
      const processSignals = [
        ...this.detectReadDuplicates(session, flaggedIds, metrics),
        ...this.detectReadBloat(session, flaggedIds, metrics),
        ...this.detectBashDuplicates(session, flaggedIds, metrics),
        ...this.detectBashBloat(session, flaggedIds, metrics),
        ...this.detectSearchMisses(session, metrics),
        ...this.detectWriteNoops(session, metrics),
        ...this.detectListingNoise(session, metrics),
        ...this.detectEditChurn(session, metrics),
      ];

      duplicateCalls += processSignals.filter((signal) => signal.key.includes('duplicate') || signal.key === 'write_noop').length;
      signals.push(...processSignals);

      for (const observation of session.observations) {
        if (observation.name.toLowerCase() !== 'read' || !observation.targetPath) {
          continue;
        }
        const usage = this.scoreUsageEvidence(session, observation);
        readRecords.push({
          sessionId: session.sessionId,
          path: observation.targetPath,
          cwd: observation.cwd,
          tokenCount: Math.max(observation.resultTokens, observation.estimatedTokens),
          order: observation.order,
          resultContent: observation.resultContent,
          usedLater: usage.pathMutation || usage.resultPathFollowup || usage.pathMentioned || usage.strongKeywordHit,
        });
      }
    }

    const totalRecoverableTokens = signals.reduce((sum, signal) => sum + signal.tokenImpact, 0);
    return {
      totalRecoverableTokens,
      duplicateCalls,
      signals: signals.sort((a, b) => this.compareSignals(a, b)).slice(0, 40),
      readRecords,
      fileHotspots: this.buildFileHotspots(sessions),
      metrics,
    };
  }

  private async buildPromptSummary(
    sessions: ParsedSession[],
    workspaceRoot: string,
    readRecords: ProcessSummary['readRecords']
  ): Promise<PromptSummary | null> {
    let promptScan;
    let skillScan;
    try {
      promptScan = await this.promptAssetScanner.scan(workspaceRoot);
      skillScan = await this.skillScanner.scan(workspaceRoot);
    } catch {
      return null;
    }

    const assetMap = new Map<
      string,
      {
        relativePath: string;
        kind: 'prompt' | 'skill';
        label: string;
        totalReadTokens: number;
        duplicateReadTokens: number;
        readCount: number;
        usedLater: boolean;
      }
    >();

    for (const file of promptScan.files) {
      assetMap.set(file.relativePath.toLowerCase(), {
        relativePath: file.relativePath,
        kind: 'prompt',
        label: file.categories.join(', '),
        totalReadTokens: 0,
        duplicateReadTokens: 0,
        readCount: 0,
        usedLater: false,
      });
    }

    for (const skill of skillScan.skills) {
      const relativePath = skill.skillFileRelativePath;
      if (assetMap.has(relativePath.toLowerCase())) {
        continue;
      }
      assetMap.set(relativePath.toLowerCase(), {
        relativePath,
        kind: 'skill',
        label: 'skill',
        totalReadTokens: 0,
        duplicateReadTokens: 0,
        readCount: 0,
        usedLater: false,
      });
    }

    const duplicateReadKeyCounts = new Map<string, number>();
    for (const record of readRecords) {
      const relativePath = this.toWorkspaceRelativePath(record.path, workspaceRoot);
      if (!relativePath) {
        continue;
      }
      const key = relativePath.toLowerCase();
      const asset = assetMap.get(key);
      if (!asset) {
        continue;
      }

      asset.totalReadTokens += record.tokenCount;
      asset.readCount += 1;
      asset.usedLater = asset.usedLater || record.usedLater;

      const duplicateKey = `${key}:${record.resultContent ? this.contentFingerprint(record.resultContent) : 'empty'}`;
      duplicateReadKeyCounts.set(duplicateKey, (duplicateReadKeyCounts.get(duplicateKey) ?? 0) + 1);
      if ((duplicateReadKeyCounts.get(duplicateKey) ?? 0) > 1) {
        asset.duplicateReadTokens += record.tokenCount;
      }
    }

    const matchedAssets = Array.from(assetMap.values())
      .filter((asset) => asset.readCount > 0)
      .map((asset) => ({ ...asset }))
      .sort((a, b) => b.totalReadTokens - a.totalReadTokens || a.relativePath.localeCompare(b.relativePath));

    void sessions;

    return {
      scannedAssets: assetMap.size,
      scannedPromptFiles: promptScan.files.length,
      scannedSkills: skillScan.skills.length,
      matchedAssets,
      readOnlyLoadTokens: matchedAssets.filter((asset) => !asset.usedLater).reduce((sum, asset) => sum + asset.totalReadTokens, 0),
      duplicatePromptReadTokens: matchedAssets.reduce((sum, asset) => sum + asset.duplicateReadTokens, 0),
    };
  }

  private buildValidationSummary(sessions: ParsedSession[]): ValidationSummary {
    const signals: NoiseSignal[] = [];
    let writesObserved = 0;
    let successfulValidationRuns = 0;
    let failedValidationRuns = 0;
    let validationAfterLastWrite = false;
    let unsupportedClaims = 0;

    for (const session of sessions) {
      const writeOrders = session.observations
        .filter((observation) => TOOL_MUTATION_NAMES.has(observation.name.toLowerCase()) && observation.targetPath)
        .map((observation) => observation.order);
      writesObserved += writeOrders.length;
      const lastWriteOrder = writeOrders.length > 0 ? Math.max(...writeOrders) : -1;

      const validationObservations = session.observations.filter((observation) => this.classifyValidationCommand(observation.command) !== null);
      const successfulAfterLastWrite = validationObservations.filter((observation) => {
        const status = this.resolveValidationOutcome(observation);
        if (status === 'success') {
          successfulValidationRuns += 1;
        } else if (status === 'failed') {
          failedValidationRuns += 1;
        }
        return status === 'success' && observation.order > lastWriteOrder;
      });

      if (lastWriteOrder >= 0 && successfulAfterLastWrite.length > 0) {
        validationAfterLastWrite = true;
      }

      if (lastWriteOrder >= 0 && successfulAfterLastWrite.length === 0) {
        signals.push(
          this.makeSignal(session, {
            dimension: 'validation',
            key: 'missing_post_change_validation',
            label: 'Missing post-change validation',
            status: 'high',
            trust: 'T2',
            order: lastWriteOrder,
            timestampMs: session.endTimestampMs,
            target: session.sessionId,
            tokenImpact: 0,
            summary: 'Writes were observed, but no successful test/build/lint command ran after the last write.',
            evidence: ['required evidence: successful validation command after last write'],
          })
        );
      }

      for (const message of session.messages.filter((item) => item.role === 'assistant' && item.text)) {
        const claim = this.detectCompletionClaim(message.text);
        if (!claim) {
          continue;
        }

        const matchingValidation = validationObservations.some((observation) => {
          if (observation.order < lastWriteOrder) {
            return false;
          }
          if (observation.order > message.order + 4) {
            return false;
          }
          return this.resolveValidationOutcome(observation) === 'success';
        });

        if (!matchingValidation) {
          unsupportedClaims += 1;
          signals.push(
            this.makeSignal(session, {
              dimension: 'validation',
              key: claim.explicitValidation ? 'unsupported_verification_claim' : 'unsupported_completion_claim',
              label: claim.explicitValidation ? 'Unsupported verification claim' : 'Unsupported completion claim',
              status: claim.explicitValidation ? 'high' : 'watch',
              trust: 'T2',
              order: message.order,
              timestampMs: message.timestampMs,
              target: session.sessionId,
              tokenImpact: estimateTokenCount(message.text),
              summary: claim.explicitValidation
                ? 'Assistant claimed tests/build/verification success without matching validation evidence.'
                : 'Assistant claimed completion without nearby post-change validation evidence.',
              evidence: [this.trimText(message.text, 120)],
            })
          );
        }
      }
    }

    return {
      writesObserved,
      successfulValidationRuns,
      failedValidationRuns,
      validationAfterLastWrite,
      unsupportedClaims,
      signals: signals.sort((a, b) => this.compareSignals(a, b)).slice(0, 24),
    };
  }

  private detectReadDuplicates(
    session: ParsedSession,
    flaggedIds: Set<string>,
    metrics: ProcessSummary['metrics']
  ): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    const lastMutationOrder = new Map<string, number>();
    const lastRead = new Map<string, ToolObservation>();

    for (const observation of session.observations) {
      const name = observation.name.toLowerCase();
      const normalizedPath = this.normalizePathKey(observation.targetPath);

      if (TOOL_MUTATION_NAMES.has(name) && normalizedPath) {
        lastMutationOrder.set(normalizedPath, observation.order);
        continue;
      }
      if (name !== 'read' || !normalizedPath || observation.estimatedTokens <= 0) {
        continue;
      }

      const previousRead = lastRead.get(normalizedPath);
      const lastMutation = lastMutationOrder.get(normalizedPath) ?? -1;
      if (previousRead && previousRead.order > lastMutation) {
        const overlap = this.describeReadOverlap(previousRead, observation);
        if (overlap.comparable && !overlap.overlaps) {
          lastRead.set(normalizedPath, observation);
          continue;
        }
        const fingerprintMatched = this.isEquivalentReadReplay(previousRead, observation, overlap);
        if (fingerprintMatched) {
          const gapTokens = this.sumTokensBetween(session.items, previousRead.order, observation.order);
          const staleRead = gapTokens >= STALE_INTERVENING_TOKENS || observation.order - previousRead.order >= STALE_STEP_GAP;
          const key = staleRead ? 'stale_reread' : 'duplicate_read';
          const label = staleRead ? 'Stale reread' : 'Duplicate read';
          const summary = staleRead
            ? `Same file was reread after ${this.formatTokenNumber(gapTokens)} of intervening context and no write.`
            : 'Same file was reread with identical content and no intervening write.';
          const status: NoiseSignal['status'] = observation.estimatedTokens >= 1400 ? 'high' : 'watch';

          if (staleRead) {
            metrics.staleReadTokens += observation.estimatedTokens;
          } else {
            metrics.duplicateReadTokens += observation.estimatedTokens;
          }

          signals.push(
            this.makeSignal(session, {
              dimension: 'process',
              key,
              label,
              status,
              trust: 'T2',
              order: observation.order,
              timestampMs: observation.timestampMs,
              target: this.toDisplayTarget(observation.targetPath, session.workspaceRoot),
              tokenImpact: observation.estimatedTokens,
              summary,
              evidence: [
                `previousOrder=${previousRead.order}`,
                `currentOrder=${observation.order}`,
                `tokens=${observation.estimatedTokens}`,
                `overlap=${Math.round(overlap.overlapRatio * 100)}%`,
              ],
            })
          );
          flaggedIds.add(observation.id);
        }
      }

      lastRead.set(normalizedPath, observation);
    }

    return signals;
  }

  private detectReadBloat(
    session: ParsedSession,
    flaggedIds: Set<string>,
    metrics: ProcessSummary['metrics']
  ): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    for (const observation of session.observations) {
      const normalizedPath = this.normalizePathKey(observation.targetPath);
      if (observation.name.toLowerCase() !== 'read' || flaggedIds.has(observation.id)) {
        continue;
      }
      if (observation.estimatedTokens < READ_BLOAT_MIN_TOKENS) {
        continue;
      }

      const mutatedAfter = session.observations.some(
        (next) =>
          next.order > observation.order &&
          TOOL_MUTATION_NAMES.has(next.name.toLowerCase()) &&
          this.normalizePathKey(next.targetPath) === normalizedPath
      );
      if (mutatedAfter) {
        continue;
      }

      const usageScore = this.computeUsageScore(session, observation);
      if (usageScore >= 0.8) {
        continue;
      }

      metrics.readBloatTokens += observation.estimatedTokens;
      signals.push(
        this.makeSignal(session, {
          dimension: 'process',
          key: 'unused_large_read',
          label: 'Unused large read',
          status: observation.estimatedTokens >= 2000 ? 'high' : 'watch',
          trust: 'T2',
          order: observation.order,
          timestampMs: observation.timestampMs,
          target: this.toDisplayTarget(observation.targetPath, session.workspaceRoot),
          tokenImpact: observation.estimatedTokens,
          summary: 'Large file read showed no strong downstream usage evidence.',
          evidence: [`usageScore=${usageScore.toFixed(2)}`],
        })
      );
    }

    return signals;
  }

  private detectBashDuplicates(
    session: ParsedSession,
    flaggedIds: Set<string>,
    metrics: ProcessSummary['metrics']
  ): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    const lastCommand = new Map<string, ToolObservation>();

    for (const observation of session.observations) {
      if (observation.name.toLowerCase() !== 'bash') {
        continue;
      }
      if (this.isDirectoryListingCommand(observation.command, observation.resultContent)) {
        continue;
      }
      const normalizedCommand = this.normalizeCommand(observation.command);
      if (!normalizedCommand) {
        continue;
      }

      const previous = lastCommand.get(normalizedCommand);
      if (
        previous &&
        this.isWithinDuplicateWindow(previous, observation) &&
        this.contentFingerprint(previous.resultContent) === this.contentFingerprint(observation.resultContent)
      ) {
        metrics.bashDuplicateTokens += observation.estimatedTokens;
        signals.push(
          this.makeSignal(session, {
            dimension: 'process',
            key: 'duplicate_bash',
            label: 'Duplicate command',
            status: observation.estimatedTokens >= 900 ? 'high' : 'watch',
            trust: 'T2',
            order: observation.order,
            timestampMs: observation.timestampMs,
            target: this.truncateCommand(observation.command || 'bash'),
            tokenImpact: observation.estimatedTokens,
            summary: 'Same shell command was rerun within the duplicate window with identical output.',
            evidence: [`command=${this.truncateCommand(normalizedCommand)}`],
          })
        );
        flaggedIds.add(observation.id);
      }

      lastCommand.set(normalizedCommand, observation);
    }

    return signals;
  }

  private detectBashBloat(
    session: ParsedSession,
    flaggedIds: Set<string>,
    metrics: ProcessSummary['metrics']
  ): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    for (const observation of session.observations) {
      if (observation.name.toLowerCase() !== 'bash' || flaggedIds.has(observation.id)) {
        continue;
      }
      if (observation.estimatedTokens < BASH_BLOAT_MIN_TOKENS) {
        continue;
      }
      if (this.isDirectoryListingCommand(observation.command, observation.resultContent)) {
        continue;
      }

      const usageScore = this.computeUsageScore(session, observation);
      if (usageScore >= 0.8) {
        continue;
      }

      metrics.bashBloatTokens += observation.estimatedTokens;
      signals.push(
        this.makeSignal(session, {
          dimension: 'process',
          key: 'unused_large_shell_output',
          label: 'Unused large shell output',
          status: observation.estimatedTokens >= 1600 ? 'high' : 'watch',
          trust: 'T2',
          order: observation.order,
          timestampMs: observation.timestampMs,
          target: this.truncateCommand(observation.command || 'bash'),
          tokenImpact: observation.estimatedTokens,
          summary: 'Large shell output showed no strong downstream usage evidence.',
          evidence: [`usageScore=${usageScore.toFixed(2)}`],
        })
      );
    }
    return signals;
  }

  private detectSearchMisses(session: ParsedSession, metrics: ProcessSummary['metrics']): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    for (const observation of session.observations) {
      const name = observation.name.toLowerCase();
      const isSearchLike = name === 'grep' || name === 'glob' || (name === 'bash' && /\brg\b|\bgrep\b/i.test(observation.command));
      if (!isSearchLike) {
        continue;
      }
      if (!this.isMissedSearch(observation.resultContent)) {
        continue;
      }

      metrics.missedSearches += 1;
      signals.push(
        this.makeSignal(session, {
          dimension: 'process',
          key: 'missed_search',
          label: 'Missed search',
          status: 'watch',
          trust: 'T2',
          order: observation.order,
          timestampMs: observation.timestampMs,
          target: this.extractSearchTarget(observation.input) || this.truncateCommand(observation.command || 'search'),
          tokenImpact: observation.estimatedTokens,
          summary: 'Search returned no matches and did not yield usable evidence.',
          evidence: [`tool=${observation.name}`],
        })
      );
    }
    return signals;
  }

  private detectWriteNoops(session: ParsedSession, metrics: ProcessSummary['metrics']): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    const lastWriteByPath = new Map<string, ToolObservation>();

    for (const observation of session.observations) {
      const name = observation.name.toLowerCase();
      if (!TOOL_MUTATION_NAMES.has(name)) {
        continue;
      }
      const normalizedPath = this.normalizePathKey(observation.targetPath);
      if (!normalizedPath) {
        continue;
      }

      const structuredNoop =
        (name === 'edit' || name === 'multiedit' || name === 'notebookedit') &&
        observation.successFlag === true &&
        observation.structuredPatchCount === 0 &&
        observation.userModified !== true &&
        (observation.writePayload.length > 0 || observation.oldString === observation.newString);

      if (structuredNoop) {
        metrics.writeNoops += 1;
        signals.push(
          this.makeSignal(session, {
            dimension: 'process',
            key: 'write_noop',
            label: 'No-op write',
            status: observation.estimatedTokens >= 800 ? 'high' : 'watch',
            trust: 'T2',
            order: observation.order,
            timestampMs: observation.timestampMs,
            target: this.toDisplayTarget(observation.targetPath, session.workspaceRoot),
            tokenImpact: Math.max(observation.estimatedTokens, estimateTokenCount(observation.writePayload)),
            summary: 'Edit completed without any structured patch output, so the requested change likely did not alter file state.',
            evidence: [`path=${this.toDisplayTarget(observation.targetPath, session.workspaceRoot)}`],
          })
        );
      }

      if (!observation.writePayload) {
        lastWriteByPath.set(normalizedPath, observation);
        continue;
      }

      const previous = lastWriteByPath.get(normalizedPath);
      if (
        previous &&
        this.isWithinDuplicateWindow(previous, observation) &&
        this.contentFingerprint(previous.writePayload) === this.contentFingerprint(observation.writePayload)
      ) {
        metrics.writeNoops += 1;
        signals.push(
          this.makeSignal(session, {
            dimension: 'process',
            key: 'write_noop',
            label: 'No-op write',
            status: observation.writePayload.length >= 1200 ? 'high' : 'watch',
            trust: 'T2',
            order: observation.order,
            timestampMs: observation.timestampMs,
            target: this.toDisplayTarget(observation.targetPath, session.workspaceRoot),
            tokenImpact: Math.max(observation.estimatedTokens, estimateTokenCount(observation.writePayload)),
            summary: 'Identical write payload was sent to the same file again.',
            evidence: [`path=${this.toDisplayTarget(observation.targetPath, session.workspaceRoot)}`],
          })
        );
      }

      lastWriteByPath.set(normalizedPath, observation);
    }

    return signals;
  }

  private detectListingNoise(session: ParsedSession, metrics: ProcessSummary['metrics']): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    const lastScanByTarget = new Map<string, ToolObservation>();

    for (const observation of session.observations) {
      const isListing =
        DIRECTORY_TOOLS.has(observation.name.toLowerCase()) || this.isDirectoryListingCommand(observation.command, observation.resultContent);
      if (!isListing) {
        continue;
      }

      const scanTarget = this.normalizeListingTarget(observation);
      const previous = lastScanByTarget.get(scanTarget);
      if (
        previous &&
        this.isWithinDuplicateWindow(previous, observation) &&
        this.contentFingerprint(previous.resultContent) === this.contentFingerprint(observation.resultContent)
      ) {
        metrics.redundantScans += 1;
        signals.push(
          this.makeSignal(session, {
            dimension: 'process',
            key: 'redundant_scan',
            label: 'Redundant scan',
            status: 'watch',
            trust: 'T2',
            order: observation.order,
            timestampMs: observation.timestampMs,
            target: this.toDisplayTarget(observation.targetPath || observation.command, session.workspaceRoot),
            tokenImpact: observation.estimatedTokens,
            summary: 'Same directory scan was repeated with identical results.',
            evidence: [`target=${scanTarget}`],
          })
        );
      } else {
        const entryCount = this.estimateObservationEntryCount(observation);
        const followupCount = this.countListingFollowups(session, observation);
        const utilizationRatio = entryCount > 0 ? followupCount / entryCount : 0;
        if (
          entryCount >= BROAD_SCAN_ENTRY_THRESHOLD &&
          this.isRootLikeScan(observation) &&
          (observation.truncated || followupCount <= 2 || utilizationRatio < 0.12)
        ) {
          metrics.redundantScans += 1;
          signals.push(
            this.makeSignal(session, {
              dimension: 'process',
              key: 'broad_scan',
              label: 'Broad scan',
              status: entryCount >= 100 ? 'high' : 'watch',
              trust: 'T2',
              order: observation.order,
              timestampMs: observation.timestampMs,
              target: this.toDisplayTarget(observation.targetPath || observation.command, session.workspaceRoot),
              tokenImpact: observation.estimatedTokens,
              summary: observation.truncated
                ? 'Broad root-like directory scan truncated the result before the session meaningfully narrowed scope.'
                : 'Broad root-like directory scan pulled a large result set with low downstream utilization.',
              evidence: [
                `entries~=${entryCount}`,
                `followups=${followupCount}`,
                `utilization=${Math.round(utilizationRatio * 100)}%`,
              ],
            })
          );
        }
      }

      lastScanByTarget.set(scanTarget, observation);
    }

    return signals;
  }

  private detectEditChurn(session: ParsedSession, metrics: ProcessSummary['metrics']): NoiseSignal[] {
    const signals: NoiseSignal[] = [];
    const writesByPath = new Map<string, ToolObservation[]>();

    for (const observation of session.observations) {
      if (!TOOL_MUTATION_NAMES.has(observation.name.toLowerCase()) || !observation.targetPath) {
        continue;
      }
      const key = this.normalizePathKey(observation.targetPath);
      const bucket = writesByPath.get(key) ?? [];
      bucket.push(observation);
      writesByPath.set(key, bucket);
    }

    for (const [normalizedPath, observations] of writesByPath) {
      if (observations.length < 4) {
        continue;
      }

      metrics.editChurnFiles += 1;
      const latest = observations[observations.length - 1];
      signals.push(
        this.makeSignal(session, {
          dimension: 'process',
          key: 'edit_churn',
          label: 'Edit churn',
          status: observations.length >= 6 ? 'high' : 'watch',
          trust: 'T2',
          order: latest.order,
          timestampMs: latest.timestampMs,
          target: this.toDisplayTarget(normalizedPath, session.workspaceRoot),
          tokenImpact: observations.reduce((sum, observation) => sum + Math.max(1, observation.estimatedTokens), 0),
          summary: 'Same file was rewritten many times in one session, indicating avoidable rework.',
          evidence: [`writes=${observations.length}`],
        })
      );
    }

    return signals;
  }

  private buildFileHotspots(sessions: ParsedSession[]): NoiseFileHotspot[] {
    const hotspotMap = new Map<string, { reads: number; duplicateReads: number; tokens: number; fingerprints: Set<string> }>();
    for (const session of sessions) {
      for (const observation of session.observations) {
        if (observation.name.toLowerCase() !== 'read' || !observation.targetPath) {
          continue;
        }
        const displayPath = this.toDisplayTarget(observation.targetPath, session.workspaceRoot);
        const fingerprint = this.contentFingerprint(observation.resultContent) || `order:${observation.order}`;
        const current = hotspotMap.get(displayPath) ?? { reads: 0, duplicateReads: 0, tokens: 0, fingerprints: new Set<string>() };
        current.reads += 1;
        current.tokens += observation.estimatedTokens;
        if (current.fingerprints.has(fingerprint)) {
          current.duplicateReads += 1;
        }
        current.fingerprints.add(fingerprint);
        hotspotMap.set(displayPath, current);
      }
    }

    return Array.from(hotspotMap.entries())
      .map(([filePath, value]) => ({
        path: filePath,
        reads: value.reads,
        duplicateReads: value.duplicateReads,
        tokens: value.tokens,
      }))
      .sort((a, b) => b.tokens - a.tokens || b.duplicateReads - a.duplicateReads || a.path.localeCompare(b.path))
      .slice(0, 12);
  }

  private computeUsageScore(session: ParsedSession, observation: ToolObservation): number {
    const usage = this.scoreUsageEvidence(session, observation);
    let score = 0;
    if (usage.pathMutation) score += 1;
    if (usage.resultPathFollowup) score += 0.95;
    if (usage.sameDirectoryFollowup) score += 0.55;
    if (usage.pathMentioned) score += 0.75;
    if (usage.filenameMentioned) score += 0.4;
    if (usage.strongKeywordHit) score += 0.45;
    if (usage.weakKeywordHit) score += 0.1;
    return Math.min(1, score);
  }

  private scoreUsageEvidence(session: ParsedSession, observation: ToolObservation): UsageEvidence {
    const normalizedPath = this.normalizePathKey(observation.targetPath);
    const displayPath = this.toDisplayTarget(observation.targetPath, session.workspaceRoot).toLowerCase();
    const baseName = path.basename(observation.targetPath).toLowerCase();
    const futureObservations = session.observations
      .filter((next) => next.order > observation.order)
      .slice(0, 25);
    const futureMessages = session.messages
      .filter((message) => message.order > observation.order && !message.isSynthetic)
      .slice(0, 25);

    const pathMutation = normalizedPath
      ? futureObservations.some(
          (next) =>
            TOOL_MUTATION_NAMES.has(next.name.toLowerCase()) &&
            this.normalizePathKey(next.targetPath) === normalizedPath
        )
      : false;
    const resultPathSet = new Set(
      (observation.resultPaths.length > 0 ? observation.resultPaths : [observation.targetPath])
        .map((candidate) => this.normalizePathKey(candidate))
        .filter(Boolean)
    );
    const resultPathFollowup = resultPathSet.size > 0 && futureObservations.some((next) => {
      const nextPath = this.normalizePathKey(next.targetPath);
      return nextPath ? resultPathSet.has(nextPath) : false;
    });
    const sameDirectoryFollowup = this.hasSameDirectoryFollowup(observation, futureObservations);
    if (pathMutation) {
      return {
        pathMutation: true,
        resultPathFollowup,
        sameDirectoryFollowup,
        pathMentioned: false,
        filenameMentioned: false,
        strongKeywordHit: false,
        weakKeywordHit: false,
      };
    }

    const futureMessageText = futureMessages
      .map((message) => message.text.toLowerCase())
      .join('\n');
    const futureInputs = futureObservations
      .map((next) => `${next.inputText}\n${next.command}`.toLowerCase())
      .join('\n');
    const futureText = `${futureMessageText}\n${futureInputs}`;
    const pathMentioned = displayPath.length >= 4 && futureText.includes(displayPath);
    const filenameMentioned = baseName.length >= 3 && futureText.includes(baseName);
    const keywords = this.extractSignalKeywords(observation.resultContent || observation.command || '');
    const strongKeywordHit = keywords.strong.some((keyword) => futureText.includes(keyword));
    const weakKeywordHit = !strongKeywordHit && keywords.weak.some((keyword) => futureText.includes(keyword));

    return {
      pathMutation,
      resultPathFollowup,
      sameDirectoryFollowup,
      pathMentioned,
      filenameMentioned,
      strongKeywordHit,
      weakKeywordHit,
    };
  }

  private extractSignalKeywords(text: string): { strong: string[]; weak: string[] } {
    const tokenFrequency = new Map<string, number>();
    const allTokens = text.match(/[A-Za-z_][A-Za-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const token of allTokens) {
      const normalized = token.toLowerCase();
      tokenFrequency.set(normalized, (tokenFrequency.get(normalized) ?? 0) + 1);
    }

    const strong: string[] = [];
    const weak: string[] = [];
    for (const [token, frequency] of tokenFrequency) {
      if (STOPWORDS.has(token) || token.length < 4) {
        continue;
      }
      if (token.length >= 8 && frequency <= 3) {
        strong.push(token);
      } else {
        weak.push(token);
      }
      if (strong.length >= 8 && weak.length >= 8) {
        break;
      }
    }

    return {
      strong: strong.slice(0, 8),
      weak: weak.slice(0, 8),
    };
  }

  private describeReadOverlap(
    previous: ToolObservation,
    current: ToolObservation
  ): { comparable: boolean; overlaps: boolean; sameRange: boolean; overlapRatio: number } {
    if (!previous.fileRange || !current.fileRange) {
      return { comparable: false, overlaps: true, sameRange: true, overlapRatio: 1 };
    }

    const previousStart = previous.fileRange.startLine;
    const previousEnd = previousStart + Math.max(0, previous.fileRange.numLines - 1);
    const currentStart = current.fileRange.startLine;
    const currentEnd = currentStart + Math.max(0, current.fileRange.numLines - 1);
    const overlapStart = Math.max(previousStart, currentStart);
    const overlapEnd = Math.min(previousEnd, currentEnd);
    const overlaps = overlapStart <= overlapEnd;
    const overlapLines = overlaps ? overlapEnd - overlapStart + 1 : 0;
    const denominator = Math.max(1, Math.min(previous.fileRange.numLines, current.fileRange.numLines));
    return {
      comparable: true,
      overlaps,
      sameRange: previousStart === currentStart && previous.fileRange.numLines === current.fileRange.numLines,
      overlapRatio: overlapLines / denominator,
    };
  }

  private isEquivalentReadReplay(
    previous: ToolObservation,
    current: ToolObservation,
    overlap: { comparable: boolean; overlaps: boolean; sameRange: boolean; overlapRatio: number }
  ): boolean {
    if (this.contentFingerprint(previous.resultContent) === this.contentFingerprint(current.resultContent)) {
      return true;
    }
    if (!overlap.comparable || !overlap.overlaps || overlap.overlapRatio < 0.85) {
      return false;
    }
    const previousText = this.normalizeComparableText(previous.resultContent);
    const currentText = this.normalizeComparableText(current.resultContent);
    if (previousText.length < 80 || currentText.length < 80) {
      return false;
    }
    return previousText.includes(currentText) || currentText.includes(previousText);
  }

  private countListingFollowups(session: ParsedSession, observation: ToolObservation): number {
    const futureObservations = session.observations
      .filter((next) => next.order > observation.order)
      .slice(0, 25);
    const resultPathSet = new Set(observation.resultPaths.map((candidate) => this.normalizePathKey(candidate)).filter(Boolean));

    if (resultPathSet.size > 0) {
      const matched = new Set<string>();
      for (const next of futureObservations) {
        const nextPath = this.normalizePathKey(next.targetPath);
        if (nextPath && resultPathSet.has(nextPath)) {
          matched.add(nextPath);
        }
      }
      return matched.size;
    }

    const baseDirectory = this.normalizePathKey(observation.targetPath);
    if (!baseDirectory) {
      return 0;
    }
    const matched = new Set<string>();
    for (const next of futureObservations) {
      const nextPath = this.normalizePathKey(next.targetPath);
      if (nextPath && nextPath.startsWith(`${baseDirectory}\\`)) {
        matched.add(nextPath);
      }
    }
    return matched.size;
  }

  private estimateObservationEntryCount(observation: ToolObservation): number {
    if (typeof observation.numFiles === 'number' && observation.numFiles > 0) {
      return observation.numFiles;
    }
    if (observation.resultPaths.length > 0) {
      return observation.resultPaths.length;
    }
    return this.estimateEntryCount(observation.resultContent);
  }

  private hasSameDirectoryFollowup(observation: ToolObservation, futureObservations: ToolObservation[]): boolean {
    const baseDirectory = this.resolveObservationDirectory(observation);
    if (!baseDirectory) {
      return false;
    }
    return futureObservations.some((next) => {
      const nextPath = this.normalizePathKey(next.targetPath);
      return nextPath ? nextPath.startsWith(`${baseDirectory}\\`) : false;
    });
  }

  private resolveObservationDirectory(observation: ToolObservation): string {
    const normalizedPath = this.normalizePathKey(observation.targetPath);
    if (!normalizedPath) {
      return '';
    }
    if (DIRECTORY_TOOLS.has(observation.name.toLowerCase()) || this.looksLikeDirectoryPath(observation.targetPath)) {
      return normalizedPath;
    }
    return this.normalizePathKey(path.dirname(observation.targetPath));
  }

  private looksLikeDirectoryPath(candidatePath: string): boolean {
    if (!candidatePath) {
      return false;
    }
    const trimmed = candidatePath.replace(/[\\/]+$/, '');
    return path.extname(trimmed) === '';
  }

  private normalizeComparableText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private compareSignals(left: NoiseSignal, right: NoiseSignal): number {
    const statusWeight = (status: NoiseSignal['status']): number => (status === 'high' ? 2 : 1);
    return (
      statusWeight(right.status) - statusWeight(left.status) ||
      right.tokenImpact - left.tokenImpact ||
      left.target.localeCompare(right.target)
    );
  }

  private makeSignal(
    session: ParsedSession,
    args: {
      dimension: NoiseDimensionKey;
      key: string;
      label: string;
      status: NoiseSignal['status'];
      trust: EvidenceTrustLevel;
      order: number;
      timestampMs: number;
      target: string;
      tokenImpact: number;
      summary: string;
      evidence: string[];
    }
  ): NoiseSignal {
    return {
      dimension: args.dimension,
      key: args.key,
      label: args.label,
      status: args.status,
      trust: args.trust,
      sessionId: session.sessionId,
      timestampLabel: this.formatTimestamp(args.timestampMs),
      target: args.target,
      tokenImpact: args.tokenImpact,
      summary: args.summary,
      evidence: args.evidence,
      order: args.order,
    };
  }

  private detectCompletionClaim(text: string): { key: string; explicitValidation: boolean } | null {
    const normalized = text.trim();
    if (!normalized) {
      return null;
    }
    for (const pattern of COMPLETION_CLAIM_PATTERNS) {
      if (pattern.pattern.test(normalized)) {
        return { key: pattern.key, explicitValidation: pattern.explicitValidation };
      }
    }
    return null;
  }

  private classifyValidationCommand(command: string): { kind: string } | null {
    const normalized = command.trim();
    if (!normalized) {
      return null;
    }
    for (const candidate of VALIDATION_COMMAND_PATTERNS) {
      if (candidate.pattern.test(normalized)) {
        return { kind: candidate.kind };
      }
    }
    return null;
  }

  private resolveValidationOutcome(observation: ToolObservation): 'success' | 'failed' | 'unknown' {
    if (observation.interrupted) {
      return 'failed';
    }
    if (observation.successFlag === true) {
      return 'success';
    }
    if (observation.successFlag === false || observation.isError) {
      return 'failed';
    }
    const stderr = observation.stderr.trim().toLowerCase();
    if (stderr) {
      return 'failed';
    }
    const result = observation.resultContent.trim().toLowerCase();
    if (/\b(failed|error|exception)\b/.test(result)) {
      return 'failed';
    }
    if (result) {
      return 'success';
    }
    return 'unknown';
  }

  private async runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string } | null> {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch {
      return null;
    }
  }

  private parseGitStatusLine(line: string): { status: GitDiffFile['status']; path: string } | null {
    if (line.startsWith('?? ')) {
      return {
        status: 'untracked',
        path: line.slice(3).trim(),
      };
    }
    if (line.length < 4) {
      return null;
    }

    const xy = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').slice(-1)[0] ?? filePath;
    }
    const statusChar = `${xy[0] ?? ' '}${xy[1] ?? ' '}`;
    if (statusChar.includes('R')) return { status: 'renamed', path: filePath };
    if (statusChar.includes('A')) return { status: 'added', path: filePath };
    if (statusChar.includes('D')) return { status: 'deleted', path: filePath };
    if (statusChar.includes('M')) return { status: 'modified', path: filePath };
    return { status: 'unknown', path: filePath };
  }

  private async estimateUntrackedFileNumstat(
    absolutePath: string
  ): Promise<{ addedLines: number | null; deletedLines: number | null } | null> {
    try {
      const content = await fs.readFile(absolutePath, 'utf8');
      const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      return {
        addedLines: lineCount,
        deletedLines: 0,
      };
    } catch {
      return null;
    }
  }

  private isGeneratedLikePath(relativePath: string): boolean {
    const normalized = this.normalizeRelativePath(relativePath).toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    if (segments.some((segment) => GENERATED_LIKE_DIRECTORIES.has(segment))) {
      return true;
    }
    const baseName = segments[segments.length - 1] ?? normalized;
    return GENERATED_LIKE_FILES.has(baseName);
  }

  private toWorkspaceRelativePath(absolutePath: string, workspaceRoot: string): string {
    if (!absolutePath || !workspaceRoot) {
      return '';
    }
    if (!this.isInsideRoot(absolutePath, workspaceRoot)) {
      return '';
    }
    return this.normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
  }

  private isInsideRoot(candidatePath: string, rootPath: string): boolean {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedCandidate = path.resolve(candidatePath);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
  }

  private contentFingerprint(content: string): string {
    if (!content) {
      return '';
    }
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) {
      return '';
    }
    const lineCount = (content.match(/\n/g) ?? []).length;
    const head = normalized.slice(0, 200);
    const tail = normalized.length > 200 ? normalized.slice(-200) : '';
    return `${lineCount}|${head}|${tail}`;
  }

  private isMissedSearch(resultContent: string): boolean {
    const normalized = resultContent.trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === '[]' || normalized === '{}' || normalized === 'null') return true;
    if (/\b0\s*(matches?|results?|files?|hits?|occurrences?)\b/.test(normalized)) return true;
    if (/\bno\s+(matches?|results?|files?\s+found|output|hits?|occurrences?)\b/.test(normalized)) return true;
    if (/\bnot\s+found\b/.test(normalized) || /\bnothing\s+found\b/.test(normalized)) return true;
    if (/\bno\s+files\s+searched\b/.test(normalized)) return true;
    if (/^[\s\[\]{},.:;()\-|]+$/.test(normalized)) return true;
    return false;
  }

  private isDirectoryListingCommand(command: string, resultContent: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (/(^|\s)(ls|dir|tree|find|get-childitem)(\s|$)/i.test(normalized) || normalized.includes('rg --files')) {
      return true;
    }
    const entryCount = this.estimateEntryCount(resultContent);
    const pathLikeLines = resultContent
      .split(/\r?\n/)
      .slice(0, 10)
      .filter((line) => /[\\/]/.test(line) || /\.[A-Za-z0-9]+$/.test(line.trim())).length;
    return entryCount >= 10 && pathLikeLines >= 6;
  }

  private isRootLikeScan(observation: ToolObservation): boolean {
    const command = observation.command.toLowerCase();
    const targetPath = this.normalizePathKey(observation.targetPath);
    const cwd = this.normalizePathKey(observation.cwd);
    if (!targetPath) return true;
    if (targetPath === '.' || targetPath === './' || targetPath === '.\\') return true;
    if (cwd && targetPath === cwd) return true;
    if (command.includes(' .') || command.includes(' "./') || command.includes(" '.\\")) return true;
    const relativeDepth = targetPath.replace(/^[a-z]:/i, '').split(/[\\/]+/).filter(Boolean).length;
    return relativeDepth <= 3;
  }

  private normalizeListingTarget(observation: ToolObservation): string {
    const target = observation.targetPath || observation.command || '.';
    return this.normalizeCommand(target) || '.';
  }

  private normalizeCommand(command: string): string {
    return command.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private isWithinDuplicateWindow(previous: ToolObservation, current: ToolObservation): boolean {
    if (previous.timestampMs > 0 && current.timestampMs > 0) {
      return current.timestampMs - previous.timestampMs <= DUPLICATE_LOOKBACK_MS;
    }
    return current.order - previous.order <= DUPLICATE_LOOKBACK_STEPS;
  }

  private sumTokensBetween(items: ContextItem[], startOrder: number, endOrder: number): number {
    return items.reduce((sum, item) => {
      if (item.order <= startOrder || item.order >= endOrder) {
        return sum;
      }
      return sum + item.tokenCount;
    }, 0);
  }

  private estimateEntryCount(resultContent: string): number {
    return resultContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }

  private extractSearchTarget(input: Record<string, unknown>): string {
    return (
      this.getStringAtPaths(input, [['pattern'], ['query'], ['regex'], ['path'], ['file_path'], ['filePath']]) ??
      this.stringifyValue(input)
    );
  }

  private stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private getStringAtPaths(payload: unknown, keyPaths: string[][]): string | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  private getValueAtPath(payload: unknown, keyPath: string[]): unknown {
    let current: unknown = payload;
    for (const key of keyPath) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private normalizePathKey(filePath: string): string {
    return filePath.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  }

  private normalizeRelativePath(filePath: string): string {
    return filePath.split(path.sep).join('/').replace(/^\.\/+/, '');
  }

  private toDisplayTarget(filePath: string, workspaceRoot: string): string {
    if (!filePath) return '';
    if (workspaceRoot && this.isInsideRoot(filePath, workspaceRoot)) {
      const relative = this.normalizeRelativePath(path.relative(workspaceRoot, filePath));
      return relative || '.';
    }
    return filePath.replace(/\//g, path.sep);
  }

  private formatTimestamp(timestampMs: number): string {
    if (!timestampMs || !Number.isFinite(timestampMs)) return 'n/a';
    const date = new Date(timestampMs);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  private trimText(input: string, maxLength: number): string {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private truncateCommand(command: string, maxLength: number = 72): string {
    return this.trimText(command, maxLength);
  }

  private formatPercent(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0.0%';
    return `${(value * 100).toFixed(1)}%`;
  }

  private formatTokenNumber(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (value >= 1000) {
      return value >= 10000 ? `${Math.round(value / 1000)}k` : `${(value / 1000).toFixed(1)}k`;
    }
    return String(Math.round(value));
  }
}
