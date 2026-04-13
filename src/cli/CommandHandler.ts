import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createElement } from 'react';
import { promisify } from 'util';
import chalk from 'chalk';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { ConversationManager } from './ConversationManager.js';
import { UIRenderer } from './UIRenderer.js';
import { CommandRegistry } from './CommandRegistry.js';
import { ConfigStore, ConfigValueSource, ProviderConfigSources } from './ConfigStore.js';
import { Spinner } from './Spinner.js';
import { PromptAssetCategory, PromptAssetScanner, PromptScanResult } from './PromptAssetScanner.js';
import { ExtractedRule, RuleScanner, RulesFile, RulesScanResult } from './RuleScanner.js';
import { SkillScanner, SkillScanResult, SkillSummary } from './SkillScanner.js';
import { ContextNoiseAnalysis, ContextNoiseAnalyzer, ContextNoiseReadRecord } from './ContextNoiseAnalyzer.js';
import { NoiseCoverageRow, NoiseDimensionReport, NoiseEvaluationReport, NoiseEvaluator } from './NoiseEvaluator.js';
import { TodoGranularityAnalysis, TodoGranularityAnalyzer } from './TodoGranularityAnalyzer.js';
import { estimateTokenCount } from './tokenEstimate.js';
import { NoiseEvaluationScreen } from './ink/NoiseEvaluationScreen.js';
import { ContextHealthScreen } from './ink/ContextHealthScreen.js';
import { ScanPromptScreen } from './ink/ScanPromptScreen.js';
import { RulesScanScreen } from './ink/RulesScanScreen.js';
import { SkillsOverviewScreen } from './ink/SkillsOverviewScreen.js';
import { StateScreen } from './ink/StateScreen.js';
import { TodoGranularityScreen } from './ink/TodoGranularityScreen.js';
import { CostEstimateScreen } from './ink/CostEstimateScreen.js';
import { TokenStructureScreen } from './ink/TokenStructureScreen.js';
import { TokenUsageScreen } from './ink/TokenUsageScreen.js';
import { renderStaticInkScreen } from './ink/renderInkScreen.js';
import { ClaudeTokenizer } from '../llm/ClaudeTokenizer.js';
import { OpenRouterModelCatalog, OpenRouterModelCatalogEntry, OpenRouterModelMatch } from '../llm/OpenRouterModelCatalog.js';
import { TiktokenTokenizer } from '../llm/TiktokenTokenizer.js';
import { getProviderMeta, ProviderName } from '../config/providerCatalog.js';

const execFileAsync = promisify(execFile);

type ContextAnatomySegmentKey = 'system' | 'prompt_library' | 'reference_docs' | 'chat_history' | 'active_request';

type ContextActionSeverity = 'stable' | 'watch' | 'trim';

type ContextAnatomySegment = {
  key: ContextAnatomySegmentKey;
  label: string;
  shortLabel: string;
  tokenCount: number;
  shareOfInput: number;
  shareOfWindow: number;
  itemCount: number;
  colorize: (value: string) => string;
  barChar: string;
  note: string;
  severity: ContextActionSeverity;
};

type ContextAnatomyDriver = {
  label: string;
  tokenCount: number;
  shareOfInput: number;
  shareOfWindow: number;
  kind: string;
  colorize: (value: string) => string;
};

type ContextAnatomyView = {
  lines: string[];
  recommendations: string[];
  summary: string[];
};

type AnatomyBucket = {
  name: string;
  tokenCount: number;
  percent: number;
  colorize: (value: string) => string;
  fillChar?: '█' | '▓';
  warning?: boolean;
};

type TokenScanScope = 'current' | 'all' | 'path';
type TokenScanSource = 'claude' | 'codex' | 'cursor';

type TokenScanRequest = {
  source: TokenScanSource;
  scope: TokenScanScope;
  rawPath?: string;
  explicitSource?: boolean;
};

type TokenFieldAggregate = {
  name: string;
  total: number;
  count: number;
};

type TokenGroupAggregate = {
  name: string;
  totalTokens: number;
  records: number;
};

type TokenDayAggregate = {
  day: string;
  totalTokens: number;
  records: number;
};

type TokenFileAggregate = {
  filePath: string;
  projectDir: string;
  totalLines: number;
  parsedLines: number;
  invalidLines: number;
  recordsWithTokens: number;
  totalTokens: number;
  latestTimestampMs: number;
};

type TokenStructureSummary = {
  files: TokenFileAggregate[];
  totalFiles: number;
  totalLines: number;
  parsedLines: number;
  invalidLines: number;
  recordsWithTokens: number;
  totalTokens: number;
  tokenFields: TokenFieldAggregate[];
  roleBreakdown: TokenGroupAggregate[];
  typeBreakdown: TokenGroupAggregate[];
  dayBreakdown: TokenDayAggregate[];
};

type TokenScanTarget = {
  source: TokenScanSource;
  scopeLabel: string;
  sourceLabel: string;
  projectDirs: string[];
  filePaths: string[];
};

type CostEstimateSegmentKey =
  | 'system'
  | 'prompt_library'
  | 'reference_docs'
  | 'chat_history'
  | 'active_request';

type CostEstimateSegment = {
  key: CostEstimateSegmentKey;
  label: string;
  tokenCount: number;
  cacheEligible: boolean;
};

type CostEstimateRateCard = {
  prompt: number | null;
  completion: number | null;
  request: number | null;
  inputCacheRead: number | null;
  inputCacheWrite: number | null;
};

type CostEstimateScenario = {
  label: string;
  inputCostUsd: number;
  outputExampleCostUsd: number;
  totalWithOutputExampleUsd: number;
  savingsVsColdUsd: number;
  note: string;
};

type CostEstimateFamily = 'codex' | 'claude' | 'cursor';

type CostEstimateVariant = {
  label: string;
  resolvedMatch: OpenRouterModelMatch;
  rates: CostEstimateRateCard;
  scenarios: CostEstimateScenario[];
};

type CostEstimatePresentation = {
  targetFamily: CostEstimateFamily;
  targetLabel: string;
  provider: ProviderName;
  providerLabel: string;
  activeModel: string;
  totalInputTokens: number;
  cacheEligibleTokens: number;
  dynamicTokens: number;
  outputExampleTokens: number;
  segments: CostEstimateSegment[];
  variants: CostEstimateVariant[];
  assumptions: string[];
};

type ContextHealthLevel = 'healthy' | 'elevated' | 'critical' | 'unknown';
type ContextHealthConfidence = 'high' | 'medium' | 'low';

type ContextUsageRecord = {
  timestampMs: number;
  timestampLabel: string;
  filePath: string;
  model: string;
  contextUsedPercent: number | null;
  contextWindowTokens: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
};

type TokenUsageWindowSummary = {
  label: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  records: number;
  activeDays: number;
};

type TokenUsageModelDayValue = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

type TokenUsageDayAggregate = {
  day: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  records: number;
  models: TokenUsageModelDayValue[];
};

type TokenUsageModelAggregate = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  records: number;
  activeDays: number;
};

type TokenUsageSummary = {
  totalFiles: number;
  totalRecords: number;
  totalDays: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  latestTimestampMs: number;
  models: TokenUsageModelAggregate[];
  days: TokenUsageDayAggregate[];
  chartDays: TokenUsageDayAggregate[];
  windows: TokenUsageWindowSummary[];
};

type ContextUsageMetrics = {
  source: 'native' | 'calculated';
  rawPercent: number;
  effectivePercent: number;
  usedTokens: number;
  usageTokens: number;
  usageDerivedPercent: number;
  nativePercent: number | null;
  percentDrift: number | null;
  windowSource: 'explicit' | 'estimated';
  contextWindowTokens: number;
  usableContextTokens: number;
  autocompactBufferTokens: number;
};

type ContextHealthSnapshot = {
  level: ContextHealthLevel;
  levelReason: string;
  confidence: ContextHealthConfidence;
  confidenceReason: string;
  source: 'native' | 'calculated';
  windowSource: 'explicit' | 'estimated';
  model: string;
  rawPercent: number;
  usageDerivedPercent: number;
  nativePercent: number | null;
  percentDrift: number | null;
  effectivePercent: number;
  smoothedEffectivePercent: number;
  trendDeltaPercent: number | null;
  dataPoints: number;
  comparableDataPoints: number;
  nativeSampleCount: number;
  calculatedSampleCount: number;
  explicitWindowSampleCount: number;
  estimatedWindowSampleCount: number;
  mixedModels: boolean;
  mixedContextWindows: boolean;
  usedTokens: number;
  contextWindowTokens: number;
  usableContextTokens: number;
  autocompactBufferTokens: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  timestampMs: number;
  timestampLabel: string;
  filePath: string;
};

type PromptCoverageItem = {
  relativePath: string;
  fullPath: string;
  kind: 'prompt' | 'skill';
  label: string;
  tokenCount: number;
  summary: string;
  headings: string[];
  read: boolean;
  readTokens: number;
  wasReferencedLater: boolean;
};

type PromptCoverageSignalKind = 'high_value' | 'read_only' | 'unused';

type PromptCoverageSignal = {
  kind: PromptCoverageSignalKind;
  severity: 'high' | 'medium' | 'low';
  tokenImpact: number;
  reason: string;
  asset: PromptCoverageItem;
};

type PromptCoverageSummary = {
  scannedAssets: number;
  readAssets: PromptCoverageItem[];
  unreadAssets: PromptCoverageItem[];
  highValueAssets: PromptCoverageItem[];
  matchedReadCount: number;
  scannedPromptFiles: number;
  scannedSkills: number;
  promptNoiseTokens: number;
  signals: PromptCoverageSignal[];
};

type PromptScanTokenizerMode = 'count_tokens' | 'messages_usage' | 'estimated';

type PromptScanTokenCounter = (text: string) => Promise<number>;

type PromptScanTokenizationStrategy = {
  countTokens: PromptScanTokenCounter;
  getMode: () => PromptScanTokenizerMode;
  getWarning: () => string | undefined;
};

type PromptScanPresentation = {
  modeLabel: string;
  warning?: string;
  result: PromptScanResult;
  anatomyView: ContextAnatomyView;
};

type StateGitSummary = {
  available: boolean;
  repoRoot: string;
  branch: string;
  clean: boolean;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  ahead: number;
  behind: number;
};

type StateProjectAssetSummary = {
  packageLabel: string;
  packageManager: string;
  scriptCount: number;
  hasBuildScript: boolean;
  hasTestScript: boolean;
  hasLintScript: boolean;
  hasTypecheckScript: boolean;
  hasReadme: boolean;
  hasSrcDir: boolean;
  hasTestsDir: boolean;
  hasTsConfig: boolean;
  hasEnvExample: boolean;
  hasWorkspaceClaude: boolean;
  hasWorkspaceCodex: boolean;
  hasWorkspaceCursor: boolean;
  hasAgentsFile: boolean;
  hasClaudeFile: boolean;
  hasOdradekDir: boolean;
  promptAssetCount: number;
  promptFileCount: number;
  systemPromptCount: number;
  projectConfigCount: number;
  docsAssetCount: number;
  ruleFileCount: number;
  totalRules: number;
  skillCount: number;
  skillResourceFiles: number;
};

type ExportFormat = 'json';

type ExportCommandName =
  | 'state'
  | 'noise_eval'
  | 'context_health'
  | 'scan_tokens'
  | 'rules'
  | 'skills'
  | 'scan_prompt'
  | 'todo_granularity';

type ExportSelection = ExportCommandName | 'all';

type ExportCommandEnvelope = {
  command: ExportCommandName;
  invocation: string;
  status: 'ok' | 'error';
  data?: unknown;
  error?: string;
};

type ExportDocument = {
  schemaVersion: 1;
  format: ExportFormat;
  generatedAt: string;
  workspacePath: string;
  selectedSource: TokenScanSource;
  selectedCommand: ExportSelection;
  commands: ExportCommandEnvelope[];
};

type StateExportData = {
  scopeLabel: 'current_project';
  workspacePath: string;
  configPath: string;
  trusted: boolean;
  runtimeStatus: string;
  provider: {
    activeProvider: string;
    displayName: string;
    sourceLabel: string;
    runtimeSourceLabel: string;
  };
  projectContext: {
    enabled: boolean;
    sourceLabel: string;
  };
  apiKey: {
    configured: boolean;
    sourceLabel: string;
  };
  model: {
    value: string;
    sourceLabel: string;
  };
  endpoint: {
    value: string;
    sourceLabel: string;
  };
  envFiles: {
    loaded: boolean;
    label: string;
    paths: string[];
  };
  sessionOverrides: string[];
  git: StateGitSummary;
  project: StateProjectAssetSummary;
};

type PromptScanExportData = {
  scopeLabel: 'current_project';
  tokenizerModeLabel: string;
  tokenizerWarning?: string;
  result: PromptScanResult;
  anatomyView: ContextAnatomyView;
};

type TokenScanExportData = {
  target: TokenScanTarget;
  summary: TokenStructureSummary;
};

type ContextHealthExportData = {
  target: TokenScanTarget;
  records: ContextUsageRecord[];
  snapshot: ContextHealthSnapshot | null;
};

type NoiseEvaluationExportData = {
  target: TokenScanTarget;
  report: NoiseEvaluationReport | null;
};

type TodoGranularityExportData = {
  target: TokenScanTarget;
  analysis: TodoGranularityAnalysis | null;
};

export class CommandHandler {
  private static readonly ANATOMY_BAR_WIDTH = 28;
  private static readonly MAX_CLAUDE_HISTORY_FILES = 6;
  private static readonly MAX_CLAUDE_HISTORY_ITEMS = 240;
  private static readonly MAX_CLAUDE_HISTORY_CHARS = 32000;
  private static readonly MAX_TOKEN_SCAN_FILES_PER_PROJECT = 24;
  private static readonly MAX_TOKEN_SCAN_FILES_PER_PROJECT_ALL = 5;
  private static readonly MAX_TOKEN_SCAN_FILES_TOTAL = 120;
  private static readonly TOKEN_BAR_WIDTH = 24;
  private static readonly DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
  private static readonly CONTEXT_HEALTH_WARNING_PERCENT = 70;
  private static readonly CONTEXT_HEALTH_CRITICAL_PERCENT = 85;
  private static readonly AUTOCOMPACT_BUFFER_RATIO = 0.2;
  private static readonly CONTEXT_HEALTH_RECENT_RECORDS = 8;
  private static readonly CONTEXT_HEALTH_MAX_RECORDS_PER_FILE = 3;
  private static readonly SCAN_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
  private static readonly COST_ESTIMATE_OUTPUT_EXAMPLE_TOKENS = 800;
  private readonly COMMAND_HINT_COLOR = chalk.hex('#D6F54A');
  private conversationManager: ConversationManager;
  private uiRenderer: UIRenderer;
  private commandRegistry: CommandRegistry;
  private configStore: ConfigStore;
  private onModelSwitch: (args: string[]) => Promise<void>;
  private onProviderSwitch: (args: string[]) => Promise<void>;
  private onCommandDataGenerated: (command: string, data: string) => void;
  private onProjectContextControl: (args: string[]) => Promise<void>;
  private onTrustCurrentPath: () => Promise<void>;
  private onTrustCheckCurrentPath: () => Promise<void>;
  private onNavigateBack: () => Promise<void>;
  private onNavigateHome: () => Promise<void>;
  private onOpenMenu: () => Promise<void>;
  private promptAssetScanner: PromptAssetScanner;
  private ruleScanner: RuleScanner;
  private skillScanner: SkillScanner;
  private contextNoiseAnalyzer: ContextNoiseAnalyzer;
  private noiseEvaluator: NoiseEvaluator;
  private claudeTokenizer: ClaudeTokenizer;
  private tiktokenTokenizer: TiktokenTokenizer;
  private openRouterModelCatalog: OpenRouterModelCatalog;

  constructor(
    conversationManager: ConversationManager,
    uiRenderer: UIRenderer,
    commandRegistry: CommandRegistry,
    onModelSwitch: (args: string[]) => Promise<void>,
    onProviderSwitch: (args: string[]) => Promise<void>,
    onCommandDataGenerated: (command: string, data: string) => void,
    onProjectContextControl: (args: string[]) => Promise<void>,
    onTrustCurrentPath: () => Promise<void>,
    onTrustCheckCurrentPath: () => Promise<void>,
    onNavigateBack: () => Promise<void>,
    onNavigateHome: () => Promise<void>,
    onOpenMenu: () => Promise<void>
  ) {
    this.conversationManager = conversationManager;
    this.uiRenderer = uiRenderer;
    this.commandRegistry = commandRegistry;
    this.onModelSwitch = onModelSwitch;
    this.onProviderSwitch = onProviderSwitch;
    this.onCommandDataGenerated = onCommandDataGenerated;
    this.onProjectContextControl = onProjectContextControl;
    this.onTrustCurrentPath = onTrustCurrentPath;
    this.onTrustCheckCurrentPath = onTrustCheckCurrentPath;
    this.onNavigateBack = onNavigateBack;
    this.onNavigateHome = onNavigateHome;
    this.onOpenMenu = onOpenMenu;
    this.promptAssetScanner = new PromptAssetScanner();
    this.ruleScanner = new RuleScanner();
    this.skillScanner = new SkillScanner();
    this.contextNoiseAnalyzer = new ContextNoiseAnalyzer();
    this.noiseEvaluator = new NoiseEvaluator();
    this.configStore = new ConfigStore();
    this.claudeTokenizer = new ClaudeTokenizer(this.configStore);
    this.tiktokenTokenizer = new TiktokenTokenizer();
    this.openRouterModelCatalog = new OpenRouterModelCatalog();
  }

  async handleCommand(input: string): Promise<void> {
    const [command, ...args] = input.slice(1).split(' ');
    const normalizedCommand = command.trim().toLowerCase();

    if (!normalizedCommand) {
      this.showHelp();
      return;
    }

    const resolution = this.commandRegistry.resolveCommand(normalizedCommand);
    if (resolution.status === 'ambiguous') {
      const list = resolution.matches.slice(0, 6).map((cmd) => `/${cmd.name}`).join(', ');
      this.uiRenderer.renderInfo(`Matched multiple commands: ${list}`);
      this.uiRenderer.renderInfo('Continue typing to narrow down the command');
      return;
    }

    if (resolution.status === 'unknown') {
      this.uiRenderer.renderError(`Unknown command: ${command}`);
      this.uiRenderer.renderInfo('Type /help to see available commands');
      return;
    }

    const resolvedCommand = resolution.command.name;

    switch (resolvedCommand) {
      case 'help':
        this.showHelp();
        break;
      case 'menu':
        await this.onOpenMenu();
        break;
      case 'back':
        await this.onNavigateBack();
        break;
      case 'home':
        await this.onNavigateHome();
        break;
      case 'state':
        await this.showProjectState();
        break;
      case 'clear':
        this.clearConversation();
        break;
      case 'history':
        this.showHistory();
        break;
      case 'collapse':
        this.collapseMessages(args);
        break;
      case 'expand':
        this.expandMessages(args);
        break;
      case 'exit':
      case 'quit':
        process.exit(0);
        break;
      case 'analyze':
        this.analyzeConversation();
        break;
      case 'export':
        await this.exportConversation(args);
        break;
      case 'model':
        await this.onModelSwitch(args);
        break;
      case 'provider':
        await this.onProviderSwitch(args);
        break;
      case 'projectcontext':
      case 'projectctx':
        await this.onProjectContextControl(args);
        break;
      case 'trustpath':
      case 'trust':
        await this.onTrustCurrentPath();
        break;
      case 'trustcheck':
      case 'truststatus':
        await this.onTrustCheckCurrentPath();
        break;
      case 'skills':
      case 'scan_skills':
      case 'skillscan':
        await this.scanSkills(args);
        break;
      case 'scan_prompt':
      case 'scanprompt':
        await this.scanPromptAssets();
        break;
      case 'rules':
      case 'scan_rules':
      case 'rulecheck':
        await this.scanRules(args);
        break;
      case 'scan_tokens':
      case 'scantokens':
      case 'tokenscan':
        await this.scanTokenStructures(args);
        break;
      case 'token_usage':
      case 'tokenusage':
      case 'usage_tokens':
        await this.showTokenUsage(args);
        break;
      case 'cost':
      case 'pricing':
      case 'estimate_cost':
        await this.showCurrentCostEstimate(args);
        break;
      case 'context_health':
      case 'ctxhealth':
      case 'contexthealth':
        await this.checkContextHealth(args);
        break;
      case 'context_noise':
      case 'ctxnoise':
      case 'contextnoise':
      case 'noise_eval':
      case 'noise':
        await this.analyzeContextNoise(args);
        break;
      case 'todo_granularity':
      case 'todograin':
      case 'todocontext':
        await this.analyzeTodoGranularity(args);
        break;
    }
  }

  private showHelp(): void {
    console.log('');
    console.log(chalk.bold('  Available Commands'));

    const categories = this.commandRegistry.getCommandCategories();
    const commands = this.commandRegistry.getAllCommands();
    categories.forEach((category) => {
      console.log(chalk.dim(`  ${category}`));
      this.commandRegistry.getCommandsByCategory(category).forEach((cmd) => {
        const usage = cmd.usage || `/${cmd.name}`;
        console.log(chalk.dim('  - ') + this.COMMAND_HINT_COLOR(usage) + chalk.dim('  ') + chalk.gray(cmd.description));
      });
      console.log('');
    });

    console.log(chalk.dim('  Tip: type / and press Tab to autocomplete commands, or run /menu for the interactive menu'));
    console.log('');
    this.recordCommandData('help', `Listed ${commands.length} commands.`);
  }

  private async showProjectState(): Promise<void> {
    const currentPath = process.cwd();

    try {
      const [config, diagnostics, trusted, gitSummary, projectSummary] = await Promise.all([
        this.configStore.getConfig(),
        this.configStore.getConfigDiagnostics(),
        this.configStore.isPathTrusted(currentPath),
        this.inspectStateGit(currentPath),
        this.collectStateProjectAssetSummary(currentPath),
      ]);

      const activeProvider = config.activeProvider;
      const providerMeta = getProviderMeta(activeProvider);
      const providerConfig = config.providers[activeProvider] ?? {};
      const providerSources = diagnostics.providerSources[activeProvider];
      const apiKeyConfigured = Boolean(providerConfig.apiKey?.trim());
      const modelValue = providerConfig.model?.trim() || 'Not set';
      const endpointValue = providerConfig.baseUrl?.trim() || providerMeta.defaultBaseUrl;
      const runtimeStatus = apiKeyConfigured && providerConfig.model?.trim() ? 'ready' : 'needs setup';
      const sessionOverrides = this.getSessionOverrideLabels(providerSources);
      const envFiles = diagnostics.loadedEnvFiles.length > 0 ? diagnostics.loadedEnvFiles.join(', ') : 'none loaded';
      const projectContextSourceLabel = this.describeConfigValueSource(diagnostics.projectContextEnabledSource);
      const apiKeySourceLabel = this.describeConfigValueSource(providerSources.apiKey);
      const modelSourceLabel = this.describeConfigValueSource(providerSources.model);
      const endpointSourceLabel = this.describeConfigValueSource(providerSources.baseUrl);

      try {
        await renderStaticInkScreen(
          createElement(StateScreen, {
            scopeLabel: 'current_project',
            workspacePath: currentPath,
            configPath: this.configStore.getConfigPath(),
            trusted,
            runtimeStatus,
            providerDisplayName: providerMeta.displayName,
            providerSourceLabel: this.describeConfigValueSource(diagnostics.activeProviderSource),
            runtimeSourceLabel: this.summarizeProviderConfigSource(providerSources),
            projectContextEnabled: config.projectContextEnabled,
            projectContextSourceLabel,
            apiKeyConfigured,
            apiKeySourceLabel,
            modelValue,
            modelSourceLabel,
            endpointValue,
            endpointSourceLabel,
            envFilesLabel: envFiles,
            envFilesLoaded: diagnostics.loadedEnvFiles.length > 0,
            sessionOverrides,
            git: gitSummary,
            project: projectSummary,
          })
        );
      } catch {
        const lines = [
          this.formatStateLine('Workspace', this.formatPathForState(currentPath)),
          this.formatStateLine('Trust', trusted ? 'trusted' : 'not trusted', trusted ? 'success' : 'warning'),
          this.formatStateLine('Config file', this.formatPathForState(this.configStore.getConfigPath()), 'muted'),
          '',
          this.formatStateLine('Status', runtimeStatus, runtimeStatus === 'ready' ? 'success' : 'warning'),
          this.formatStateLine(
            'Provider',
            providerMeta.displayName,
            'default',
            this.describeConfigValueSource(diagnostics.activeProviderSource)
          ),
          this.formatStateLine('Source', this.summarizeProviderConfigSource(providerSources), 'accent'),
          this.formatStateLine(
            'Project ctx',
            config.projectContextEnabled ? 'enabled' : 'disabled',
            config.projectContextEnabled ? 'success' : 'warning',
            projectContextSourceLabel
          ),
          this.formatStateLine(
            'API key',
            apiKeyConfigured ? 'configured' : 'missing',
            apiKeyConfigured ? 'success' : 'warning',
            apiKeySourceLabel
          ),
          this.formatStateLine(
            'Model',
            modelValue,
            providerConfig.model?.trim() ? 'default' : 'warning',
            modelSourceLabel
          ),
          this.formatStateLine('Endpoint', endpointValue, 'muted', endpointSourceLabel),
          this.formatStateLine('Env files', envFiles, diagnostics.loadedEnvFiles.length > 0 ? 'accent' : 'muted'),
          this.formatStateLine(
            'Git',
            gitSummary.available ? (gitSummary.clean ? 'clean' : 'dirty') : 'not a repo',
            gitSummary.available ? (gitSummary.clean ? 'success' : 'warning') : 'muted',
            gitSummary.available ? `${gitSummary.branch} · ${gitSummary.changedFiles} changed` : undefined
          ),
          this.formatStateLine('Package', projectSummary.packageLabel, projectSummary.packageLabel === 'missing' ? 'warning' : 'default'),
          this.formatStateLine(
            'Scripts',
            `${projectSummary.scriptCount}`,
            projectSummary.scriptCount > 0 ? 'default' : 'warning',
            [
              projectSummary.hasBuildScript ? 'build' : null,
              projectSummary.hasTestScript ? 'test' : null,
              projectSummary.hasLintScript ? 'lint' : null,
              projectSummary.hasTypecheckScript ? 'typecheck' : null,
            ]
              .filter(Boolean)
              .join(', ') || 'none'
          ),
          this.formatStateLine(
            'Rules',
            `${projectSummary.ruleFileCount} files / ${projectSummary.totalRules} rules`,
            projectSummary.totalRules > 0 ? 'success' : 'muted'
          ),
          this.formatStateLine(
            'Prompts',
            `${projectSummary.promptAssetCount} assets`,
            projectSummary.promptAssetCount > 0 ? 'accent' : 'muted',
            `${projectSummary.systemPromptCount} system`
          ),
          this.formatStateLine(
            'Skills',
            `${projectSummary.skillCount}`,
            projectSummary.skillCount > 0 ? 'accent' : 'muted',
            `${projectSummary.skillResourceFiles} resource files`
          ),
        ];

        if (sessionOverrides.length > 0) {
          lines.push(this.formatStateLine('Session', sessionOverrides.join(', '), 'success'));
        }

        if (!trusted) {
          lines.push(this.formatStateLine('Hint', 'Run /trustpath to trust this directory', 'accent'));
        }

        console.log('');
        console.log(
          boxen(lines.join('\n'), {
            title: ' Project State ',
            titleAlignment: 'center',
            borderStyle: 'round',
            borderColor: 'cyan',
            padding: { top: 0, bottom: 0, left: 1, right: 1 },
          })
        );
        console.log('');
      }

      this.recordCommandData(
        'state',
        [
          `workspace=${currentPath}`,
          `trusted=${trusted}`,
          `configPath=${this.configStore.getConfigPath()}`,
          `status=${runtimeStatus}`,
          `provider=${activeProvider}`,
          `providerSource=${diagnostics.activeProviderSource}`,
          `runtimeSource=${this.summarizeProviderConfigSource(providerSources)}`,
          `projectContext=${config.projectContextEnabled}`,
          `projectContextSource=${diagnostics.projectContextEnabledSource}`,
          `apiKeyConfigured=${apiKeyConfigured}`,
          `apiKeySource=${providerSources.apiKey}`,
          `model=${modelValue}`,
          `modelSource=${providerSources.model}`,
          `endpoint=${endpointValue}`,
          `endpointSource=${providerSources.baseUrl}`,
          `envFiles=${envFiles}`,
          `sessionOverrides=${sessionOverrides.join(', ') || '(none)'}`,
          `gitAvailable=${gitSummary.available}`,
          `gitBranch=${gitSummary.branch}`,
          `gitClean=${gitSummary.clean}`,
          `gitChangedFiles=${gitSummary.changedFiles}`,
          `package=${projectSummary.packageLabel}`,
          `packageManager=${projectSummary.packageManager}`,
          `scriptCount=${projectSummary.scriptCount}`,
          `rules=${projectSummary.ruleFileCount}/${projectSummary.totalRules}`,
          `prompts=${projectSummary.promptAssetCount}`,
          `skills=${projectSummary.skillCount}`,
          `workspaceClaude=${projectSummary.hasWorkspaceClaude}`,
          `workspaceCodex=${projectSummary.hasWorkspaceCodex}`,
          `workspaceCursor=${projectSummary.hasWorkspaceCursor}`,
          `odradekDir=${projectSummary.hasOdradekDir}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read project state';
      this.uiRenderer.renderError(message);
      this.recordCommandData('state', `failed: ${message}`);
    }
  }

  private clearConversation(): void {
    this.conversationManager.clear();
    console.clear();
    this.uiRenderer.renderSuccess('Conversation history cleared');
    this.recordCommandData('clear', 'Conversation history cleared.');
  }

  private async inspectStateGit(workspacePath: string): Promise<StateGitSummary> {
    const fallback: StateGitSummary = {
      available: false,
      repoRoot: '',
      branch: 'n/a',
      clean: true,
      changedFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      ahead: 0,
      behind: 0,
    };

    try {
      const repoRootResult = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workspacePath,
        windowsHide: true,
        timeout: 5000,
      });
      const repoRoot = repoRootResult.stdout.trim();
      if (!repoRoot) {
        return fallback;
      }

      const statusResult = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], {
        cwd: repoRoot,
        windowsHide: true,
        timeout: 5000,
      });

      const lines = statusResult.stdout.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
      const header = lines[0]?.startsWith('## ') ? lines.shift() ?? '' : '';
      let branch = 'detached';
      let ahead = 0;
      let behind = 0;

      if (header) {
        const headerBody = header.slice(3).trim();
        const branchPart = headerBody.split(' [')[0]?.trim() ?? headerBody;
        branch = branchPart.split('...')[0]?.trim() || 'detached';
        if (/^head\b/i.test(branch)) {
          branch = 'detached';
        }
        const aheadMatch = headerBody.match(/ahead (\d+)/i);
        const behindMatch = headerBody.match(/behind (\d+)/i);
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
        behind = behindMatch ? Number(behindMatch[1]) : 0;
      }

      let stagedFiles = 0;
      let unstagedFiles = 0;
      let untrackedFiles = 0;

      for (const line of lines) {
        if (line.startsWith('?? ')) {
          untrackedFiles += 1;
          continue;
        }
        const x = line[0] ?? ' ';
        const y = line[1] ?? ' ';
        if (x !== ' ') {
          stagedFiles += 1;
        }
        if (y !== ' ') {
          unstagedFiles += 1;
        }
      }

      return {
        available: true,
        repoRoot,
        branch,
        clean: lines.length === 0,
        changedFiles: lines.length,
        stagedFiles,
        unstagedFiles,
        untrackedFiles,
        ahead,
        behind,
      };
    } catch {
      return fallback;
    }
  }

  private async collectStateProjectAssetSummary(workspacePath: string): Promise<StateProjectAssetSummary> {
    const resolvedWorkspace = path.resolve(workspacePath);
    const [
      packageJsonRaw,
      hasReadme,
      hasSrcDir,
      hasTestsDir,
      hasTsConfig,
      hasEnvExample,
      hasWorkspaceClaude,
      hasWorkspaceCodex,
      hasWorkspaceCursor,
      hasAgentsFile,
      hasClaudeFile,
      hasOdradekDir,
      promptScan,
      rulesScan,
      skillsScan,
      hasPackageLock,
      hasPnpmLock,
      hasYarnLock,
      hasBunLock,
    ] = await Promise.all([
      this.readUtf8FileIfExists(path.join(resolvedWorkspace, 'package.json')),
      this.hasMatchingRootFile(resolvedWorkspace, [/^readme(?:\.[^.]+)?$/i]),
      this.hasAnyRootDirectory(resolvedWorkspace, ['src', 'app', 'lib']),
      this.hasAnyRootDirectory(resolvedWorkspace, ['test', 'tests', '__tests__', 'spec', 'specs']),
      this.hasAnyRootFile(resolvedWorkspace, ['tsconfig.json', 'tsconfig.base.json']),
      this.hasAnyRootFile(resolvedWorkspace, ['.env.example', '.env.sample', '.env.template', '.env.local.example']),
      this.isDirectory(path.join(resolvedWorkspace, '.claude')),
      this.isDirectory(path.join(resolvedWorkspace, '.codex')),
      this.isDirectory(path.join(resolvedWorkspace, '.cursor')),
      this.hasAnyRootFile(resolvedWorkspace, ['AGENTS.md']),
      this.hasAnyRootFile(resolvedWorkspace, ['CLAUDE.md']),
      this.isDirectory(path.join(resolvedWorkspace, '.odradek')),
      this.safePromptAssetScan(resolvedWorkspace),
      this.safeRuleScan(resolvedWorkspace),
      this.safeSkillScan(resolvedWorkspace),
      this.hasAnyRootFile(resolvedWorkspace, ['package-lock.json']),
      this.hasAnyRootFile(resolvedWorkspace, ['pnpm-lock.yaml']),
      this.hasAnyRootFile(resolvedWorkspace, ['yarn.lock']),
      this.hasAnyRootFile(resolvedWorkspace, ['bun.lockb']),
    ]);

    let packageLabel = 'missing';
    let packageManager = 'none';
    let scriptCount = 0;
    let hasBuildScript = false;
    let hasTestScript = false;
    let hasLintScript = false;
    let hasTypecheckScript = false;

    if (packageJsonRaw) {
      try {
        const parsed = JSON.parse(packageJsonRaw) as Record<string, unknown>;
        const packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
        const packageVersion = typeof parsed.version === 'string' ? parsed.version.trim() : '';
        packageLabel = packageName ? (packageVersion ? `${packageName}@${packageVersion}` : packageName) : 'package.json';
        packageManager = this.resolveStatePackageManager(
          typeof parsed.packageManager === 'string' ? parsed.packageManager.trim() : '',
          {
            hasPackageLock,
            hasPnpmLock,
            hasYarnLock,
            hasBunLock,
          }
        );

        const scripts =
          parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
            ? (parsed.scripts as Record<string, unknown>)
            : {};
        const scriptNames = Object.keys(scripts);
        scriptCount = scriptNames.length;
        hasBuildScript = scriptNames.some((name) => name === 'build' || name.startsWith('build:'));
        hasTestScript = scriptNames.some((name) => name === 'test' || name.startsWith('test:'));
        hasLintScript = scriptNames.some((name) => name === 'lint' || name.startsWith('lint:'));
        hasTypecheckScript = scriptNames.some(
          (name) => name === 'typecheck' || name.startsWith('typecheck:') || name === 'check-types'
        );
      } catch {
        packageLabel = 'package.json (invalid)';
        packageManager = this.resolveStatePackageManager('', {
          hasPackageLock,
          hasPnpmLock,
          hasYarnLock,
          hasBunLock,
        });
      }
    }

    const promptAssetCount = promptScan.files.length;
    const promptFileCount = promptScan.files.filter((file) => file.categories.includes('prompt-file')).length;
    const systemPromptCount = promptScan.files.filter((file) => file.categories.includes('system-prompt')).length;
    const projectConfigCount = promptScan.files.filter((file) => file.categories.includes('project-config')).length;
    const docsAssetCount = promptScan.files.filter((file) => file.categories.includes('docs')).length;

    return {
      packageLabel,
      packageManager,
      scriptCount,
      hasBuildScript,
      hasTestScript,
      hasLintScript,
      hasTypecheckScript,
      hasReadme,
      hasSrcDir,
      hasTestsDir,
      hasTsConfig,
      hasEnvExample,
      hasWorkspaceClaude,
      hasWorkspaceCodex,
      hasWorkspaceCursor,
      hasAgentsFile,
      hasClaudeFile,
      hasOdradekDir,
      promptAssetCount,
      promptFileCount,
      systemPromptCount,
      projectConfigCount,
      docsAssetCount,
      ruleFileCount: rulesScan.matchedFileCount,
      totalRules: rulesScan.totalRules,
      skillCount: skillsScan.skills.length,
      skillResourceFiles: skillsScan.totalResourceFiles,
    };
  }

  private resolveStatePackageManager(
    packageManagerField: string,
    lockfiles: { hasPackageLock: boolean; hasPnpmLock: boolean; hasYarnLock: boolean; hasBunLock: boolean }
  ): string {
    if (packageManagerField) {
      return packageManagerField.split('@')[0] || packageManagerField;
    }
    if (lockfiles.hasPnpmLock) {
      return 'pnpm';
    }
    if (lockfiles.hasYarnLock) {
      return 'yarn';
    }
    if (lockfiles.hasBunLock) {
      return 'bun';
    }
    if (lockfiles.hasPackageLock) {
      return 'npm';
    }
    return 'none';
  }

  private async safePromptAssetScan(rootPath: string): Promise<PromptScanResult> {
    try {
      return await this.promptAssetScanner.scan(rootPath);
    } catch {
      return {
        rootPath: path.resolve(rootPath),
        scannedFileCount: 0,
        files: [],
      };
    }
  }

  private async safeRuleScan(rootPath: string): Promise<RulesScanResult> {
    try {
      return await this.ruleScanner.scan(rootPath);
    } catch {
      return {
        rootPath: path.resolve(rootPath),
        scannedFileCount: 0,
        candidateFileCount: 0,
        matchedFileCount: 0,
        totalRules: 0,
        files: [],
      };
    }
  }

  private async safeSkillScan(rootPath: string): Promise<SkillScanResult> {
    try {
      return await this.skillScanner.scan(rootPath);
    } catch {
      return {
        rootPath: path.resolve(rootPath),
        scannedFileCount: 0,
        skills: [],
        totalResourceFiles: 0,
      };
    }
  }

  private async readUtf8FileIfExists(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  private async hasAnyRootFile(rootPath: string, names: string[]): Promise<boolean> {
    for (const name of names) {
      if (await this.isFile(path.join(rootPath, name))) {
        return true;
      }
    }
    return false;
  }

  private async hasMatchingRootFile(rootPath: string, patterns: RegExp[]): Promise<boolean> {
    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      return entries.some((entry) => entry.isFile() && patterns.some((pattern) => pattern.test(entry.name)));
    } catch {
      return false;
    }
  }

  private async hasAnyRootDirectory(rootPath: string, names: string[]): Promise<boolean> {
    for (const name of names) {
      if (await this.isDirectory(path.join(rootPath, name))) {
        return true;
      }
    }
    return false;
  }

  private async isFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private showHistory(): void {
    this.uiRenderer.renderAllMessages();
  }

  private collapseMessages(args: string[]): void {
    if (args.length === 0 || args[0] === 'all') {
      this.conversationManager.collapseAll();
      this.uiRenderer.renderSuccess('Collapsed all messages');
      this.uiRenderer.renderAllMessages();
      return;
    }

    const id = args[0];
    if (this.conversationManager.collapse(id)) {
      this.uiRenderer.renderSuccess(`Collapsed message ${id}`);
      this.uiRenderer.renderAllMessages();
    } else {
      this.uiRenderer.renderError(`Message not found: ${id}`);
    }
  }

  private expandMessages(args: string[]): void {
    if (args.length === 0 || args[0] === 'all') {
      this.conversationManager.expandAll();
      this.uiRenderer.renderSuccess('Expanded all messages');
      this.uiRenderer.renderAllMessages();
      return;
    }

    const id = args[0];
    if (this.conversationManager.expand(id)) {
      this.uiRenderer.renderSuccess(`Expanded message ${id}`);
      this.uiRenderer.renderAllMessages();
    } else {
      this.uiRenderer.renderError(`Message not found: ${id}`);
    }
  }

  private analyzeConversation(): void {
    const messages = this.conversationManager.getMessages();
    const total = messages.length;
    const userCount = messages.filter((m) => m.role === 'user').length;
    const assistantCount = messages.filter((m) => m.role === 'assistant').length;
    console.log('');
    console.log(chalk.bold('  Conversation Analysis'));
    console.log(chalk.dim('  - ') + chalk.gray('Total messages: ') + chalk.white(total));
    console.log(chalk.dim('  - ') + chalk.gray('User messages: ') + chalk.white(userCount));
    console.log(chalk.dim('  - ') + chalk.gray('Assistant messages: ') + chalk.white(assistantCount));
    console.log('');
    this.recordCommandData('analyze', `total=${total}, user=${userCount}, assistant=${assistantCount}`);
  }

  private async exportConversation(args: string[]): Promise<void> {
    const source = await this.resolveExportSource(args[0]);
    const selection = await this.resolveExportSelection(args[1]);
    const format: ExportFormat = 'json';
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    const selectionLabel = selection === 'all' ? '/all' : `/${selection}`;

    if (spinner) {
      spinner.start(`Exporting ${selectionLabel} diagnostics as ${format.toUpperCase()}...`);
    } else {
      this.uiRenderer.renderInfo(`Exporting ${selectionLabel} diagnostics as ${format.toUpperCase()}...`);
    }

    try {
      const document = await this.buildExportDocument(source, selection, format);
      const outputPath = await this.writeExportDocument(document, source, selection, format);
      const exportedCommands = document.commands.map((entry) => `/${entry.command}`);
      const failedCommands = document.commands.filter((entry) => entry.status === 'error');

      if (spinner) {
        spinner.stop('Export completed');
      } else {
        this.uiRenderer.renderSuccess('Export completed');
      }

      this.uiRenderer.renderSuccess(`JSON export saved to ${outputPath}`);
      this.uiRenderer.renderInfo(`Exported ${exportedCommands.join(', ')}`);
      if (failedCommands.length > 0) {
        this.uiRenderer.renderWarning(
          `${failedCommands.length} section(s) failed and were captured with error metadata in the export file`
        );
      }

      this.recordCommandData(
        'export',
        [
          `format=${format}`,
          `source=${source}`,
          `selection=${selection}`,
          `commands=${exportedCommands.join(',')}`,
          `failed=${failedCommands.length}`,
          `path=${outputPath}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export diagnostic data';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('export', `failed: ${message}`);
    }
  }

  private async resolveExportSource(input: string | undefined): Promise<TokenScanSource> {
    const normalized = this.normalizeExportSource(input);
    if (normalized) {
      return normalized;
    }

    if (input && input.trim()) {
      throw new Error('Invalid source. Usage: /export [claude|codex|cursor]');
    }

    if (!process.stdout.isTTY) {
      throw new Error('Missing source. Usage: /export [claude|codex|cursor]');
    }

    const { selectedSource } = await inquirer.prompt<{ selectedSource: TokenScanSource }>([
      {
        type: 'list',
        name: 'selectedSource',
        message: 'Select the session source to export',
        choices: [
          { name: 'Claude', value: 'claude' },
          { name: 'Codex', value: 'codex' },
          { name: 'Cursor', value: 'cursor' },
        ],
      },
    ]);

    return selectedSource;
  }

  private normalizeExportSource(input: string | undefined): TokenScanSource | null {
    const normalized = (input ?? '').trim().toLowerCase();
    if (normalized === 'claude') {
      return 'claude';
    }
    if (normalized === 'codex') {
      return 'codex';
    }
    if (normalized === 'cursor') {
      return 'cursor';
    }
    return null;
  }

  private async resolveExportSelection(input: string | undefined): Promise<ExportSelection> {
    const normalized = this.normalizeExportSelection(input);
    if (normalized) {
      return normalized;
    }

    if (input && input.trim()) {
      throw new Error(
        'Invalid export target. Use one of /state, /noise_eval, /context_health, /scan_tokens, /rules, /skills, /scan_prompt, /todo_granularity, /all'
      );
    }

    if (!process.stdout.isTTY) {
      throw new Error(
        'Missing export target. Re-run with a TTY or pass one of /state, /noise_eval, /context_health, /scan_tokens, /rules, /skills, /scan_prompt, /todo_granularity, /all'
      );
    }

    const { selectedCommand } = await inquirer.prompt<{ selectedCommand: ExportSelection }>([
      {
        type: 'list',
        name: 'selectedCommand',
        message: 'Select the diagnostic dataset to export',
        choices: [
          { name: '/state  current project and runtime status', value: 'state' },
          { name: '/noise_eval  evidence-first noise evaluation', value: 'noise_eval' },
          { name: '/context_health  context window health snapshot', value: 'context_health' },
          { name: '/scan_tokens  token structure analytics', value: 'scan_tokens' },
          { name: '/rules  explicit workspace rules and instruction lines', value: 'rules' },
          { name: '/skills  local SKILL.md inventory and support files', value: 'skills' },
          { name: '/scan_prompt  prompt and system-prompt asset scan', value: 'scan_prompt' },
          { name: '/todo_granularity  todo granularity vs context usage', value: 'todo_granularity' },
          { name: '/all  export every supported dataset above', value: 'all' },
        ],
      },
    ]);

    return selectedCommand;
  }

  private normalizeExportSelection(input: string | undefined): ExportSelection | null {
    const normalized = (input ?? '').trim().toLowerCase().replace(/^\//, '');
    const allowed = new Set<ExportSelection>([
      'state',
      'noise_eval',
      'context_health',
      'scan_tokens',
      'rules',
      'skills',
      'scan_prompt',
      'todo_granularity',
      'all',
    ]);
    return allowed.has(normalized as ExportSelection) ? (normalized as ExportSelection) : null;
  }

  private expandExportSelection(selection: ExportSelection): ExportCommandName[] {
    if (selection === 'all') {
      return [
        'state',
        'noise_eval',
        'context_health',
        'scan_tokens',
        'rules',
        'skills',
        'scan_prompt',
        'todo_granularity',
      ];
    }

    return [selection];
  }

  private async buildExportDocument(
    source: TokenScanSource,
    selection: ExportSelection,
    format: ExportFormat
  ): Promise<ExportDocument> {
    const commands = this.expandExportSelection(selection);
    const envelopes: ExportCommandEnvelope[] = [];

    for (const command of commands) {
      const invocation = this.buildExportInvocation(command, source);
      try {
        const data = await this.collectExportCommandData(command, source);
        envelopes.push({
          command,
          invocation,
          status: 'ok',
          data,
        });
      } catch (error) {
        envelopes.push({
          command,
          invocation,
          status: 'error',
          error: error instanceof Error ? error.message : `Failed to export /${command}`,
        });
      }
    }

    return {
      schemaVersion: 1,
      format,
      generatedAt: new Date().toISOString(),
      workspacePath: path.resolve(process.cwd()),
      selectedSource: source,
      selectedCommand: selection,
      commands: envelopes,
    };
  }

  private buildExportInvocation(command: ExportCommandName, source: TokenScanSource): string {
    if (
      command === 'noise_eval' ||
      command === 'context_health' ||
      command === 'scan_tokens' ||
      command === 'todo_granularity'
    ) {
      return `/${command} ${source}`;
    }

    return `/${command}`;
  }

  private async collectExportCommandData(command: ExportCommandName, source: TokenScanSource): Promise<unknown> {
    switch (command) {
      case 'state':
        return this.collectStateExportData();
      case 'noise_eval':
        return this.collectNoiseEvaluationExportData(source);
      case 'context_health':
        return this.collectContextHealthExportData(source);
      case 'scan_tokens':
        return this.collectTokenScanExportData(source);
      case 'rules':
        return {
          scopeLabel: 'current_project' as const,
          result: await this.ruleScanner.scan(process.cwd()),
        };
      case 'skills':
        return {
          scopeLabel: 'current_project' as const,
          result: await this.skillScanner.scan(process.cwd()),
        };
      case 'scan_prompt':
        return this.collectPromptScanExportData();
      case 'todo_granularity':
        return this.collectTodoGranularityExportData(source);
      default:
        return null;
    }
  }

  private async collectStateExportData(): Promise<StateExportData> {
    const currentPath = process.cwd();
    const [config, diagnostics, trusted, gitSummary, projectSummary] = await Promise.all([
      this.configStore.getConfig(),
      this.configStore.getConfigDiagnostics(),
      this.configStore.isPathTrusted(currentPath),
      this.inspectStateGit(currentPath),
      this.collectStateProjectAssetSummary(currentPath),
    ]);

    const activeProvider = config.activeProvider;
    const providerMeta = getProviderMeta(activeProvider);
    const providerConfig = config.providers[activeProvider] ?? {};
    const providerSources = diagnostics.providerSources[activeProvider];
    const apiKeyConfigured = Boolean(providerConfig.apiKey?.trim());
    const modelValue = providerConfig.model?.trim() || 'Not set';
    const endpointValue = providerConfig.baseUrl?.trim() || providerMeta.defaultBaseUrl;
    const runtimeStatus = apiKeyConfigured && providerConfig.model?.trim() ? 'ready' : 'needs setup';

    return {
      scopeLabel: 'current_project',
      workspacePath: path.resolve(currentPath),
      configPath: this.configStore.getConfigPath(),
      trusted,
      runtimeStatus,
      provider: {
        activeProvider,
        displayName: providerMeta.displayName,
        sourceLabel: this.describeConfigValueSource(diagnostics.activeProviderSource),
        runtimeSourceLabel: this.summarizeProviderConfigSource(providerSources),
      },
      projectContext: {
        enabled: config.projectContextEnabled,
        sourceLabel: this.describeConfigValueSource(diagnostics.projectContextEnabledSource),
      },
      apiKey: {
        configured: apiKeyConfigured,
        sourceLabel: this.describeConfigValueSource(providerSources.apiKey),
      },
      model: {
        value: modelValue,
        sourceLabel: this.describeConfigValueSource(providerSources.model),
      },
      endpoint: {
        value: endpointValue,
        sourceLabel: this.describeConfigValueSource(providerSources.baseUrl),
      },
      envFiles: {
        loaded: diagnostics.loadedEnvFiles.length > 0,
        label: diagnostics.loadedEnvFiles.length > 0 ? diagnostics.loadedEnvFiles.join(', ') : 'none loaded',
        paths: diagnostics.loadedEnvFiles,
      },
      sessionOverrides: this.getSessionOverrideLabels(providerSources),
      git: gitSummary,
      project: projectSummary,
    };
  }

  private async collectPromptScanExportData(): Promise<PromptScanExportData> {
    const { mode, warning, result, anatomyView } = await this.withTimeout(
      async () => {
        const tokenization = await this.resolvePromptScanTokenizationStrategy();
        const promptResult = await this.promptAssetScanner.scan(process.cwd(), {
          tokenCounter: (text, _filePath) => tokenization.countTokens(text),
        });
        const promptAnatomyView = await this.buildContextAnatomyView(promptResult.files, tokenization.countTokens);
        return {
          mode: tokenization.getMode(),
          warning: tokenization.getWarning(),
          result: promptResult,
          anatomyView: promptAnatomyView,
        };
      },
      CommandHandler.SCAN_PROMPT_TIMEOUT_MS,
      `/scan_prompt timed out after ${this.formatTimeoutMs(CommandHandler.SCAN_PROMPT_TIMEOUT_MS)}.`
    );

    const modeLabel =
      mode === 'count_tokens'
        ? 'messages/count_tokens'
        : mode === 'messages_usage'
          ? 'messages usage.input_tokens'
          : 'local estimated tokens';

    return {
      scopeLabel: 'current_project',
      tokenizerModeLabel: modeLabel,
      tokenizerWarning: warning,
      result,
      anatomyView,
    };
  }

  private async collectTokenScanExportData(source: TokenScanSource): Promise<TokenScanExportData> {
    const target = await this.resolveTokenScanTarget({
      source,
      scope: 'current',
      explicitSource: true,
    });

    return {
      target,
      summary:
        target.filePaths.length > 0
          ? await this.buildTokenStructureSummary(target.filePaths, target.source)
          : this.createEmptyTokenStructureSummary(),
    };
  }

  private createEmptyTokenStructureSummary(): TokenStructureSummary {
    return {
      files: [],
      totalFiles: 0,
      totalLines: 0,
      parsedLines: 0,
      invalidLines: 0,
      recordsWithTokens: 0,
      totalTokens: 0,
      tokenFields: [],
      roleBreakdown: [],
      typeBreakdown: [],
      dayBreakdown: [],
    };
  }

  private async collectContextHealthExportData(source: TokenScanSource): Promise<ContextHealthExportData> {
    const target = await this.resolveTokenScanTarget({
      source,
      scope: 'current',
      explicitSource: true,
    });

    const records =
      target.filePaths.length > 0
        ? await this.findRecentContextUsageRecords(
            target.filePaths,
            CommandHandler.CONTEXT_HEALTH_RECENT_RECORDS,
            target.source
          )
        : [];

    return {
      target,
      records,
      snapshot: records.length > 0 ? this.buildContextHealthSnapshot(records) : null,
    };
  }

  private async collectNoiseEvaluationExportData(source: TokenScanSource): Promise<NoiseEvaluationExportData> {
    const target = await this.resolveTokenScanTarget({
      source,
      scope: 'current',
      explicitSource: true,
    });

    if (target.filePaths.length === 0) {
      return {
        target,
        report: null,
      };
    }

    return {
      target,
      report: await this.noiseEvaluator.analyze(
        target.filePaths.map((filePath) => ({
          sessionId: path.basename(filePath, path.extname(filePath)),
          filePath,
          source: target.source,
        })),
        {
          workspaceHint: path.resolve(process.cwd()),
        }
      ),
    };
  }

  private async collectTodoGranularityExportData(source: TokenScanSource): Promise<TodoGranularityExportData> {
    const target = await this.resolveTokenScanTarget({
      source,
      scope: 'current',
      explicitSource: true,
    });

    if (target.filePaths.length === 0) {
      return {
        target,
        analysis: null,
      };
    }

    const todosRoot = target.source === 'claude' ? await this.resolveClaudeDataDirectory('todos') : null;
    const analyzer = new TodoGranularityAnalyzer({ todosRoot });

    return {
      target,
      analysis: await analyzer.analyze(
        target.filePaths.map((filePath) => ({
          sessionId: path.basename(filePath, path.extname(filePath)),
          filePath,
          source: target.source,
        }))
      ),
    };
  }

  private async writeExportDocument(
    document: ExportDocument,
    source: TokenScanSource,
    selection: ExportSelection,
    format: ExportFormat
  ): Promise<string> {
    const exportDir = path.join(process.cwd(), '.odradek', 'exports');
    await fs.mkdir(exportDir, { recursive: true });

    const timestamp = this.buildExportTimestamp(new Date());
    const selectionLabel = selection === 'all' ? 'all' : selection;
    const fileName = `odradek-export-${source}-${selectionLabel}-${timestamp}.${format}`;
    const outputPath = path.join(exportDir, fileName);
    await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    return outputPath;
  }

  private buildExportTimestamp(value: Date): string {
    const year = String(value.getFullYear());
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    const hour = String(value.getHours()).padStart(2, '0');
    const minute = String(value.getMinutes()).padStart(2, '0');
    const second = String(value.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}-${hour}${minute}${second}`;
  }

  private async scanTokenStructures(args: string[]): Promise<void> {
    const request = this.parseTokenScanRequest(args);
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start(`Parsing ${request.source} session JSONL token structures...`);
    } else {
      this.uiRenderer.renderInfo(`Parsing ${request.source} session JSONL token structures...`);
    }

    try {
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Token scan completed');
        } else {
          this.uiRenderer.renderSuccess('Token scan completed');
        }
        this.uiRenderer.renderWarning('No JSONL files found for token scan');
        this.recordCommandData(
          'scan_tokens',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const summary = await this.buildTokenStructureSummary(target.filePaths, target.source);
      if (spinner) {
        spinner.stop('Token scan completed');
      } else {
        this.uiRenderer.renderSuccess('Token scan completed');
      }

      await this.renderTokenStructureSummary(target, summary);
      const topFields = summary.tokenFields
        .slice(0, 6)
        .map((field) => `${field.name}:${Math.round(field.total)}`)
        .join(', ');
      this.recordCommandData(
        'scan_tokens',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `projectDirs=${target.projectDirs.length}`,
          `jsonlFiles=${summary.totalFiles}`,
          `parsedLines=${summary.parsedLines}`,
          `invalidLines=${summary.invalidLines}`,
          `recordsWithTokens=${summary.recordsWithTokens}`,
          `totalTokenValues=${Math.round(summary.totalTokens)}`,
          `topTokenFields=${topFields || '(none)'}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan token structures';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('scan_tokens', `failed: ${message}`);
    }
  }

  private async showTokenUsage(args: string[]): Promise<void> {
    const request = this.parseTokenScanRequest(args);
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start(`Aggregating ${request.source} daily token usage...`);
    } else {
      this.uiRenderer.renderInfo(`Aggregating ${request.source} daily token usage...`);
    }

    try {
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Token usage aggregation completed');
        } else {
          this.uiRenderer.renderSuccess('Token usage aggregation completed');
        }
        this.uiRenderer.renderWarning('No JSONL files found for token usage aggregation');
        this.recordCommandData(
          'token_usage',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const records = await this.collectContextUsageRecords(target.filePaths, target.source);
      const summary = this.buildTokenUsageSummary(target.filePaths, records);
      if (spinner) {
        spinner.stop('Token usage aggregation completed');
      } else {
        this.uiRenderer.renderSuccess('Token usage aggregation completed');
      }

      if (summary.totalRecords === 0) {
        this.uiRenderer.renderWarning('No token usage records found in scanned JSONL files');
        this.recordCommandData(
          'token_usage',
          [
            `scope=${target.scopeLabel}`,
            `source=${target.sourceLabel}`,
            `jsonlFiles=${target.filePaths.length}`,
            'usageRecords=0',
          ].join('\n')
        );
        return;
      }

      await this.renderTokenUsageSummary(target, summary);
      const topModels = summary.models
        .slice(0, 4)
        .map((model) => `${model.model}:${Math.round(model.totalTokens)}`)
        .join(', ');
      this.recordCommandData(
        'token_usage',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `projectDirs=${target.projectDirs.length}`,
          `jsonlFiles=${target.filePaths.length}`,
          `usageRecords=${summary.totalRecords}`,
          `activeDays=${summary.totalDays}`,
          `models=${summary.models.length}`,
          `totalTokens=${Math.round(summary.totalTokens)}`,
          `inputTokens=${Math.round(summary.inputTokens)}`,
          `outputTokens=${Math.round(summary.outputTokens)}`,
          `topModels=${topModels || '(none)'}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to aggregate token usage';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('token_usage', `failed: ${message}`);
    }
  }

  private async showCurrentCostEstimate(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Estimating current request cost...');
    } else {
      this.uiRenderer.renderInfo('Estimating current request cost...');
    }

    try {
      const presentation = await this.buildCurrentCostEstimate(args);
      if (spinner) {
        spinner.stop('Cost estimate completed');
      } else {
        this.uiRenderer.renderSuccess('Cost estimate completed');
      }

      await this.renderCostEstimate(presentation);
      this.recordCommandData(
        'cost',
        [
          `targetFamily=${presentation.targetFamily}`,
          `provider=${presentation.provider}`,
          `activeModel=${presentation.activeModel}`,
          `inputTokens=${Math.round(presentation.totalInputTokens)}`,
          `cacheEligibleTokens=${Math.round(presentation.cacheEligibleTokens)}`,
          `dynamicTokens=${Math.round(presentation.dynamicTokens)}`,
          ...presentation.variants.flatMap((variant) => [
            `model=${variant.label}:${variant.resolvedMatch.entry.id}:${variant.resolvedMatch.strategy}`,
            ...variant.scenarios.map(
              (scenario) =>
                `${variant.label}/${scenario.label}: inputUsd=${scenario.inputCostUsd.toFixed(6)}, totalWith${presentation.outputExampleTokens}OutUsd=${scenario.totalWithOutputExampleUsd.toFixed(6)}`
            ),
          ]),
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to estimate current request cost';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('cost', `failed: ${message}`);
    }
  }

  private async buildCurrentCostEstimate(args: string[]): Promise<CostEstimatePresentation> {
    const config = await this.configStore.getConfig();
    const provider = config.activeProvider;
    const activeModel = config.providers[provider]?.model?.trim() || '';
    if (!activeModel) {
      throw new Error(`Current ${getProviderMeta(provider).displayName} model is not configured. Use /model first.`);
    }

    const targetFamily = this.resolveCostEstimateFamily(args, provider, activeModel);
    if (targetFamily === 'cursor') {
      throw new Error('Cursor model pricing is not publicly available, so /cost cursor is intentionally not supported.');
    }

    const segmentSnapshot = await this.withTimeout(
      () => this.collectCurrentCostSegments(targetFamily === 'claude' ? 'claude' : 'openrouter'),
      CommandHandler.SCAN_PROMPT_TIMEOUT_MS,
      `/cost timed out after ${this.formatTimeoutMs(CommandHandler.SCAN_PROMPT_TIMEOUT_MS)}.`
    );

    const openRouterBaseUrl = config.providers.openrouter?.baseUrl?.trim() || getProviderMeta('openrouter').defaultBaseUrl;
    const openRouterApiKey = config.providers.openrouter?.apiKey?.trim() || undefined;
    const catalogEntries = await this.openRouterModelCatalog.fetchModels(openRouterBaseUrl, openRouterApiKey);
    const variants = this.resolveCostEstimateVariants(targetFamily, activeModel, catalogEntries);
    if (variants.length === 0) {
      throw new Error(`No OpenRouter pricing models were resolved for /cost ${targetFamily}.`);
    }

    const outputExampleTokens = CommandHandler.COST_ESTIMATE_OUTPUT_EXAMPLE_TOKENS;
    const pricedVariants = variants.map((variant) => {
      const rates: CostEstimateRateCard = {
        prompt: variant.resolvedMatch.entry.pricing.prompt,
        completion: variant.resolvedMatch.entry.pricing.completion,
        request: variant.resolvedMatch.entry.pricing.request,
        inputCacheRead: variant.resolvedMatch.entry.pricing.inputCacheRead,
        inputCacheWrite: variant.resolvedMatch.entry.pricing.inputCacheWrite,
      };

      if (rates.prompt === null) {
        throw new Error(`OpenRouter pricing for ${variant.resolvedMatch.entry.id} does not include prompt pricing.`);
      }

      return {
        ...variant,
        rates,
        scenarios: this.buildCostEstimateScenarios(
          segmentSnapshot.cacheEligibleTokens,
          segmentSnapshot.dynamicTokens,
          rates,
          outputExampleTokens
        ),
      };
    });

    const assumptions = [
      'Cache-eligible prefix is estimated as core instructions, reusable rules/prompts, and scanned reference docs.',
      'Chat history and the active user request stay dynamic, so they are always charged at the regular prompt rate.',
      `Scenario totals include each model's request fee and a ${outputExampleTokens.toLocaleString('en-US')}-token output example.`,
      'OpenRouter pricing is fetched live from /api/v1/models and cached locally for 24 hours (~/.claude-estimator/model-prices.json).',
    ];

    return {
      targetFamily,
      targetLabel: this.getCostEstimateTargetLabel(targetFamily),
      provider,
      providerLabel: getProviderMeta(provider).displayName,
      activeModel,
      totalInputTokens: segmentSnapshot.totalInputTokens,
      cacheEligibleTokens: segmentSnapshot.cacheEligibleTokens,
      dynamicTokens: segmentSnapshot.dynamicTokens,
      outputExampleTokens,
      segments: segmentSnapshot.segments,
      variants: pricedVariants,
      assumptions,
    };
  }

  private resolveCostEstimateFamily(args: string[], provider: ProviderName, activeModel: string): CostEstimateFamily {
    const normalized = args[0]?.trim().toLowerCase();
    if (normalized === 'codex' || normalized === 'openai' || normalized === 'gpt') {
      return 'codex';
    }
    if (normalized === 'claude' || normalized === 'anthropic') {
      return 'claude';
    }
    if (normalized === 'cursor') {
      return 'cursor';
    }
    if (normalized === 'qwen') {
      throw new Error('Qwen pricing is not being estimated right now. Use /cost codex or /cost claude instead.');
    }
    if (normalized) {
      throw new Error(`Unknown /cost target "${args[0]}". Use /cost codex, /cost claude, or /cost cursor.`);
    }

    const lowerModel = activeModel.toLowerCase();
    if (provider === 'claude' || lowerModel.includes('claude')) {
      return 'claude';
    }
    if (lowerModel.includes('gpt') || lowerModel.includes('codex') || lowerModel.includes('openai/')) {
      return 'codex';
    }

    throw new Error('Cannot infer a pricing family from the current model. Use /cost codex or /cost claude explicitly.');
  }

  private getCostEstimateTargetLabel(targetFamily: CostEstimateFamily): string {
    if (targetFamily === 'claude') {
      return 'Claude family';
    }
    if (targetFamily === 'codex') {
      return 'Codex / GPT family';
    }
    return 'Cursor';
  }

  private resolveCostEstimateVariants(
    targetFamily: Exclude<CostEstimateFamily, 'cursor'>,
    activeModel: string,
    entries: OpenRouterModelCatalogEntry[]
  ): Array<{ label: string; resolvedMatch: OpenRouterModelMatch }> {
    const seen = new Set<string>();
    const variants: Array<{ label: string; resolvedMatch: OpenRouterModelMatch }> = [];

    const pushVariant = (label: string, modelName: string) => {
      const resolvedMatch = this.openRouterModelCatalog.resolveModel(modelName, entries, 'openrouter');
      if (!resolvedMatch || seen.has(resolvedMatch.entry.id)) {
        return;
      }
      seen.add(resolvedMatch.entry.id);
      variants.push({ label, resolvedMatch });
    };

    if (targetFamily === 'codex') {
      if (activeModel.toLowerCase().includes('gpt') || activeModel.toLowerCase().includes('codex')) {
        pushVariant('Current match', activeModel);
      }
      pushVariant('GPT-5.4', 'openai/gpt-5.4');
      pushVariant('GPT-5.3 Codex', 'openai/gpt-5.3-codex');
      return variants;
    }

    const claudeBuckets: Array<{ label: string; candidates: string[] }> = [
      {
        label: 'Opus',
        candidates: ['anthropic/claude-opus-4.6'],
      },
      {
        label: 'Sonnet',
        candidates: ['anthropic/claude-sonnet-4.6'],
      },
      {
        label: 'Haiku',
        candidates: ['anthropic/claude-haiku-4.5'],
      },
    ];

    claudeBuckets.forEach((bucket) => {
      for (const candidate of bucket.candidates) {
        const resolvedMatch = this.openRouterModelCatalog.resolveModel(candidate, entries, 'claude');
        if (!resolvedMatch || seen.has(resolvedMatch.entry.id)) {
          continue;
        }
        seen.add(resolvedMatch.entry.id);
        variants.push({ label: bucket.label, resolvedMatch });
        break;
      }
    });

    if (variants.length === 0 && activeModel.toLowerCase().includes('claude')) {
      pushVariant('Current match', activeModel);
    }

    return variants;
  }

  private async collectCurrentCostSegments(provider: ProviderName): Promise<{
    segments: CostEstimateSegment[];
    totalInputTokens: number;
    cacheEligibleTokens: number;
    dynamicTokens: number;
  }> {
    const rootPath = process.cwd();
    const scanResult = await this.promptAssetScanner.scan(rootPath, {
      tokenCounter: async (text: string) => this.countTokensForProvider(text, provider),
    });

    const systemFiles: Array<{ tokenCount: number }> = [];
    const promptLibraryFiles: Array<{ tokenCount: number }> = [];
    const referenceDocsFiles: Array<{ tokenCount: number }> = [];
    scanResult.files.forEach((file) => {
      const bucket = this.classifyPromptAssetForAnatomy(file);
      if (bucket === 'system') {
        systemFiles.push(file);
        return;
      }
      if (bucket === 'prompt_library') {
        promptLibraryFiles.push(file);
        return;
      }
      referenceDocsFiles.push(file);
    });

    const messages = this.conversationManager.getMessages();
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const historyMessages = messages.filter((message) => message.id !== latestUserMessage?.id);
    const [userMessageTokens, historyTokenParts] = await Promise.all([
      latestUserMessage ? this.countTokensForProvider(latestUserMessage.content, provider) : Promise.resolve(0),
      Promise.all(historyMessages.map((message) => this.countTokensForProvider(message.content, provider))),
    ]);

    const segments: CostEstimateSegment[] = [
      {
        key: 'system',
        label: 'Core instructions',
        tokenCount: systemFiles.reduce((sum, file) => sum + file.tokenCount, 0),
        cacheEligible: true,
      },
      {
        key: 'prompt_library',
        label: 'Rules & prompts',
        tokenCount: promptLibraryFiles.reduce((sum, file) => sum + file.tokenCount, 0),
        cacheEligible: true,
      },
      {
        key: 'reference_docs',
        label: 'Reference docs',
        tokenCount: referenceDocsFiles.reduce((sum, file) => sum + file.tokenCount, 0),
        cacheEligible: true,
      },
      {
        key: 'chat_history',
        label: 'Chat history',
        tokenCount: historyTokenParts.reduce((sum, value) => sum + value, 0),
        cacheEligible: false,
      },
      {
        key: 'active_request',
        label: 'Active request',
        tokenCount: userMessageTokens,
        cacheEligible: false,
      },
    ];

    const totalInputTokens = segments.reduce((sum, segment) => sum + segment.tokenCount, 0);
    const cacheEligibleTokens = segments
      .filter((segment) => segment.cacheEligible)
      .reduce((sum, segment) => sum + segment.tokenCount, 0);
    const dynamicTokens = Math.max(0, totalInputTokens - cacheEligibleTokens);

    return {
      segments,
      totalInputTokens,
      cacheEligibleTokens,
      dynamicTokens,
    };
  }

  private async countTokensForProvider(text: string, provider: ProviderName): Promise<number> {
    try {
      if (provider === 'claude') {
        return await this.claudeTokenizer.countTextTokens(text);
      }
      return await this.tiktokenTokenizer.countTextTokens(text);
    } catch {
      return estimateTokenCount(text);
    }
  }

  private buildCostEstimateScenarios(
    cacheEligibleTokens: number,
    dynamicTokens: number,
    rates: CostEstimateRateCard,
    outputExampleTokens: number
  ): CostEstimateScenario[] {
    const completionRate = rates.completion ?? 0;
    const outputExampleCostUsd = outputExampleTokens * completionRate;
    const coldInputCostUsd = this.calculateInputCostUsd(cacheEligibleTokens, dynamicTokens, rates, 'cold');
    const cacheWriteUsesFallback = rates.inputCacheWrite === null;
    const cacheReadUsesFallback = rates.inputCacheRead === null;

    const scenarios: CostEstimateScenario[] = [
      {
        label: 'Cold request',
        inputCostUsd: coldInputCostUsd,
        outputExampleCostUsd,
        totalWithOutputExampleUsd: coldInputCostUsd + outputExampleCostUsd,
        savingsVsColdUsd: 0,
        note: 'All input is charged at the normal prompt rate.',
      },
      {
        label: 'Cache write',
        inputCostUsd: this.calculateInputCostUsd(cacheEligibleTokens, dynamicTokens, rates, 'cache-write'),
        outputExampleCostUsd,
        totalWithOutputExampleUsd:
          this.calculateInputCostUsd(cacheEligibleTokens, dynamicTokens, rates, 'cache-write') + outputExampleCostUsd,
        savingsVsColdUsd: 0,
        note: cacheWriteUsesFallback
          ? 'This model does not expose a separate cache-write price, so prompt pricing is used as fallback.'
          : 'Stable prefix is written into cache on this request; dynamic tokens stay uncached.',
      },
      {
        label: 'Cache hit',
        inputCostUsd: this.calculateInputCostUsd(cacheEligibleTokens, dynamicTokens, rates, 'cache-hit'),
        outputExampleCostUsd,
        totalWithOutputExampleUsd:
          this.calculateInputCostUsd(cacheEligibleTokens, dynamicTokens, rates, 'cache-hit') + outputExampleCostUsd,
        savingsVsColdUsd: 0,
        note: cacheReadUsesFallback
          ? 'This model does not expose a separate cache-read price, so prompt pricing is used as fallback.'
          : 'Stable prefix is assumed to be fully cached already; only dynamic tokens pay the full prompt rate.',
      },
    ];

    return scenarios.map((scenario) => ({
      ...scenario,
      savingsVsColdUsd: Math.max(0, coldInputCostUsd - scenario.inputCostUsd),
    }));
  }

  private calculateInputCostUsd(
    cacheEligibleTokens: number,
    dynamicTokens: number,
    rates: CostEstimateRateCard,
    mode: 'cold' | 'cache-write' | 'cache-hit'
  ): number {
    const promptRate = rates.prompt ?? 0;
    const requestFee = rates.request ?? 0;
    const cacheEligibleRate =
      mode === 'cold'
        ? promptRate
        : mode === 'cache-write'
          ? rates.inputCacheWrite ?? promptRate
          : rates.inputCacheRead ?? promptRate;

    return cacheEligibleTokens * cacheEligibleRate + dynamicTokens * promptRate + requestFee;
  }

  private async renderCostEstimate(presentation: CostEstimatePresentation): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(CostEstimateScreen, {
          targetLabel: presentation.targetLabel,
          providerLabel: presentation.providerLabel,
          activeModel: presentation.activeModel,
          totalInputTokens: presentation.totalInputTokens,
          cacheEligibleTokens: presentation.cacheEligibleTokens,
          dynamicTokens: presentation.dynamicTokens,
          outputExampleTokens: presentation.outputExampleTokens,
          segments: presentation.segments.map((segment) => ({
            label: segment.label,
            tokenCount: segment.tokenCount,
            cacheEligible: segment.cacheEligible,
          })),
          variants: presentation.variants.map((variant) => ({
            label: variant.label,
            resolvedModelId: variant.resolvedMatch.entry.id,
            resolvedBy: this.formatCostResolveStrategy(variant.resolvedMatch),
            rates: [
              { label: 'Prompt', perMillionUsd: this.toPerMillionUsd(variant.rates.prompt) },
              { label: 'Completion', perMillionUsd: this.toPerMillionUsd(variant.rates.completion) },
              { label: 'Cache read', perMillionUsd: this.toPerMillionUsd(variant.rates.inputCacheRead) },
              { label: 'Cache write', perMillionUsd: this.toPerMillionUsd(variant.rates.inputCacheWrite) },
              { label: 'Request fee', perMillionUsd: variant.rates.request },
            ],
            scenarios: variant.scenarios,
          })),
          assumptions: presentation.assumptions,
        })
      );
      return;
    } catch {
      this.renderCostEstimateFallback(presentation);
    }
  }

  private renderCostEstimateFallback(presentation: CostEstimatePresentation): void {
    const headerLines = [
      `Target family: ${presentation.targetLabel}`,
      `Provider: ${presentation.providerLabel}`,
      `Active model: ${presentation.activeModel}`,
      `Input tokens: ${this.formatTokenNumber(presentation.totalInputTokens)} tok`,
      `Cache-eligible: ${this.formatTokenNumber(presentation.cacheEligibleTokens)} tok`,
      `Dynamic: ${this.formatTokenNumber(presentation.dynamicTokens)} tok`,
      `Output example: ${this.formatTokenNumber(presentation.outputExampleTokens)} tok`,
    ];

    console.log(
      boxen(headerLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Cost Estimate ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Segments'));
    presentation.segments.forEach((segment) => {
      const suffix = segment.cacheEligible ? 'cached-prefix' : 'dynamic';
      console.log(
        `  ${segment.cacheEligible ? chalk.cyan('-') : chalk.dim('-')} ${chalk.white(segment.label.padEnd(18, ' '))} ${this
          .formatTokenNumber(segment.tokenCount)
          .padStart(8, ' ')} tok ${chalk.dim(suffix)}`
      );
    });

    console.log('');
    console.log(chalk.bold('  Models'));
    presentation.variants.forEach((variant) => {
      const resolved = variant.resolvedMatch.entry;
      const rateLines = [
        `Prompt: ${this.formatUsd(this.toPerMillionUsd(variant.rates.prompt), true)} / 1M tok`,
        `Completion: ${this.formatUsd(this.toPerMillionUsd(variant.rates.completion), true)} / 1M tok`,
        `Cache read: ${this.formatUsd(this.toPerMillionUsd(variant.rates.inputCacheRead), true)} / 1M tok`,
        `Cache write: ${this.formatUsd(this.toPerMillionUsd(variant.rates.inputCacheWrite), true)} / 1M tok`,
        `Request fee: ${this.formatUsd(variant.rates.request, true)}`,
      ];
      console.log(`  - ${chalk.white(variant.label)}  ${chalk.dim(`${resolved.id} · ${this.formatCostResolveStrategy(variant.resolvedMatch)}`)}`);
      rateLines.forEach((line) => console.log(`    ${chalk.dim(line)}`));
      variant.scenarios.forEach((scenario) => {
        console.log(
          `    ${chalk.white(scenario.label)}  input ${this.formatUsd(scenario.inputCostUsd, true)}  total(+${presentation.outputExampleTokens} out) ${this.formatUsd(scenario.totalWithOutputExampleUsd, true)}`
        );
        console.log(`      ${chalk.dim(`save vs cold ${this.formatUsd(scenario.savingsVsColdUsd, true)} | ${scenario.note}`)}`);
      });
    });

    console.log('');
    console.log(chalk.bold('  Assumptions'));
    presentation.assumptions.forEach((assumption) => {
      console.log(chalk.dim(`  - ${assumption}`));
    });
  }

  private formatCostResolveStrategy(match: OpenRouterModelMatch): string {
    const labels: Record<OpenRouterModelMatch['strategy'], string> = {
      'exact-id': 'exact id',
      'exact-canonical': 'exact canonical slug',
      'provider-prefixed': 'provider prefix heuristic',
      'suffix-id': 'suffix id match',
      'suffix-canonical': 'suffix canonical match',
      basename: 'basename heuristic',
    };
    return labels[match.strategy];
  }

  private toPerMillionUsd(ratePerToken: number | null): number | null {
    if (ratePerToken === null) {
      return null;
    }
    return ratePerToken * 1_000_000;
  }

  private formatUsd(value: number | null, allowNa = false): string {
    if (value === null) {
      return allowNa ? 'n/a' : '$0.000000';
    }
    if (value === 0) {
      return '$0.0000';
    }
    if (Math.abs(value) >= 1) {
      return `$${value.toFixed(2)}`;
    }
    if (Math.abs(value) >= 0.01) {
      return `$${value.toFixed(4)}`;
    }
    return `$${value.toFixed(6)}`;
  }

  private async checkContextHealth(args: string[]): Promise<void> {
    const request = this.parseTokenScanRequest(args);
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start(`Evaluating ${request.source} context health...`);
    } else {
      this.uiRenderer.renderInfo(`Evaluating ${request.source} context health...`);
    }

    try {
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Context health check completed');
        } else {
          this.uiRenderer.renderSuccess('Context health check completed');
        }
        this.uiRenderer.renderWarning('No JSONL files found for context health detection');
        this.recordCommandData(
          'context_health',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'context=missing_jsonl'].join('\n')
        );
        return;
      }

      const recentRecords = await this.findRecentContextUsageRecords(
        target.filePaths,
        CommandHandler.CONTEXT_HEALTH_RECENT_RECORDS,
        target.source
      );
      if (recentRecords.length === 0) {
        if (spinner) {
          spinner.stop('Context health check completed');
        } else {
          this.uiRenderer.renderSuccess('Context health check completed');
        }
        this.uiRenderer.renderWarning('No usage/context fields found in scanned JSONL records');
        this.recordCommandData(
          'context_health',
          [
            `scope=${target.scopeLabel}`,
            `source=${target.sourceLabel}`,
            `jsonlFiles=${target.filePaths.length}`,
            'context=no_usage_fields',
          ].join('\n')
        );
        return;
      }

      const snapshot = this.buildContextHealthSnapshot(recentRecords);
      if (spinner) {
        spinner.stop('Context health check completed');
      } else {
        this.uiRenderer.renderSuccess('Context health check completed');
      }

      await this.renderContextHealthSnapshot(target, snapshot);
      this.recordCommandData(
        'context_health',
        [
          `scope=${target.scopeLabel}`,
          `selectedSource=${target.source}`,
          `usageSource=${snapshot.source}`,
          `level=${snapshot.level}`,
          `confidence=${snapshot.confidence}`,
          `samples=${snapshot.dataPoints}`,
          `comparableSamples=${snapshot.comparableDataPoints}`,
          `nativeSamples=${snapshot.nativeSampleCount}`,
          `calculatedSamples=${snapshot.calculatedSampleCount}`,
          `explicitWindowSamples=${snapshot.explicitWindowSampleCount}`,
          `estimatedWindowSamples=${snapshot.estimatedWindowSampleCount}`,
          `mixedModels=${snapshot.mixedModels}`,
          `mixedContextWindows=${snapshot.mixedContextWindows}`,
          `effectivePercent=${snapshot.effectivePercent.toFixed(2)}`,
          `smoothedEffectivePercent=${snapshot.smoothedEffectivePercent.toFixed(2)}`,
          `trendDeltaPercent=${snapshot.trendDeltaPercent === null ? 'n/a' : snapshot.trendDeltaPercent.toFixed(2)}`,
          `rawPercent=${snapshot.rawPercent.toFixed(2)}`,
          `usageDerivedPercent=${snapshot.usageDerivedPercent.toFixed(2)}`,
          `percentDrift=${snapshot.percentDrift === null ? 'n/a' : snapshot.percentDrift.toFixed(2)}`,
          `usedTokens=${Math.round(snapshot.usedTokens)}`,
          `windowTokens=${snapshot.contextWindowTokens}`,
          `model=${snapshot.model}`,
          `timestamp=${snapshot.timestampLabel}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to evaluate context health';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('context_health', `failed: ${message}`);
    }
  }

  private async analyzeContextNoise(args: string[]): Promise<void> {
    const request = this.parseTokenScanRequest(args);
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start(`Running formal noise evaluation from ${request.source} sessions...`);
    } else {
      this.uiRenderer.renderInfo(`Running formal noise evaluation from ${request.source} sessions...`);
    }

    try {
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Noise evaluation completed');
        } else {
          this.uiRenderer.renderSuccess('Noise evaluation completed');
        }
        this.uiRenderer.renderWarning(`No ${target.source} session JSONL files found for noise evaluation`);
        this.recordCommandData(
          'noise_eval',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const report = await this.noiseEvaluator.analyze(
        target.filePaths.map((filePath) => ({
          sessionId: path.basename(filePath, path.extname(filePath)),
          filePath,
          source: target.source,
        })),
        {
          workspaceHint: request.scope === 'current' ? path.resolve(process.cwd()) : undefined,
        }
      );

      if (spinner) {
        spinner.stop('Noise evaluation completed');
      } else {
        this.uiRenderer.renderSuccess('Noise evaluation completed');
      }

      await this.renderNoiseEvaluation(target, report);
      this.recordCommandData(
        'noise_eval',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `jsonlFiles=${target.filePaths.length}`,
          `sessionsAnalyzed=${report.sessionsAnalyzed}`,
          `coverageGrade=${report.coverageGrade}`,
          `workspaceRoot=${report.workspaceRoot || 'n/a'}`,
          `estimatedTokens=${Math.round(report.totalEstimatedTokens)}`,
          `toolCalls=${report.totalToolCalls}`,
          `outcome=${report.dimensions.find((dimension) => dimension.key === 'outcome')?.status ?? 'n/a'}`,
          `process=${report.dimensions.find((dimension) => dimension.key === 'process')?.status ?? 'n/a'}`,
          `context=${report.dimensions.find((dimension) => dimension.key === 'context')?.status ?? 'n/a'}`,
          `validation=${report.dimensions.find((dimension) => dimension.key === 'validation')?.status ?? 'n/a'}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run noise evaluation';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('noise_eval', `failed: ${message}`);
    }
  }

  private async renderNoiseEvaluation(target: TokenScanTarget, report: NoiseEvaluationReport): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(NoiseEvaluationScreen, {
          scopeLabel: target.scopeLabel,
          sourceLabel: target.sourceLabel,
          selectedSource: target.source,
          report,
        })
      );
      return;
    } catch {
      this.renderNoiseEvaluationFallback(target, report);
    }
  }

  private renderNoiseEvaluationFallback(target: TokenScanTarget, report: NoiseEvaluationReport): void {
    const metaLines: string[] = [
      `Command: /noise_eval ${target.source}`,
      `Scope: ${target.scopeLabel} (${target.sourceLabel})`,
      `Coverage grade: ${this.renderCoverageGrade(report.coverageGrade)}`,
      `Workspace root: ${report.workspaceRoot || 'n/a'}`,
      `Sessions analyzed: ${report.sessionsAnalyzed}/${report.sessionsScanned}`,
      `Estimated tokens: ${this.formatTokenNumber(report.totalEstimatedTokens)} tok`,
      `Tool calls: ${this.formatTokenNumber(report.totalToolCalls)}`,
    ];

    console.log(
      boxen(metaLines.join('\n'), {
        borderStyle: 'round',
        borderColor: report.coverageGrade === 'A' ? 'green' : report.coverageGrade === 'B' ? 'yellow' : 'red',
        title: ' Noise Evaluation ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Evidence Coverage'));
    report.coverage.forEach((row) => {
      const availability = row.available ? chalk.green('yes') : chalk.red('no');
      const reliability =
        row.reliability === 'high'
          ? chalk.green(row.reliability)
          : row.reliability === 'medium'
          ? chalk.yellow(row.reliability)
          : chalk.red(row.reliability);
      const sources = row.sources.length > 0 ? row.sources.join(', ') : 'n/a';
      console.log(`  ${row.dimension.padEnd(11, ' ')} ${availability.padEnd?.(3, ' ') ?? availability}  ${reliability}  ${sources}`);
      console.log(chalk.dim(`      ${row.notes}`));
    });

    console.log('');
    console.log(chalk.bold('  Feasible Scope'));
    report.feasibleScope.forEach((item) => {
      console.log(chalk.dim('  - ') + item);
    });

    for (const dimension of report.dimensions) {
      console.log('');
      this.renderNoiseDimension(dimension);
    }

    if (report.git && report.git.files.length > 0) {
      const attributedDiffFiles = report.git.files.filter((file) => file.attributed === true);
      const hiddenDiffFiles = report.git.files.length - attributedDiffFiles.length;
      console.log('');
      console.log(chalk.bold('  Current Diff'));
      if (attributedDiffFiles.length === 0) {
        console.log(chalk.dim('  - No agent-attributed diff files were found in the current working tree.'));
      } else {
        attributedDiffFiles.slice(0, 8).forEach((file) => {
          const status = this.colorizeNoiseStatus(file.generatedLike ? 'watch' : 'ok', file.status);
          const lineText =
            file.addedLines === null && file.deletedLines === null
              ? 'n/a'
              : `+${file.addedLines ?? 0} -${file.deletedLines ?? 0}`;
          console.log(
            `  ${status.padEnd?.(10, ' ') ?? status} ${this.truncateBlockName(file.path, 54).padEnd(54, ' ')} ${lineText.padStart(12, ' ')}`
          );
        });
      }
      if (hiddenDiffFiles > 0) {
        console.log(chalk.dim(`  - ${hiddenDiffFiles} non-attributed file(s) hidden from Current Diff.`));
      }
    }

    if (report.fileHotspots.length > 0) {
      console.log('');
      console.log(chalk.bold('  File Hotspots'));
      report.fileHotspots.slice(0, 8).forEach((hotspot) => {
        console.log(
          `  ${this.truncateBlockName(hotspot.path, 52).padEnd(52, ' ')} ${String(hotspot.reads).padStart(4, ' ')} reads ${String(
            hotspot.duplicateReads
          ).padStart(4, ' ')} dup ${this.formatTokenNumber(hotspot.tokens).padStart(8, ' ')} tok`
        );
      });
    }

    if (report.nextActions.length > 0) {
      console.log('');
      console.log(chalk.bold('  Next Actions'));
      report.nextActions.forEach((action) => {
        console.log(chalk.dim('  - ') + action);
      });
    }

    if (report.warnings.length > 0) {
      console.log('');
      console.log(chalk.bold('  Warnings'));
      report.warnings.forEach((warning) => {
        console.log(chalk.dim('  - ') + chalk.yellow(warning));
      });
    }
  }

  private renderNoiseDimension(dimension: NoiseDimensionReport): void {
    const title = `${dimension.label} | ${dimension.status.toUpperCase()} | confidence ${dimension.confidence}`;
    console.log(chalk.bold(`  ${title}`));
    console.log(chalk.dim(`  ${dimension.summary}`));

    if (dimension.metrics.length > 0) {
      console.log(chalk.bold('  Metrics'));
      dimension.metrics.forEach((metric) => {
        const status = this.colorizeNoiseStatus(metric.status, metric.status.toUpperCase());
        console.log(`  ${status.padEnd?.(8, ' ') ?? status} ${metric.label.padEnd(28, ' ')} ${metric.value}`);
        console.log(chalk.dim(`      ${metric.summary} [${metric.trust}]`));
        if (metric.missingEvidence.length > 0) {
          console.log(chalk.dim(`      missing: ${metric.missingEvidence.join(', ')}`));
        }
      });
    }

    if (dimension.observedFacts.length > 0) {
      console.log(chalk.bold('  Observed Facts'));
      dimension.observedFacts.forEach((fact) => {
        console.log(chalk.dim('  - ') + fact);
      });
    }

    if (dimension.derivedFeatures.length > 0) {
      console.log(chalk.bold('  Derived Features'));
      dimension.derivedFeatures.forEach((feature) => {
        console.log(chalk.dim('  - ') + feature);
      });
    }

    if (dimension.semanticJudgments.length > 0) {
      console.log(chalk.bold('  Semantic Judgments'));
      dimension.semanticJudgments.forEach((item) => {
        console.log(chalk.dim('  - ') + item);
      });
    }

    if (dimension.signals.length > 0) {
      console.log(chalk.bold(`  Top Signals (${Math.min(4, dimension.signals.length)})`));
      dimension.signals.slice(0, 4).forEach((signal) => {
        const status = this.colorizeNoiseStatus(signal.status, signal.status.toUpperCase());
        console.log(
          `  ${status.padEnd?.(8, ' ') ?? status} ${this.truncateBlockName(signal.target || '(unknown)', 48).padEnd(48, ' ')} ${this.formatTokenNumber(
            signal.tokenImpact
          ).padStart(8, ' ')} tok`
        );
        console.log(chalk.dim(`      ${signal.summary}`));
      });
    }
  }

  private renderCoverageGrade(grade: NoiseEvaluationReport['coverageGrade']): string {
    if (grade === 'A') {
      return chalk.green(grade);
    }
    if (grade === 'B') {
      return chalk.yellow(grade);
    }
    return chalk.red(grade);
  }

  private colorizeNoiseStatus(status: 'ok' | 'watch' | 'high' | 'na', label: string): string {
    if (status === 'ok') {
      return chalk.green(label);
    }
    if (status === 'watch') {
      return chalk.yellow(label);
    }
    if (status === 'high') {
      return chalk.red(label);
    }
    return chalk.gray(label);
  }

  private async analyzeTodoGranularity(args: string[]): Promise<void> {
    const request = this.parseTokenScanRequest(args);
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start(`Analyzing ${request.source} todo granularity against context usage...`);
    } else {
      this.uiRenderer.renderInfo(`Analyzing ${request.source} todo granularity against context usage...`);
    }

    try {
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Todo granularity analysis completed');
        } else {
          this.uiRenderer.renderSuccess('Todo granularity analysis completed');
        }
        this.uiRenderer.renderWarning(`No ${target.source} session JSONL files found for todo analysis`);
        this.recordCommandData(
          'todo_granularity',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const todosRoot = target.source === 'claude' ? await this.resolveClaudeDataDirectory('todos') : null;
      const analyzer = new TodoGranularityAnalyzer({ todosRoot });
      const analysis = await analyzer.analyze(
        target.filePaths.map((filePath) => ({
          sessionId: path.basename(filePath, path.extname(filePath)),
          filePath,
          source: target.source,
        }))
      );

      if (spinner) {
        spinner.stop('Todo granularity analysis completed');
      } else {
        this.uiRenderer.renderSuccess('Todo granularity analysis completed');
      }

      await this.renderTodoGranularityAnalysis(target, analysis);
      this.recordCommandData(
        'todo_granularity',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `jsonlFiles=${target.filePaths.length}`,
          `sessionsScanned=${analysis.sessionsScanned}`,
          `sessionsWithTodos=${analysis.sessionsWithTodos}`,
          `todoFilesFound=${analysis.todoFilesFound}`,
          `todos=${analysis.items.length}`,
          `todosWithContext=${analysis.todosWithContext}`,
          `pearsonR=${analysis.pearsonR === null ? 'n/a' : analysis.pearsonR.toFixed(3)}`,
          `correlation=${analysis.correlationLabel}`,
          `suggestions=${analysis.suggestions.length}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to analyze todo granularity';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('todo_granularity', `failed: ${message}`);
    }
  }

  private async renderTodoGranularityAnalysis(target: TokenScanTarget, analysis: TodoGranularityAnalysis): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(TodoGranularityScreen, {
          scopeLabel: target.scopeLabel,
          sourceLabel: target.sourceLabel,
          selectedSource: target.source,
          analysis,
        })
      );
      return;
    } catch {
      this.renderTodoGranularityAnalysisFallback(target, analysis);
    }
  }

  private renderTodoGranularityAnalysisFallback(target: TokenScanTarget, analysis: TodoGranularityAnalysis): void {
    const headerLines = [
      `Command: /todo_granularity ${target.source}`,
      `Scope: ${target.scopeLabel}`,
      `Source: ${target.sourceLabel}`,
      `Sessions scanned: ${analysis.sessionsScanned}`,
      `Sessions with todos: ${analysis.sessionsWithTodos}`,
      `Todo files found: ${analysis.todoFilesFound}`,
      `Fallback sessions: ${analysis.sessionsUsingSnapshotFallback}`,
      `Todos analyzed: ${analysis.items.length}`,
      `Todos with context usage: ${analysis.todosWithContext}`,
    ];

    console.log(
      boxen(headerLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'gray',
        title: ' Todo Granularity ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Granularity Distribution'));
    if (analysis.items.length === 0) {
      console.log(chalk.dim('  - (no todo items found)'));
    } else {
      const maxCount = analysis.buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);
      analysis.buckets.forEach((bucket) => {
        const bar = this.renderTokenBar(bucket.count, Math.max(1, maxCount), chalk.cyan);
        const count = `${bucket.count}`.padStart(3, ' ');
        const share = `${Math.round(bucket.share * 100)}%`.padStart(4, ' ');
        console.log(`  ${bar} Score ${bucket.score}  ${count}  ${chalk.dim(share)}`);
      });
    }

    console.log('');
    console.log(chalk.bold('  Correlation'));
    if (analysis.pearsonR === null) {
      console.log(chalk.dim('  - Not enough samples to compute a Pearson correlation.'));
    } else {
      const correlationColor = analysis.pearsonR >= 0.4 ? chalk.yellow : analysis.pearsonR <= -0.4 ? chalk.green : chalk.gray;
      console.log(
        `  Pearson R = ${correlationColor(analysis.pearsonR.toFixed(2))}  ${chalk.dim(`(${analysis.correlationLabel})`)}`
      );
      if (analysis.pearsonR > 0.2) {
        console.log(chalk.dim('  - Coarser todos tend to correlate with higher average context usage.'));
      } else if (analysis.pearsonR < -0.2) {
        console.log(chalk.dim('  - Finer-grained todos are carrying more context than expected, so the naming and split strategy may need review.'));
      } else {
        console.log(chalk.dim('  - Granularity and context usage do not show a clear monotonic relationship right now.'));
      }
    }

    console.log('');
    console.log(chalk.bold('  Outcome By Score'));
    analysis.buckets.forEach((bucket) => {
      const truncation = bucket.truncationRate === null ? 'n/a' : `${(bucket.truncationRate * 100).toFixed(0)}%`;
      const completion = bucket.completionRate === null ? 'n/a' : `${(bucket.completionRate * 100).toFixed(0)}%`;
      const stuck = bucket.stuckRate === null ? 'n/a' : `${(bucket.stuckRate * 100).toFixed(0)}%`;
      console.log(
        `  Score ${bucket.score}  ${chalk.dim('trunc')} ${truncation.padStart(4, ' ')}  ${chalk.dim(
          'done'
        )} ${completion.padStart(4, ' ')}  ${chalk.dim('stuck')} ${stuck.padStart(4, ' ')}`
      );
    });

    console.log('');
    console.log(chalk.bold('  Split Suggestions'));
    if (analysis.suggestions.length === 0) {
      console.log(chalk.dim('  - No todo currently stands out as an obvious split candidate.'));
    } else {
      analysis.suggestions.forEach((suggestion, index) => {
        const tokenText =
          suggestion.contextTokens === null ? chalk.dim('context n/a') : chalk.dim(`${this.formatTokenNumber(suggestion.contextTokens)} tok`);
        console.log(
          `  ${index + 1}. ${chalk.white(suggestion.content)} ${chalk.dim(`[score ${suggestion.granularityScore}]`)} ${tokenText}`
        );
        console.log(`     ${chalk.dim('reason:')} ${suggestion.reason}`);
        console.log(`     ${chalk.dim('split:')} ${suggestion.splitHint}`);
      });
    }

    if (analysis.warnings.length > 0) {
      console.log('');
      console.log(chalk.bold('  Notes'));
      analysis.warnings.forEach((warning) => {
        console.log(chalk.dim('  - ') + chalk.yellow(warning));
      });
    }
  }

  private buildSuggestionsFromLlmPrompt(
    promptScan: any,
    tokenScan: any,
    contextHealth: any
  ): string {
    return [
      'You are a senior prompt-engineering and context-optimization advisor reviewing a Claude / Agent workflow.',
      'Base your judgment strictly on the scan summaries below. Do not invent facts. If evidence is insufficient, say so explicitly.',
      'Goal: combine the outputs of /scan_prompt, /scan_tokens, and /context_health, then identify what in the current project most needs to be changed or tuned.',
      '',
      'Respond in English using this structure, and keep the conclusions concrete and actionable:',
      '1. Overall assessment: 2-4 sentences summarizing the current state and the main risks.',
      '2. High-priority adjustments: 3-5 items, each with [Problem] [Evidence] [Recommended action].',
      '3. Suggested change list: group recommendations under [Prompt / Rules] [Docs / Reference] [Context / Token].',
      '4. Missing information or uncertainty: if any area lacks evidence, explain what additional data is needed.',
      '',
      '[scan_prompt summary]',
      promptScan.commandData,
      '',
      '[scan_tokens summary]',
      tokenScan.commandData,
      '',
      '[context_health summary]',
      contextHealth.commandData,
    ].join('\n');
  }

  private renderSuggestionsFromLlm(reply: { content: string }): void {
    console.log(
      boxen(reply.content.trim() || '(empty response)', {
        borderStyle: 'round',
        borderColor: 'magenta',
        title: ' LLM Suggestions ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );
  }

  private async collectContextUsageRecords(
    filePaths: string[],
    source: TokenScanSource
  ): Promise<ContextUsageRecord[]> {
    const collected: ContextUsageRecord[] = [];

    for (const filePath of filePaths) {
      let raw = '';
      let fileTimestampMs = 0;
      try {
        raw = await fs.readFile(filePath, 'utf8');
        const stat = await fs.stat(filePath);
        fileTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        continue;
      }

      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const codexDefaults = source === 'codex' ? this.readCodexUsageDefaults(lines) : null;
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }

        const candidate = this.extractContextUsageRecord(parsed, filePath, fileTimestampMs, source, codexDefaults);
        if (candidate) {
          collected.push(candidate);
        }
      }
    }

    return collected.sort((a, b) => b.timestampMs - a.timestampMs);
  }

  private async findRecentContextUsageRecords(
    filePaths: string[],
    maxRecords: number,
    source: TokenScanSource
  ): Promise<ContextUsageRecord[]> {
    if (maxRecords <= 0) {
      return [];
    }

    const collected: ContextUsageRecord[] = [];
    for (const filePath of filePaths) {
      let raw = '';
      let fileTimestampMs = 0;
      try {
        raw = await fs.readFile(filePath, 'utf8');
        const stat = await fs.stat(filePath);
        fileTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        continue;
      }

      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const codexDefaults = source === 'codex' ? this.readCodexUsageDefaults(lines) : null;
      let perFileCount = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (perFileCount >= CommandHandler.CONTEXT_HEALTH_MAX_RECORDS_PER_FILE) {
          break;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(lines[i]) as unknown;
        } catch {
          continue;
        }

        const candidate = this.extractContextUsageRecord(parsed, filePath, fileTimestampMs, source, codexDefaults);
        if (!candidate) {
          continue;
        }

        collected.push(candidate);
        perFileCount += 1;
      }
    }

    return collected
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, maxRecords);
  }

  private readCodexUsageDefaults(lines: string[]): { model: string; contextWindowTokens: number | null } {
    let model = 'unknown';
    let contextWindowTokens: number | null = null;

    for (const line of lines.slice(0, 80)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      model = this.getStringAtPaths(parsed, [['payload', 'model'], ['payload', 'model_name']]) ?? model;
      contextWindowTokens =
        this.getNumberAtPaths(parsed, [['payload', 'model_context_window'], ['payload', 'info', 'model_context_window']]) ??
        contextWindowTokens;
    }

    return { model, contextWindowTokens };
  }

  private extractContextUsageRecord(
    payload: unknown,
    filePath: string,
    fileTimestampMs: number,
    source: TokenScanSource,
    defaults?: { model: string; contextWindowTokens: number | null } | null
  ): ContextUsageRecord | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (source === 'codex') {
      const topType = this.getStringAtPaths(payload, [['type']])?.toLowerCase() ?? '';
      const payloadType = this.getStringAtPaths(payload, [['payload', 'type']])?.toLowerCase() ?? '';
      if (topType !== 'event_msg' || payloadType !== 'token_count') {
        return null;
      }

      const usageObject = this.getObjectAtPath(payload, ['payload', 'info', 'last_token_usage']);
      if (!usageObject) {
        return null;
      }

      const inputTokens = this.getNumberAtPaths(usageObject, [['input_tokens']]) ?? 0;
      const outputTokens = this.sumNumbers([
        this.getNumberAtPaths(usageObject, [['output_tokens']]),
        this.getNumberAtPaths(usageObject, [['reasoning_output_tokens']]),
      ]);
      const cacheReadTokens =
        this.getNumberAtPaths(usageObject, [['cached_input_tokens'], ['cache_read_input_tokens'], ['cacheReadInputTokens']]) ?? 0;
      const totalTokens =
        this.getNumberAtPaths(usageObject, [['total_tokens']]) ??
        Math.max(0, inputTokens + outputTokens + cacheReadTokens);
      const contextWindowTokens =
        this.getNumberAtPaths(payload, [['payload', 'info', 'model_context_window'], ['payload', 'model_context_window']]) ??
        defaults?.contextWindowTokens ??
        null;
      const hasUsage = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || totalTokens > 0;
      if (!hasUsage && contextWindowTokens === null) {
        return null;
      }

      const timestampMs = this.extractTokenTimestampMs(payload) || fileTimestampMs;
      return {
        timestampMs,
        timestampLabel: timestampMs > 0 ? new Date(timestampMs).toLocaleString() : 'unknown',
        filePath,
        model: defaults?.model ?? 'unknown',
        contextUsedPercent: null,
        contextWindowTokens: contextWindowTokens === null ? null : Math.max(1, Math.round(contextWindowTokens)),
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens,
        totalTokens,
      };
    }

    const usageObject =
      this.getObjectAtPath(payload, ['message', 'usage']) ??
      this.getObjectAtPath(payload, ['usage']) ??
      this.getObjectAtPath(payload, ['response', 'usage']);

    const inputTokens = this.getNumberAtPaths(usageObject, [['input_tokens'], ['inputTokens']]) ?? 0;
    const outputTokens = this.sumNumbers([
      this.getNumberAtPaths(usageObject, [['output_tokens'], ['outputTokens']]),
      this.getNumberAtPaths(usageObject, [['reasoning_output_tokens'], ['reasoningOutputTokens']]),
    ]);
    const cacheCreationTokens =
      this.getNumberAtPaths(usageObject, [['cache_creation_input_tokens'], ['cacheCreationInputTokens']]) ?? 0;
    const cacheReadTokens =
      this.getNumberAtPaths(usageObject, [['cache_read_input_tokens'], ['cacheReadInputTokens']]) ?? 0;
    const totalTokens =
      this.getNumberAtPaths(usageObject, [['total_tokens'], ['totalTokens']]) ??
      Math.max(0, inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens);

    const contextUsedPercent =
      this.getNumberAtPaths(payload, [
        ['stdin', 'context_window', 'used_percentage'],
        ['context_window', 'used_percentage'],
        ['contextWindow', 'usedPercentage'],
      ]) ?? null;

    const contextWindowTokens =
      this.getNumberAtPaths(payload, [
        ['stdin', 'context_window', 'max_tokens'],
        ['stdin', 'context_window', 'context_window_size'],
        ['context_window', 'max_tokens'],
        ['context_window', 'context_window_size'],
        ['contextWindow', 'maxTokens'],
        ['contextWindow', 'contextWindowSize'],
      ]) ?? null;

    const hasUsage = inputTokens > 0 || outputTokens > 0 || cacheCreationTokens > 0 || cacheReadTokens > 0 || totalTokens > 0;
    const hasContextPercent = contextUsedPercent !== null;
    if (!hasUsage && !hasContextPercent) {
      return null;
    }

    const timestampMsFromPayload = this.extractTokenTimestampMs(payload);
    const timestampMs = timestampMsFromPayload > 0 ? timestampMsFromPayload : fileTimestampMs;
    const timestampLabel = timestampMs > 0 ? new Date(timestampMs).toLocaleString() : 'unknown';

    const model =
      this.getStringAtPaths(payload, [['message', 'model'], ['model'], ['response', 'model']]) ??
      this.getStringAtPaths(payload, [['version']]) ??
      'unknown';

    return {
      timestampMs,
      timestampLabel,
      filePath,
      model,
      contextUsedPercent: contextUsedPercent === null ? null : Math.max(0, Math.min(100, contextUsedPercent)),
      contextWindowTokens: contextWindowTokens === null ? null : Math.max(1, Math.round(contextWindowTokens)),
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens,
    };
  }

  private buildContextHealthSnapshot(records: ContextUsageRecord[]): ContextHealthSnapshot {
    const metricsByRecord = records.map((record) => ({
      record,
      metrics: this.calculateContextUsageMetrics(record),
    }));
    const latestPair = metricsByRecord[0];
    const latestRecord = latestPair.record;
    const latestMetrics = latestPair.metrics;
    const latestComparableKey = this.buildContextUsageComparableKey(latestRecord, latestMetrics);
    const comparablePairs =
      latestComparableKey === null
        ? [latestPair]
        : metricsByRecord.filter(
            ({ record, metrics }) => this.buildContextUsageComparableKey(record, metrics) === latestComparableKey
          );
    const comparableMetricsWindow = comparablePairs.slice(0, 3).map((item) => item.metrics);
    const smoothedEffectivePercent =
      comparableMetricsWindow.length > 0
        ? comparableMetricsWindow.reduce((sum, item) => sum + item.effectivePercent, 0) / comparableMetricsWindow.length
        : latestMetrics.effectivePercent;
    const trendDeltaPercent =
      comparableMetricsWindow.length > 1
        ? latestMetrics.effectivePercent - comparableMetricsWindow[1].effectivePercent
        : null;
    const knownModels = new Set(
      records.map((record) => this.normalizeContextHealthModel(record.model)).filter((model) => model !== 'unknown')
    );
    const windowValues = new Set(metricsByRecord.map(({ metrics }) => metrics.contextWindowTokens));
    const nativeSampleCount = metricsByRecord.filter(({ metrics }) => metrics.source === 'native').length;
    const explicitWindowSampleCount = metricsByRecord.filter(({ metrics }) => metrics.windowSource === 'explicit').length;

    // Use both immediate and smoothed values to reduce one-off spikes, but only across comparable samples.
    const levelSignal =
      comparableMetricsWindow.length >= 2
        ? Math.max(latestMetrics.effectivePercent, smoothedEffectivePercent)
        : latestMetrics.effectivePercent;
    const levelOutcome = this.resolveContextHealthLevel(levelSignal);
    const confidenceOutcome = this.resolveContextHealthConfidence(
      latestRecord,
      latestMetrics,
      records.length,
      comparablePairs.length,
      knownModels.size > 1,
      windowValues.size > 1
    );

    return {
      level: levelOutcome.level,
      levelReason: levelOutcome.levelReason,
      confidence: confidenceOutcome.confidence,
      confidenceReason: confidenceOutcome.reason,
      source: latestMetrics.source,
      windowSource: latestMetrics.windowSource,
      model: latestRecord.model,
      rawPercent: latestMetrics.rawPercent,
      usageDerivedPercent: latestMetrics.usageDerivedPercent,
      nativePercent: latestMetrics.nativePercent,
      percentDrift: latestMetrics.percentDrift,
      effectivePercent: latestMetrics.effectivePercent,
      smoothedEffectivePercent,
      trendDeltaPercent,
      dataPoints: records.length,
      comparableDataPoints: comparablePairs.length,
      nativeSampleCount,
      calculatedSampleCount: records.length - nativeSampleCount,
      explicitWindowSampleCount,
      estimatedWindowSampleCount: records.length - explicitWindowSampleCount,
      mixedModels: knownModels.size > 1,
      mixedContextWindows: windowValues.size > 1,
      usedTokens: latestMetrics.usedTokens,
      contextWindowTokens: latestMetrics.contextWindowTokens,
      usableContextTokens: latestMetrics.usableContextTokens,
      autocompactBufferTokens: latestMetrics.autocompactBufferTokens,
      inputTokens: latestRecord.inputTokens,
      cacheCreationTokens: latestRecord.cacheCreationTokens,
      cacheReadTokens: latestRecord.cacheReadTokens,
      timestampMs: latestRecord.timestampMs,
      timestampLabel: latestRecord.timestampLabel,
      filePath: latestRecord.filePath,
    };
  }

  private calculateContextUsageMetrics(record: ContextUsageRecord): ContextUsageMetrics {
    const estimatedWindow = this.estimateContextWindowTokens(record.model);
    const contextWindowTokens = record.contextWindowTokens ?? estimatedWindow;
    const autocompactBufferTokens = Math.round(contextWindowTokens * CommandHandler.AUTOCOMPACT_BUFFER_RATIO);
    const usableContextTokens = Math.max(1, contextWindowTokens - autocompactBufferTokens);

    const usageTokens = Math.max(0, record.inputTokens + record.cacheCreationTokens + record.cacheReadTokens);
    const rawPercentFromUsage = contextWindowTokens > 0 ? (usageTokens / contextWindowTokens) * 100 : 0;
    const rawPercentFromNative =
      record.contextUsedPercent !== null ? Math.max(0, Math.min(100, record.contextUsedPercent)) : null;
    const rawPercent = rawPercentFromNative ?? rawPercentFromUsage;

    const usedTokensFromNative =
      rawPercentFromNative !== null ? Math.round((rawPercentFromNative / 100) * contextWindowTokens) : null;
    let usedTokens = usedTokensFromNative ?? usageTokens;

    if (usedTokens <= 0 && rawPercent > 0) {
      usedTokens = Math.round((rawPercent / 100) * contextWindowTokens);
    }

    const effectivePercent = Math.max(0, Math.min(100, (usedTokens / usableContextTokens) * 100));
    return {
      source: rawPercentFromNative !== null ? 'native' : 'calculated',
      rawPercent,
      effectivePercent,
      usedTokens,
      usageTokens,
      usageDerivedPercent: rawPercentFromUsage,
      nativePercent: rawPercentFromNative,
      percentDrift:
        rawPercentFromNative !== null ? Math.abs(rawPercentFromNative - rawPercentFromUsage) : null,
      windowSource: record.contextWindowTokens !== null ? 'explicit' : 'estimated',
      contextWindowTokens,
      usableContextTokens,
      autocompactBufferTokens,
    };
  }

  private resolveContextHealthConfidence(
    latestRecord: ContextUsageRecord,
    latestMetrics: ContextUsageMetrics,
    sampleCount: number,
    comparableSampleCount: number,
    mixedModels: boolean,
    mixedContextWindows: boolean
  ): { confidence: ContextHealthConfidence; reason: string } {
    let score = 0;
    const reasons: string[] = [];

    if (latestMetrics.source === 'native') {
      score += 2;
      reasons.push('native context usage available');
    } else {
      reasons.push('derived from usage tokens only');
    }

    if (latestRecord.contextWindowTokens !== null) {
      score += 1;
      reasons.push('explicit context window in record');
    } else {
      reasons.push(`context window estimated (${this.formatTokenNumber(latestMetrics.contextWindowTokens)} tokens)`);
    }

    if (comparableSampleCount >= 3) {
      score += 1;
      reasons.push(`trend based on ${comparableSampleCount} comparable samples`);
    } else if (comparableSampleCount === 2) {
      score += 0;
      reasons.push('limited comparable trend history');
    } else if (sampleCount > 1) {
      reasons.push('recent samples are not directly comparable for trend');
    } else {
      score -= 1;
      reasons.push('single-sample snapshot');
    }

    if (latestRecord.model && latestRecord.model !== 'unknown') {
      score += 1;
    } else {
      score -= 1;
      reasons.push('model not identified');
    }

    if (mixedModels) {
      score -= 1;
      reasons.push('recent samples mix multiple models');
    }

    if (mixedContextWindows) {
      score -= 1;
      reasons.push('recent samples mix multiple context windows');
    }

    if (latestMetrics.percentDrift !== null) {
      if (latestMetrics.percentDrift >= 15) {
        score -= 2;
        reasons.push(`native vs usage-token estimate diverges by ${latestMetrics.percentDrift.toFixed(1)} pts`);
      } else if (latestMetrics.percentDrift >= 5) {
        score -= 1;
        reasons.push(`native vs usage-token estimate drifts by ${latestMetrics.percentDrift.toFixed(1)} pts`);
      } else {
        reasons.push('native and usage-token estimates are aligned');
      }
    }

    const nowMs = Date.now();
    const ageMs = Math.max(0, nowMs - latestRecord.timestampMs);
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 24) {
      score -= 1;
      reasons.push(`latest sample is stale (${ageHours.toFixed(1)}h old)`);
    }

    const confidence: ContextHealthConfidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
    return { confidence, reason: reasons.join('; ') };
  }

  private buildContextUsageComparableKey(record: ContextUsageRecord, metrics: ContextUsageMetrics): string | null {
    const modelKey = this.normalizeContextHealthModel(record.model);
    if (modelKey === 'unknown') {
      return null;
    }

    return `${modelKey}::${metrics.contextWindowTokens}`;
  }

  private normalizeContextHealthModel(model: string): string {
    const normalized = model.trim().toLowerCase();
    return normalized || 'unknown';
  }

  private resolveContextHealthLevel(effectivePercent: number): { level: ContextHealthLevel; levelReason: string } {
    if (!Number.isFinite(effectivePercent) || effectivePercent < 0) {
      return { level: 'unknown', levelReason: 'invalid context metrics' };
    }

    if (effectivePercent >= CommandHandler.CONTEXT_HEALTH_CRITICAL_PERCENT) {
      return { level: 'critical', levelReason: 'close to context saturation' };
    }

    if (effectivePercent >= CommandHandler.CONTEXT_HEALTH_WARNING_PERCENT) {
      return { level: 'elevated', levelReason: 'context pressure is increasing' };
    }

    return { level: 'healthy', levelReason: 'context usage is in a safe range' };
  }

  private async renderContextHealthSnapshot(target: TokenScanTarget, snapshot: ContextHealthSnapshot): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(ContextHealthScreen, {
          scopeLabel: target.scopeLabel,
          sourceLabel: target.sourceLabel,
          selectedSource: target.source,
          snapshot,
        })
      );
      return;
    } catch {
      this.renderContextHealthSnapshotFallback(target, snapshot);
    }
  }

  private renderContextHealthSnapshotFallback(target: TokenScanTarget, snapshot: ContextHealthSnapshot): void {
    const levelText =
      snapshot.level === 'critical'
        ? chalk.red('CRITICAL')
        : snapshot.level === 'elevated'
        ? chalk.yellow('ELEVATED')
        : snapshot.level === 'healthy'
        ? chalk.green('HEALTHY')
        : chalk.gray('UNKNOWN');
    const confidenceText =
      snapshot.confidence === 'high'
        ? chalk.green('HIGH')
        : snapshot.confidence === 'medium'
        ? chalk.yellow('MEDIUM')
        : chalk.red('LOW');

    const rawBar = this.renderPercentBar(snapshot.rawPercent, chalk.blue);
    const usageEstimateBar = this.renderPercentBar(snapshot.usageDerivedPercent, chalk.magenta);
    const effectiveBar = this.renderPercentBar(snapshot.effectivePercent, this.colorizeLevel(snapshot.level));
    const smoothedBar = this.renderPercentBar(snapshot.smoothedEffectivePercent, this.colorizeLevel(snapshot.level));
    const fileLabel = this.truncateBlockName(snapshot.filePath, 88);
    const smoothedText =
      snapshot.comparableDataPoints >= 2
        ? `${smoothedBar} ${snapshot.smoothedEffectivePercent.toFixed(1)}%`
        : chalk.dim('n/a (need >=2 comparable samples)');
    const driftText =
      snapshot.percentDrift === null
        ? chalk.dim('n/a')
        : snapshot.percentDrift >= 15
        ? chalk.red(`${snapshot.percentDrift.toFixed(1)} pts`)
        : snapshot.percentDrift >= 5
        ? chalk.yellow(`${snapshot.percentDrift.toFixed(1)} pts`)
        : chalk.green(`${snapshot.percentDrift.toFixed(1)} pts`);
    const trendText =
      snapshot.trendDeltaPercent === null
        ? snapshot.dataPoints > 1 && snapshot.comparableDataPoints < 2
          ? chalk.dim('n/a (recent samples mix models or windows)')
          : chalk.dim('n/a (need >=2 comparable samples)')
        : snapshot.trendDeltaPercent > 0
        ? chalk.red(`+${snapshot.trendDeltaPercent.toFixed(1)}% vs previous`)
        : snapshot.trendDeltaPercent < 0
        ? chalk.green(`${snapshot.trendDeltaPercent.toFixed(1)}% vs previous`)
        : chalk.dim('0.0% vs previous');

    const lines: string[] = [
      `Command: /context_health ${target.source}`,
      `Scope: ${target.scopeLabel}`,
      `Status: ${levelText} (${snapshot.levelReason})`,
      `Confidence: ${confidenceText} (${snapshot.confidenceReason})`,
      `Samples: ${snapshot.dataPoints} total / ${snapshot.comparableDataPoints} comparable`,
      `Coverage: native ${snapshot.nativeSampleCount}, calculated ${snapshot.calculatedSampleCount}, explicit window ${snapshot.explicitWindowSampleCount}, estimated ${snapshot.estimatedWindowSampleCount}`,
      `Mixing: models ${snapshot.mixedModels ? 'mixed' : 'stable'}, windows ${snapshot.mixedContextWindows ? 'mixed' : 'stable'}`,
      `Model: ${snapshot.model}`,
      `Source: ${snapshot.source === 'native' ? 'native context_window.used_percentage' : 'calculated from usage tokens'}`,
      `Observed at: ${snapshot.timestampLabel}`,
      `Raw usage:      ${rawBar} ${snapshot.rawPercent.toFixed(1)}%`,
      `Usage est.:    ${usageEstimateBar} ${snapshot.usageDerivedPercent.toFixed(1)}%`,
      `Source drift: ${driftText}`,
      `Buffered usage: ${effectiveBar} ${snapshot.effectivePercent.toFixed(1)}%`,
      `Smoothed(3):    ${smoothedText}`,
      `Trend: ${trendText}`,
      `Tokens: ${this.formatTokenNumber(snapshot.usedTokens)} used / ${this.formatTokenNumber(snapshot.contextWindowTokens)} window`,
      `Buffer reserve: ${this.formatTokenNumber(snapshot.autocompactBufferTokens)} tokens (${Math.round(
        CommandHandler.AUTOCOMPACT_BUFFER_RATIO * 100
      )}%)`,
      `Breakdown: input ${this.formatTokenNumber(snapshot.inputTokens)}, cache_create ${this.formatTokenNumber(
        snapshot.cacheCreationTokens
      )}, cache_read ${this.formatTokenNumber(snapshot.cacheReadTokens)}`,
      `Record file: ${fileLabel}`,
    ];

    console.log(
      boxen(lines.join('\n'), {
        borderStyle: 'round',
        borderColor: snapshot.level === 'critical' ? 'red' : snapshot.level === 'elevated' ? 'yellow' : 'gray',
        title: ' Context Health ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    const suggestions = this.getContextHealthSuggestions(snapshot);
    if (suggestions.length > 0) {
      console.log('');
      console.log(chalk.bold('  Recommendations'));
      suggestions.forEach((suggestion) => {
        console.log(chalk.dim('  - ') + suggestion);
      });
    }
  }

  private async buildPromptCoverageSummary(analysis: ContextNoiseAnalysis): Promise<PromptCoverageSummary> {
    const rootPath = path.resolve(process.cwd());
    const promptScan = await this.promptAssetScanner.scan(rootPath);
    const skillScan = await this.skillScanner.scan(rootPath);

    const assetMap = new Map<string, PromptCoverageItem>();
    for (const file of promptScan.files) {
      const fullPath = path.resolve(rootPath, file.relativePath);
      const relativePath = this.normalizeRelativePath(path.relative(rootPath, fullPath));
      const content = await this.safeReadText(fullPath);
      assetMap.set(relativePath.toLowerCase(), {
        relativePath,
        fullPath,
        kind: 'prompt',
        label: file.categories.join(', '),
        tokenCount: file.tokenCount,
        summary: this.summarizeAssetText(content, relativePath),
        headings: this.extractMarkdownHeadings(content).slice(0, 4),
        read: false,
        readTokens: 0,
        wasReferencedLater: false,
      });
    }

    for (const skill of skillScan.skills) {
      const fullPath = path.resolve(rootPath, skill.skillFileRelativePath);
      const relativePath = this.normalizeRelativePath(path.relative(rootPath, fullPath));
      if (assetMap.has(relativePath.toLowerCase())) {
        continue;
      }
      const content = await this.safeReadText(fullPath);
      assetMap.set(relativePath.toLowerCase(), {
        relativePath,
        fullPath,
        kind: 'skill',
        label: 'skill',
        tokenCount: skill.instructionTokenEstimate,
        summary: skill.purpose || this.summarizeAssetText(content, relativePath),
        headings: skill.headings.slice(0, 4),
        read: false,
        readTokens: 0,
        wasReferencedLater: false,
      });
    }

    const bestReadByAsset = new Map<string, ContextNoiseReadRecord>();
    for (const record of analysis.readRecords) {
      const candidatePaths = [
        path.resolve(rootPath, record.path),
        record.cwd ? path.resolve(record.cwd, record.path) : '',
        path.resolve(record.path),
      ]
        .filter(Boolean)
        .map((candidate) => this.normalizeRelativePath(path.relative(rootPath, candidate)).toLowerCase())
        .filter((candidate) => candidate && !candidate.startsWith('..'));

      const matchedKey = candidatePaths.find((candidate) => assetMap.has(candidate));
      if (!matchedKey) {
        continue;
      }
      const asset = assetMap.get(matchedKey);
      if (!asset) {
        continue;
      }
      const previous = bestReadByAsset.get(matchedKey);
      if (!previous || record.tokenCount > previous.tokenCount) {
        bestReadByAsset.set(matchedKey, record);
      }
    }

    bestReadByAsset.forEach((record, relativePathKey) => {
      const asset = assetMap.get(relativePathKey);
      if (!asset) {
        return;
      }
      asset.read = true;
      asset.readTokens = record.tokenCount;
      asset.wasReferencedLater = record.wasReferencedLater;
      const extracted = this.summarizeToolReadContent(record.resultContent, asset.relativePath);
      if (extracted.summary) {
        asset.summary = extracted.summary;
      }
      if (extracted.headings.length > 0) {
        asset.headings = extracted.headings.slice(0, 4);
      }
    });

    const assets = Array.from(assetMap.values());
    const readAssets = assets
      .filter((asset) => asset.read)
      .sort((a, b) => b.readTokens - a.readTokens || a.relativePath.localeCompare(b.relativePath));
    const unreadAssets = assets
      .filter((asset) => !asset.read)
      .sort((a, b) => b.tokenCount - a.tokenCount || a.relativePath.localeCompare(b.relativePath));
    const highValueAssets = readAssets.filter((asset) => asset.wasReferencedLater);
    const signals: PromptCoverageSignal[] = [
      ...readAssets
        .filter((asset) => !asset.wasReferencedLater)
        .map((asset) => ({
          kind: 'read_only' as const,
          severity: asset.readTokens >= 1200 ? 'high' as const : asset.readTokens >= 500 ? 'medium' as const : 'low' as const,
          tokenImpact: asset.readTokens,
          reason: 'This asset was loaded into context but showed no clear downstream reuse.',
          asset,
        })),
      ...unreadAssets
        .filter((asset) => asset.tokenCount >= 500)
        .slice(0, 8)
        .map((asset) => ({
          kind: 'unused' as const,
          severity: asset.tokenCount >= 1200 ? 'medium' as const : 'low' as const,
          tokenImpact: asset.tokenCount,
          reason: 'This larger prompt or skill asset exists in the repo but was never touched in the scanned sessions.',
          asset,
        })),
      ...highValueAssets.slice(0, 6).map((asset) => ({
        kind: 'high_value' as const,
        severity: 'low' as const,
        tokenImpact: asset.readTokens,
        reason: 'This asset continued to influence later tool inputs or reasoning and appears to be high-value context.',
        asset,
      })),
    ]
      .sort((a, b) => b.tokenImpact - a.tokenImpact || a.asset.relativePath.localeCompare(b.asset.relativePath))
      .slice(0, 12);

    return {
      scannedAssets: assets.length,
      matchedReadCount: bestReadByAsset.size,
      scannedPromptFiles: promptScan.files.length,
      scannedSkills: skillScan.skills.length,
      readAssets,
      unreadAssets,
      highValueAssets,
      promptNoiseTokens: readAssets
        .filter((asset) => !asset.wasReferencedLater)
        .reduce((sum, asset) => sum + asset.readTokens, 0),
      signals,
    };
  }

  private renderContextNoiseAnalysis(target: TokenScanTarget, analysis: ContextNoiseAnalysis, coverage: PromptCoverageSummary): void {
    const noisyShare = analysis.totalEstimatedTokens > 0 ? analysis.totalNoiseTokens / analysis.totalEstimatedTokens : 0;
    const primarySession = analysis.primarySession;
    const noiseTokenLabel =
      noisyShare >= 0.3
        ? chalk.red(`${this.formatTokenNumber(analysis.totalNoiseTokens)} tok (${Math.round(noisyShare * 100)}%)`)
        : noisyShare >= 0.15
        ? chalk.yellow(`${this.formatTokenNumber(analysis.totalNoiseTokens)} tok (${Math.round(noisyShare * 100)}%)`)
        : chalk.green(`${this.formatTokenNumber(analysis.totalNoiseTokens)} tok (${Math.round(noisyShare * 100)}%)`);

    const metaLines: string[] = [
      `Scope: ${target.scopeLabel} (${target.sourceLabel})`,
      `Session: ${
        primarySession
          ? `${primarySession.sessionId} | ${primarySession.startTime} -> ${primarySession.endTime}`
          : 'n/a'
      }`,
      `Total tokens: ${this.formatTokenNumber(analysis.totalEstimatedTokens)} tok`,
      `Noise tokens: ${noiseTokenLabel}`,
      `Tool calls: ${this.formatTokenNumber(analysis.totalToolCalls)}`,
      `Duplicate calls: ${this.formatTokenNumber(analysis.duplicateCalls)}`,
      `Session file: ${primarySession ? this.truncateBlockName(primarySession.filePath, 92) : 'n/a'}`,
    ];

    console.log(
      boxen(metaLines.join('\n'), {
        borderStyle: 'round',
        borderColor: noisyShare >= 0.3 ? 'red' : noisyShare >= 0.15 ? 'yellow' : 'green',
        title: ' Context Noise ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Noise Categories'));
    analysis.categories.forEach((category) => {
      const colorize = this.getNoiseCategoryColor(category.key);
      const bar = this.renderPercentBar(Math.min(100, category.shareOfThreshold * 100), colorize);
      const header = `${category.tool} | ${category.label}`.padEnd(22, ' ');
      const countText = `${category.callCount}x`.padStart(5, ' ');
      const tokenText = `${this.formatTokenNumber(category.tokens)} tok`.padStart(12, ' ');
      console.log(`  ${colorize(header)} ${bar} ${countText} ${tokenText}`);
    });

    console.log('');
    console.log(chalk.bold(`  Recent Noise Events (${Math.min(8, analysis.events.length)})`));
    if (analysis.events.length === 0) {
      console.log(chalk.green('  - No obvious noise events were detected in the scanned sessions.'));
    } else {
      analysis.events.slice(0, 8).forEach((event) => {
        const tagText = this.renderNoiseTag(event.tag);
        const target = this.truncateBlockName(event.target || '(unknown target)', 48).padEnd(48, ' ');
        const tokenText = `${this.formatTokenNumber(event.tokens)} tok`.padStart(10, ' ');
        console.log(`  ${chalk.dim(`[${event.timestampLabel}]`)} ${event.tool.padEnd(4, ' ')} ${target} ${tokenText}  ${tagText}`);
        console.log(chalk.dim(`      ${event.reason}`));
      });
    }

    console.log('');
    console.log(chalk.bold('  File Read Hotspot'));
    if (analysis.fileHotspots.length === 0) {
      console.log(chalk.dim('  - No Read tool activity was detected.'));
    } else {
      analysis.fileHotspots.slice(0, 8).forEach((hotspot) => {
        const heat =
          hotspot.heat === 'high'
            ? chalk.red('hot')
            : hotspot.heat === 'medium'
            ? chalk.yellow('warm')
            : chalk.gray('cool');
        console.log(
          `  ${this.truncateBlockName(hotspot.path, 48).padEnd(48, ' ')} ${String(hotspot.totalReads).padStart(4, ' ')} reads ${String(
            hotspot.uniqueReads
          ).padStart(4, ' ')} unique ${String(hotspot.dupReads).padStart(4, ' ')} dup ${this.formatTokenNumber(
            hotspot.tokensConsumed
          ).padStart(8, ' ')} tok  ${heat}`
        );
      });
    }

    console.log('');
    console.log(chalk.bold('  Prompt Asset Signals'));
    console.log(
      chalk.dim(
        `  scanned prompt files ${coverage.scannedPromptFiles}, scanned skills ${coverage.scannedSkills}, matched reads ${coverage.matchedReadCount}`
      )
    );
    if (coverage.signals.length === 0) {
      console.log(chalk.dim('  - No prompt-asset signals were extracted.'));
    } else {
      coverage.signals.slice(0, 8).forEach((signal) => {
        const tone =
          signal.kind === 'high_value'
            ? chalk.green
            : signal.kind === 'read_only'
            ? chalk.yellow
            : chalk.gray;
        const label =
          signal.kind === 'high_value'
            ? 'used'
            : signal.kind === 'read_only'
            ? 'read-only'
            : 'unused';
        const asset = signal.asset;
        const tokenCount = signal.kind === 'unused' ? asset.tokenCount : asset.readTokens;
        console.log(
          `  ${tone(label.padEnd(9, ' '))} ${this.truncateBlockName(asset.relativePath, 46).padEnd(46, ' ')} ${this.formatTokenNumber(
            tokenCount
          ).padStart(8, ' ')} tok`
        );
        console.log(chalk.dim(`      ${signal.reason}`));
      });
    }

    console.log('');
    const footerText =
      noisyShare >= 0.3
        ? chalk.yellow(`  ! high noise | ${this.formatTokenNumber(analysis.totalNoiseTokens)} tok recoverable`)
        : chalk.green('  OK noise within acceptable range');
    console.log(footerText);

    const recommendations = this.buildContextNoiseRecommendations(analysis, coverage);
    if (recommendations.length > 0) {
      console.log('');
      console.log(chalk.bold('  Recommendations'));
      recommendations.forEach((recommendation) => {
        console.log(chalk.dim('  - ') + recommendation);
      });
    }

    if (analysis.warnings.length > 0) {
      console.log('');
      console.log(chalk.bold('  Warnings'));
      analysis.warnings.forEach((warning) => {
        console.log(chalk.dim('  - ') + chalk.yellow(warning));
      });
    }
  }

  private buildContextNoiseRecommendations(analysis: ContextNoiseAnalysis, coverage: PromptCoverageSummary): string[] {
    const recommendations: string[] = [];
    const topCategory = analysis.categories[0];
    const topEvent = analysis.events[0];
    const noisyShare = analysis.totalEstimatedTokens > 0 ? analysis.totalNoiseTokens / analysis.totalEstimatedTokens : 0;

    if (noisyShare >= 0.3) {
      recommendations.push(chalk.red('Recoverable noise is already high. Trim the biggest duplicate reads and repeated commands before the next long turn.'));
    } else if (noisyShare >= 0.15) {
      recommendations.push(chalk.yellow('Context quality is starting to drift. Prune repeated scans and read-only assets first.'));
    } else {
      recommendations.push(chalk.green('Noise is still manageable. Focus on preventing repeat reads, repeated Bash runs, and empty searches.'));
    }

    if (topCategory?.key === 'read_dup' || topCategory?.key === 'ctx_stale') {
      recommendations.push(chalk.yellow('Read-related noise dominates. Add a "summarize first, then read line ranges" rule to CLAUDE.md and reuse the latest valid read.'));
    } else if (topCategory?.key === 'bash_dup') {
      recommendations.push(chalk.yellow('Repeated Bash runs are expensive. Check whether the same command output is already in context before rerunning it.'));
    } else if (topCategory?.key === 'grep_miss') {
      recommendations.push(chalk.yellow('Grep misses are frequent. Confirm the path scope first, then narrow the pattern to avoid repeated empty searches.'));
    } else if (topCategory?.key === 'ls_redundant') {
      recommendations.push(chalk.yellow('Directory scans dominate. Start from narrower target folders instead of broad scans from the project root.'));
    }

    if (topEvent?.tag === 'bloat') {
      recommendations.push(chalk.red('Large but unused context is showing up in recent events. Replace whole-file reads or big outputs with summaries and excerpts.'));
    }

    if (coverage.readAssets.length === 0 && coverage.scannedAssets > 0) {
      recommendations.push(chalk.yellow('No prompt or skill assets were explicitly read. If they should shape behavior, make the retrieval step explicit.'));
    }
    if (coverage.promptNoiseTokens > 0) {
      recommendations.push(chalk.yellow('Some prompt assets were read but never reused. Separate always-on rules from on-demand assets.'));
    }
    if (coverage.unreadAssets.length > 0) {
      recommendations.push(chalk.yellow('Large unread assets still exist in the repo. Decide which ones belong in default context and which should stay outside the window.'));
    }

    return Array.from(new Set(recommendations)).slice(0, 4);
  }

  private async safeReadText(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private summarizeToolReadContent(content: string, filePath: string): { summary: string; headings: string[] } {
    const cleaned = content
      .replace(/^\s*\d+\s*(?:[:>|-]\s*)?/gm, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(/\r\n/g, '\n')
      .trim();
    return {
      summary: this.summarizeAssetText(cleaned, filePath),
      headings: this.extractMarkdownHeadings(cleaned),
    };
  }

  private summarizeAssetText(content: string, filePath: string): string {
    const cleaned = content.replace(/\r\n/g, '\n').trim();
    if (!cleaned) {
      return '';
    }

    const headings = this.extractMarkdownHeadings(cleaned);
    if (headings.length > 0) {
      const firstParagraph = this.extractFirstMeaningfulParagraph(cleaned);
      return firstParagraph ? `${headings[0]} - ${firstParagraph}` : headings[0];
    }

    const firstParagraph = this.extractFirstMeaningfulParagraph(cleaned);
    if (firstParagraph) {
      return firstParagraph;
    }

    const fileName = path.basename(filePath);
    return `Read ${fileName}`;
  }

  private extractMarkdownHeadings(content: string): string[] {
    const headings: string[] = [];
    const seen = new Set<string>();
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
      if (!match) {
        continue;
      }
      const heading = match[1].replace(/[`*_]/g, '').trim();
      if (!heading || seen.has(heading)) {
        continue;
      }
      seen.add(heading);
      headings.push(heading);
      if (headings.length >= 6) {
        break;
      }
    }
    return headings;
  }

  private extractFirstMeaningfulParagraph(content: string): string {
    const lines = content.split(/\r?\n/);
    const paragraph: string[] = [];
    let insideFence = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('```')) {
        insideFence = !insideFence;
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }
      if (insideFence) {
        continue;
      }
      if (!line) {
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }
      if (/^#/.test(line) || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^>/.test(line) || /^\|/.test(line)) {
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }
      paragraph.push(line);
      if (paragraph.join(' ').length >= 180) {
        break;
      }
    }

    const normalized = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
  }

  private normalizeRelativePath(inputPath: string): string {
    return inputPath.split(path.sep).join('/');
  }

  private matchesContextAssetTarget(target: string, assetPathSet: Set<string>): boolean {
    if (!target || assetPathSet.size === 0) {
      return false;
    }

    const normalizedDirect = this.normalizeAssetComparePath(target);
    if (assetPathSet.has(normalizedDirect)) {
      return true;
    }

    if (!/[\\/]/.test(target) && !/\.(md|prompt)$/i.test(target) && !/skill\.md$/i.test(target)) {
      return false;
    }

    const resolved = this.normalizeAssetComparePath(path.resolve(process.cwd(), target));
    return assetPathSet.has(resolved);
  }

  private normalizeAssetComparePath(inputPath: string): string {
    return path.resolve(inputPath).replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  }

  private getContextHealthSuggestions(snapshot: ContextHealthSnapshot): string[] {
    const suggestions: string[] = [];
    if (snapshot.confidence === 'low') {
      suggestions.push(chalk.yellow('Data confidence is low, run /context_health current again after a fresh turn'));
    }

    if (snapshot.explicitWindowSampleCount === 0) {
      suggestions.push(chalk.yellow('Recent samples do not include an explicit context window size, so percentages are directional only'));
    }

    if (snapshot.dataPoints > 1 && snapshot.comparableDataPoints < 2) {
      suggestions.push(chalk.yellow('Recent samples mix models or context windows, so trend tracking is intentionally suppressed'));
    }

    if (snapshot.percentDrift !== null && snapshot.percentDrift >= 15) {
      suggestions.push(chalk.yellow('Native context percentage and usage-token estimate diverge materially, so verify recorder schema before acting on the exact number'));
    }

    if (snapshot.level === 'critical') {
      suggestions.push(
        chalk.red('Compact or reset long chat history before the next heavy turn'),
        chalk.red('Trim project context payload and remove low-relevance docs'),
        chalk.red('Avoid large tool outputs in a single turn and split tasks')
      );
      return suggestions;
    }

    if (snapshot.level === 'elevated') {
      suggestions.push(
        chalk.yellow('Monitor next few turns and watch for rapid token growth'),
        chalk.yellow('Prefer concise prompts and avoid redundant context blocks')
      );
      return suggestions;
    }

    return suggestions;
  }

  private colorizeLevel(level: ContextHealthLevel): (value: string) => string {
    if (level === 'critical') {
      return chalk.red;
    }
    if (level === 'elevated') {
      return chalk.yellow;
    }
    if (level === 'healthy') {
      return chalk.green;
    }
    return chalk.gray;
  }

  private getNoiseCategoryColor(key: string): (value: string) => string {
    if (key === 'read_dup' || key === 'write_noop') {
      return chalk.red;
    }
    if (key === 'bash_dup' || key === 'grep_miss') {
      return chalk.yellow;
    }
    if (key === 'ctx_stale') {
      return chalk.blue;
    }
    return chalk.gray;
  }

  private renderNoiseTag(tag: 'dup' | 'miss' | 'stale' | 'bloat'): string {
    if (tag === 'dup') {
      return chalk.red('[dup]');
    }
    if (tag === 'miss') {
      return chalk.yellow('[miss]');
    }
    if (tag === 'stale') {
      return chalk.blue('[stale]');
    }
    return chalk.yellow('[bloat]');
  }

  private renderPercentBar(percent: number, colorize: (value: string) => string): string {
    const normalized = Math.max(0, Math.min(100, percent));
    const filledLength = normalized > 0 ? Math.max(1, Math.round((normalized / 100) * CommandHandler.TOKEN_BAR_WIDTH)) : 0;
    const filled = filledLength > 0 ? colorize('#'.repeat(filledLength)) : '';
    const empty = chalk.dim('.'.repeat(Math.max(0, CommandHandler.TOKEN_BAR_WIDTH - filledLength)));
    return `${filled}${empty}`;
  }

  private estimateContextWindowTokens(model: string): number {
    const normalized = model.trim().toLowerCase();
    if (!normalized || normalized === 'unknown') {
      return CommandHandler.DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    // Most current Claude 3.5/4.x production models use a 200k context window.
    if (normalized.includes('claude')) {
      return 200000;
    }

    return CommandHandler.DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  private getObjectAtPath(payload: unknown, keyPath: string[]): Record<string, unknown> | null {
    const value = this.getValueAtPath(payload, keyPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private getNumberAtPaths(payload: unknown, keyPaths: string[][]): number | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      const normalized = this.normalizeTokenValue(value);
      if (normalized !== null) {
        return normalized;
      }
    }
    return null;
  }

  private sumNumbers(values: Array<number | null | undefined>): number {
    return values.reduce<number>(
      (sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
      0
    );
  }

  private getStringAtPaths(payload: unknown, keyPaths: string[][]): string | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = value.trim();
      if (!normalized) {
        continue;
      }
      return normalized;
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

  private parseTokenScanRequest(args: string[]): TokenScanRequest {
    if (args.length === 0) {
      return { source: 'claude', scope: 'current' };
    }

    const first = args[0]?.trim().toLowerCase();
    const explicitSource = first === 'claude' || first === 'codex' || first === 'cursor';
    const source: TokenScanSource = explicitSource ? (first as TokenScanSource) : 'claude';
    const rest = explicitSource ? args.slice(1) : args;
    const normalized = rest[0]?.trim().toLowerCase();

    if (rest.length === 0 || normalized === 'current') {
      return { source, scope: 'current', explicitSource };
    }
    if (normalized === 'all') {
      return { source, scope: 'all', explicitSource };
    }

    return { source, scope: 'path', rawPath: rest.join(' ').trim(), explicitSource };
  }

  private async resolveTokenScanTarget(request: TokenScanRequest): Promise<TokenScanTarget> {
    if (request.scope === 'path') {
      const inputPath = request.rawPath?.trim();
      if (!inputPath) {
        throw new Error('Missing path. Usage: /scan_tokens [claude|codex|cursor] [current|all|path]');
      }

      const expandedPath = this.expandHomePath(inputPath);
      const resolvedPath = path.resolve(expandedPath);
      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        throw new Error(`Path not found: ${resolvedPath}`);
      }

      if (stat.isFile()) {
        if (!resolvedPath.toLowerCase().endsWith('.jsonl')) {
          throw new Error(`File is not JSONL: ${resolvedPath}`);
        }
        const detectedSource = await this.detectTranscriptSourceFromPath(resolvedPath, request.source);
        return {
          source: detectedSource,
          scopeLabel: 'explicit_path',
          sourceLabel: resolvedPath,
          projectDirs: [path.dirname(resolvedPath)],
          filePaths: [resolvedPath],
        };
      }

      if (!stat.isDirectory()) {
        throw new Error(`Path is neither a file nor directory: ${resolvedPath}`);
      }

      const detectedSource = await this.detectTranscriptSourceFromPath(resolvedPath, request.source);
      const filePaths =
        detectedSource === 'codex'
          ? await this.listRecentCodexRolloutFiles(resolvedPath, CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL)
          : detectedSource === 'cursor'
            ? await this.listRecentCursorTranscriptFiles(resolvedPath, CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL)
            : await this.listRecentJsonlFiles(resolvedPath, CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL);
      return {
        source: detectedSource,
        scopeLabel: 'explicit_path',
        sourceLabel: resolvedPath,
        projectDirs: [resolvedPath],
        filePaths,
      };
    }

    return request.source === 'codex'
      ? this.resolveCodexTokenScanTarget(request)
      : request.source === 'cursor'
        ? this.resolveCursorTokenScanTarget(request)
        : this.resolveClaudeTokenScanTarget(request);
  }

  private expandHomePath(inputPath: string): string {
    if (inputPath === '~') {
      return os.homedir();
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
      return path.join(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
  }

  private async resolveClaudeDataDirectory(childName: 'projects' | 'todos'): Promise<string | null> {
    const candidates = this.buildClaudeDataDirectoryCandidates(childName);
    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private async resolveCodexDataDirectory(childName: 'sessions' | 'archived_sessions'): Promise<string | null> {
    const candidates = this.buildCodexDataDirectoryCandidates(childName);
    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private async resolveCursorDataDirectory(childName: 'projects' | 'skills-cursor'): Promise<string | null> {
    const candidates = this.buildCursorDataDirectoryCandidates(childName);
    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private buildClaudeDataDirectoryCandidates(childName: 'projects' | 'todos'): string[] {
    const candidates = new Set<string>();
    const addCandidate = (basePath: string | undefined | null): void => {
      if (!basePath) {
        return;
      }
      const trimmed = basePath.trim();
      if (!trimmed) {
        return;
      }
      candidates.add(path.resolve(trimmed, childName));
    };

    addCandidate(path.join(os.homedir(), '.claude'));
    addCandidate(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.claude') : null);
    addCandidate(process.env.HOME ? path.join(process.env.HOME, '.claude') : null);

    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
      addCandidate(path.join(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`, '.claude'));
    }

    const cwdParts = path.resolve(process.cwd()).split(path.sep).filter((part) => part.length > 0);
    if (cwdParts.length >= 3 && cwdParts[1]?.toLowerCase() === 'users') {
      addCandidate(path.join(cwdParts[0] ?? '', 'Users', cwdParts[2] ?? '', '.claude'));
    }

    return Array.from(candidates);
  }

  private buildCodexDataDirectoryCandidates(childName: 'sessions' | 'archived_sessions'): string[] {
    const candidates = new Set<string>();
    const addCandidate = (basePath: string | undefined | null): void => {
      if (!basePath) {
        return;
      }
      const trimmed = basePath.trim();
      if (!trimmed) {
        return;
      }
      candidates.add(path.resolve(trimmed, childName));
    };

    addCandidate(path.join(os.homedir(), '.codex'));
    addCandidate(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : null);
    addCandidate(process.env.HOME ? path.join(process.env.HOME, '.codex') : null);

    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
      addCandidate(path.join(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`, '.codex'));
    }

    const cwdParts = path.resolve(process.cwd()).split(path.sep).filter((part) => part.length > 0);
    if (cwdParts.length >= 3 && cwdParts[1]?.toLowerCase() === 'users') {
      addCandidate(path.join(cwdParts[0] ?? '', 'Users', cwdParts[2] ?? '', '.codex'));
    }

    return Array.from(candidates);
  }

  private buildCursorDataDirectoryCandidates(childName: 'projects' | 'skills-cursor'): string[] {
    const candidates = new Set<string>();
    const addCandidate = (basePath: string | undefined | null): void => {
      if (!basePath) {
        return;
      }
      const trimmed = basePath.trim();
      if (!trimmed) {
        return;
      }
      candidates.add(path.resolve(trimmed, childName));
    };

    addCandidate(path.join(os.homedir(), '.cursor'));
    addCandidate(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cursor') : null);
    addCandidate(process.env.HOME ? path.join(process.env.HOME, '.cursor') : null);

    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
      addCandidate(path.join(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`, '.cursor'));
    }

    const cwdParts = path.resolve(process.cwd()).split(path.sep).filter((part) => part.length > 0);
    if (cwdParts.length >= 3 && cwdParts[1]?.toLowerCase() === 'users') {
      addCandidate(path.join(cwdParts[0] ?? '', 'Users', cwdParts[2] ?? '', '.cursor'));
    }

    return Array.from(candidates);
  }

  private async listClaudeProjectDirectories(projectsRoot: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsRoot, entry.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async listCursorProjectDirectories(projectsRoot: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsRoot, entry.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async resolveCursorProjectDirectories(projectsRoot: string, rootPath: string): Promise<string[]> {
    const projectDirs = await this.listCursorProjectDirectories(projectsRoot);
    if (projectDirs.length === 0) {
      return [];
    }

    const normalizedRoot = path.resolve(rootPath);
    const targetKey = this.normalizeCursorProjectKey(normalizedRoot);
    const exactMatches = projectDirs.filter(
      (projectDir) => this.normalizeCursorProjectKey(path.basename(projectDir)) === targetKey
    );
    if (exactMatches.length > 0) {
      return exactMatches;
    }

    const scored = projectDirs
      .map((projectDir) => ({
        projectDir,
        score: this.scoreCursorProjectDirMatch(path.basename(projectDir), normalizedRoot),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.projectDir.localeCompare(b.projectDir));

    return scored.slice(0, 3).map((candidate) => candidate.projectDir);
  }

  private async buildTokenStructureSummary(filePaths: string[], source: TokenScanSource): Promise<TokenStructureSummary> {
    const fieldMap = new Map<string, { total: number; count: number }>();
    const roleMap = new Map<string, { totalTokens: number; records: number }>();
    const typeMap = new Map<string, { totalTokens: number; records: number }>();
    const dayMap = new Map<string, { totalTokens: number; records: number }>();
    const files: TokenFileAggregate[] = [];

    let totalLines = 0;
    let parsedLines = 0;
    let invalidLines = 0;
    let recordsWithTokens = 0;
    let totalTokens = 0;

    for (const filePath of filePaths) {
      const fileSummary = await this.analyzeTokenJsonlFile(filePath, source, fieldMap, roleMap, typeMap, dayMap);
      files.push(fileSummary);
      totalLines += fileSummary.totalLines;
      parsedLines += fileSummary.parsedLines;
      invalidLines += fileSummary.invalidLines;
      recordsWithTokens += fileSummary.recordsWithTokens;
      totalTokens += fileSummary.totalTokens;
    }

    const tokenFields: TokenFieldAggregate[] = Array.from(fieldMap.entries())
      .map(([name, value]) => ({ name, total: value.total, count: value.count }))
      .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));

    const roleBreakdown: TokenGroupAggregate[] = Array.from(roleMap.entries())
      .map(([name, value]) => ({ name, totalTokens: value.totalTokens, records: value.records }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.records - a.records || a.name.localeCompare(b.name));

    const typeBreakdown: TokenGroupAggregate[] = Array.from(typeMap.entries())
      .map(([name, value]) => ({ name, totalTokens: value.totalTokens, records: value.records }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.records - a.records || a.name.localeCompare(b.name));

    const dayBreakdown: TokenDayAggregate[] = Array.from(dayMap.entries())
      .map(([day, value]) => ({ day, totalTokens: value.totalTokens, records: value.records }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const sortedFiles = files
      .slice()
      .sort((a, b) => b.totalTokens - a.totalTokens || b.parsedLines - a.parsedLines || a.filePath.localeCompare(b.filePath));

    return {
      files: sortedFiles,
      totalFiles: sortedFiles.length,
      totalLines,
      parsedLines,
      invalidLines,
      recordsWithTokens,
      totalTokens,
      tokenFields,
      roleBreakdown,
      typeBreakdown,
      dayBreakdown,
    };
  }

  private buildTokenUsageSummary(filePaths: string[], records: ContextUsageRecord[]): TokenUsageSummary {
    const usageRecords = records.filter((record) => record.totalTokens > 0);
    const modelMap = new Map<
      string,
      Omit<TokenUsageModelAggregate, 'activeDays'> & {
        daySet: Set<string>;
      }
    >();
    const dayMap = new Map<
      string,
      Omit<TokenUsageDayAggregate, 'models'> & {
        modelMap: Map<string, TokenUsageModelDayValue>;
      }
    >();

    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let latestTimestampMs = 0;

    for (const record of usageRecords) {
      const model = this.normalizeUsageModel(record.model);
      const day = this.toDayKey(record.timestampMs);

      totalTokens += record.totalTokens;
      inputTokens += record.inputTokens;
      outputTokens += record.outputTokens;
      cacheCreationTokens += record.cacheCreationTokens;
      cacheReadTokens += record.cacheReadTokens;
      latestTimestampMs = Math.max(latestTimestampMs, record.timestampMs);

      const currentModel =
        modelMap.get(model) ??
        {
          model,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          records: 0,
          daySet: new Set<string>(),
        };
      currentModel.totalTokens += record.totalTokens;
      currentModel.inputTokens += record.inputTokens;
      currentModel.outputTokens += record.outputTokens;
      currentModel.cacheCreationTokens += record.cacheCreationTokens;
      currentModel.cacheReadTokens += record.cacheReadTokens;
      currentModel.records += 1;
      if (day) {
        currentModel.daySet.add(day);
      }
      modelMap.set(model, currentModel);

      if (!day) {
        continue;
      }

      const currentDay =
        dayMap.get(day) ??
        {
          day,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          records: 0,
          modelMap: new Map<string, TokenUsageModelDayValue>(),
        };
      currentDay.totalTokens += record.totalTokens;
      currentDay.inputTokens += record.inputTokens;
      currentDay.outputTokens += record.outputTokens;
      currentDay.cacheCreationTokens += record.cacheCreationTokens;
      currentDay.cacheReadTokens += record.cacheReadTokens;
      currentDay.records += 1;

      const currentDayModel =
        currentDay.modelMap.get(model) ??
        {
          model,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
      currentDayModel.totalTokens += record.totalTokens;
      currentDayModel.inputTokens += record.inputTokens;
      currentDayModel.outputTokens += record.outputTokens;
      currentDayModel.cacheCreationTokens += record.cacheCreationTokens;
      currentDayModel.cacheReadTokens += record.cacheReadTokens;
      currentDay.modelMap.set(model, currentDayModel);
      dayMap.set(day, currentDay);
    }

    const models = Array.from(modelMap.values())
      .map(({ daySet, ...model }) => ({
        ...model,
        activeDays: daySet.size,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.records - a.records || a.model.localeCompare(b.model));

    const days = Array.from(dayMap.values())
      .map(({ modelMap: modelsByDay, ...day }) => ({
        ...day,
        models: Array.from(modelsByDay.values()).sort(
          (a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
        ),
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return {
      totalFiles: filePaths.length,
      totalRecords: usageRecords.length,
      totalDays: days.length,
      totalTokens,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      latestTimestampMs,
      models,
      days,
      chartDays: this.buildTokenUsageChartDays(days, 30),
      windows: this.buildTokenUsageWindows(days),
    };
  }

  private buildTokenUsageWindows(days: TokenUsageDayAggregate[]): TokenUsageWindowSummary[] {
    return [
      this.buildTokenUsageWindowSummary('All time', days),
      this.buildTokenUsageWindowSummary('Last 7 days', days, 7),
      this.buildTokenUsageWindowSummary('Last 30 days', days, 30),
    ];
  }

  private buildTokenUsageWindowSummary(
    label: string,
    days: TokenUsageDayAggregate[],
    dayCount?: number
  ): TokenUsageWindowSummary {
    const selectedDays = dayCount ? this.selectRecentTokenUsageDays(days, dayCount) : days;
    return {
      label,
      totalTokens: selectedDays.reduce((sum, day) => sum + day.totalTokens, 0),
      inputTokens: selectedDays.reduce((sum, day) => sum + day.inputTokens, 0),
      outputTokens: selectedDays.reduce((sum, day) => sum + day.outputTokens, 0),
      cacheCreationTokens: selectedDays.reduce((sum, day) => sum + day.cacheCreationTokens, 0),
      cacheReadTokens: selectedDays.reduce((sum, day) => sum + day.cacheReadTokens, 0),
      records: selectedDays.reduce((sum, day) => sum + day.records, 0),
      activeDays: selectedDays.filter((day) => day.totalTokens > 0).length,
    };
  }

  private selectRecentTokenUsageDays(days: TokenUsageDayAggregate[], dayCount: number): TokenUsageDayAggregate[] {
    if (dayCount <= 0 || days.length === 0) {
      return [];
    }

    const latestDay = days[days.length - 1]?.day;
    if (!latestDay) {
      return [];
    }

    const latestDate = new Date(`${latestDay}T00:00:00`);
    if (Number.isNaN(latestDate.getTime())) {
      return days.slice(-dayCount);
    }

    const cutoff = new Date(latestDate);
    cutoff.setDate(cutoff.getDate() - (dayCount - 1));
    const cutoffKey = this.toDayKey(cutoff.getTime());
    return days.filter((day) => day.day >= cutoffKey);
  }

  private buildTokenUsageChartDays(days: TokenUsageDayAggregate[], dayCount: number): TokenUsageDayAggregate[] {
    if (dayCount <= 0 || days.length === 0) {
      return [];
    }

    const latestDay = days[days.length - 1]?.day;
    if (!latestDay) {
      return [];
    }

    const latestDate = new Date(`${latestDay}T00:00:00`);
    if (Number.isNaN(latestDate.getTime())) {
      return days.slice(-dayCount);
    }

    const dayMap = new Map(days.map((day) => [day.day, day]));
    const result: TokenUsageDayAggregate[] = [];
    for (let index = dayCount - 1; index >= 0; index -= 1) {
      const current = new Date(latestDate);
      current.setDate(current.getDate() - index);
      const dayKey = this.toDayKey(current.getTime());
      result.push(
        dayMap.get(dayKey) ?? {
          day: dayKey,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          records: 0,
          models: [],
        }
      );
    }
    return result;
  }

  private normalizeUsageModel(model: string): string {
    const normalized = model.trim();
    return normalized || 'unknown';
  }

  private async analyzeTokenJsonlFile(
    filePath: string,
    source: TokenScanSource,
    fieldMap: Map<string, { total: number; count: number }>,
    roleMap: Map<string, { totalTokens: number; records: number }>,
    typeMap: Map<string, { totalTokens: number; records: number }>,
    dayMap: Map<string, { totalTokens: number; records: number }>
  ): Promise<TokenFileAggregate> {
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return {
        filePath,
        projectDir: path.dirname(filePath),
        totalLines: 0,
        parsedLines: 0,
        invalidLines: 0,
        recordsWithTokens: 0,
        totalTokens: 0,
        latestTimestampMs: 0,
      };
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let latestTimestampMs = 0;
    try {
      const stat = await fs.stat(filePath);
      latestTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    } catch {
      latestTimestampMs = 0;
    }

    let parsedLines = 0;
    let invalidLines = 0;
    let recordsWithTokens = 0;
    let totalTokens = 0;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        invalidLines += 1;
        continue;
      }

      parsedLines += 1;
      const lineSummary = this.summarizeTokenLine(parsed, source);
      totalTokens += lineSummary.totalTokens;
      if (lineSummary.totalTokens > 0) {
        recordsWithTokens += 1;
      }
      if (lineSummary.timestampMs > latestTimestampMs) {
        latestTimestampMs = lineSummary.timestampMs;
      }

      lineSummary.fields.forEach((field) => {
        const current = fieldMap.get(field.name) ?? { total: 0, count: 0 };
        current.total += field.value;
        current.count += 1;
        fieldMap.set(field.name, current);
      });

      const roleName = lineSummary.role || 'unknown';
      const currentRole = roleMap.get(roleName) ?? { totalTokens: 0, records: 0 };
      currentRole.totalTokens += lineSummary.totalTokens;
      currentRole.records += 1;
      roleMap.set(roleName, currentRole);

      const typeName = lineSummary.type || 'unknown';
      const currentType = typeMap.get(typeName) ?? { totalTokens: 0, records: 0 };
      currentType.totalTokens += lineSummary.totalTokens;
      currentType.records += 1;
      typeMap.set(typeName, currentType);

      const dayKey = this.toDayKey(lineSummary.timestampMs);
      if (dayKey) {
        const currentDay = dayMap.get(dayKey) ?? { totalTokens: 0, records: 0 };
        currentDay.totalTokens += lineSummary.totalTokens;
        currentDay.records += 1;
        dayMap.set(dayKey, currentDay);
      }
    }

    return {
      filePath,
      projectDir: path.dirname(filePath),
      totalLines: lines.length,
      parsedLines,
      invalidLines,
      recordsWithTokens,
      totalTokens,
      latestTimestampMs,
    };
  }

  private summarizeTokenLine(payload: unknown, source: TokenScanSource): {
    fields: Array<{ name: string; value: number }>;
    totalTokens: number;
    role: string;
    type: string;
    timestampMs: number;
  } {
    const fields: Array<{ name: string; value: number }> = [];
    if (source === 'codex') {
      this.extractCodexTokenFields(payload, fields);
    } else {
      this.extractTokenFieldsFromPayload(payload, '', fields);
    }
    const totalTokens =
      source === 'codex'
        ? fields.reduce((sum, field) => sum + (field.name.endsWith('.total_tokens') ? field.value : 0), 0) ||
          fields.reduce((sum, field) => sum + field.value, 0)
        : fields.reduce((sum, field) => sum + field.value, 0);
    const role = this.extractTokenRoleFromPayload(payload, source);
    const type = this.extractTokenTypeFromPayload(payload, source);
    const timestampMs = this.extractTokenTimestampMs(payload);
    return {
      fields,
      totalTokens,
      role,
      type,
      timestampMs,
    };
  }

  private extractTokenFieldsFromPayload(
    payload: unknown,
    prefix: string,
    fields: Array<{ name: string; value: number }>
  ): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (Array.isArray(payload)) {
      payload.forEach((item) => {
        const nextPrefix = prefix ? `${prefix}[]` : '[]';
        this.extractTokenFieldsFromPayload(item, nextPrefix, fields);
      });
      return;
    }

    const record = payload as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      const maybeToken = this.normalizeTokenValue(value);
      if (this.isLikelyTokenKey(key) && maybeToken !== null) {
        fields.push({ name: nextPrefix, value: maybeToken });
      }

      if (value && typeof value === 'object') {
        this.extractTokenFieldsFromPayload(value, nextPrefix, fields);
      }
    }
  }

  private extractCodexTokenFields(payload: unknown, fields: Array<{ name: string; value: number }>): void {
    const lastUsage = this.getObjectAtPath(payload, ['payload', 'info', 'last_token_usage']);
    if (!lastUsage) {
      return;
    }

    Object.entries(lastUsage).forEach(([key, value]) => {
      const normalized = this.normalizeTokenValue(value);
      if (normalized !== null && /token/i.test(key)) {
        fields.push({ name: `payload.info.last_token_usage.${key}`, value: normalized });
      }
    });
  }

  private isLikelyTokenKey(key: string): boolean {
    return /token/i.test(key);
  }

  private normalizeTokenValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, value);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return null;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Math.max(0, parsed);
  }

  private extractTokenRoleFromPayload(payload: unknown, source: TokenScanSource): string {
    if (!payload || typeof payload !== 'object') {
      return 'unknown';
    }

    const record = payload as Record<string, unknown>;
    if (source === 'codex') {
      const payloadRole = this.getStringAtPaths(record, [['payload', 'role']])?.toLowerCase();
      if (payloadRole === 'assistant' || payloadRole === 'user' || payloadRole === 'developer') {
        return payloadRole;
      }
      return this.getStringAtPaths(record, [['type'], ['payload', 'type']])?.toLowerCase() ?? 'unknown';
    }

    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const candidates: unknown[] = [
      record.role,
      message?.role,
      record.type,
      message?.type,
      record.actor,
      record.source,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized.includes('assistant')) {
        return 'assistant';
      }
      if (normalized.includes('user')) {
        return 'user';
      }
      if (normalized.includes('system')) {
        return 'system';
      }
      if (normalized.includes('tool')) {
        return 'tool';
      }
      return normalized;
    }

    return 'unknown';
  }

  private extractTokenTypeFromPayload(payload: unknown, source: TokenScanSource): string {
    if (!payload || typeof payload !== 'object') {
      return 'unknown';
    }

    const record = payload as Record<string, unknown>;
    if (source === 'codex') {
      const topType = this.getStringAtPaths(record, [['type']])?.trim().toLowerCase() ?? '';
      const payloadType = this.getStringAtPaths(record, [['payload', 'type']])?.trim().toLowerCase() ?? '';
      return payloadType ? `${topType}:${payloadType}` : topType || 'unknown';
    }

    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const candidates: unknown[] = [record.type, message?.type, record.event, record.kind];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized.length <= 36) {
        return normalized;
      }
      return `${normalized.slice(0, 33)}...`;
    }

    return 'unknown';
  }

  private extractTokenTimestampMs(payload: unknown): number {
    if (!payload || typeof payload !== 'object') {
      return 0;
    }

    const record = payload as Record<string, unknown>;
    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const candidates: unknown[] = [
      record.timestamp,
      record.created_at,
      record.createdAt,
      record.time,
      message?.timestamp,
      message?.created_at,
      message?.createdAt,
      message?.time,
    ];

    for (const candidate of candidates) {
      const parsed = this.parseTimestampValue(candidate);
      if (parsed > 0) {
        return parsed;
      }
    }

    return 0;
  }

  private parseTimestampValue(value: unknown): number {
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
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return 0;
  }

  private toDayKey(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return '';
    }

    const date = new Date(timestampMs);
    const year = `${date.getFullYear()}`;
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async renderTokenStructureSummary(target: TokenScanTarget, summary: TokenStructureSummary): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(TokenStructureScreen, {
          scopeLabel: target.scopeLabel,
          sourceLabel: target.sourceLabel,
          projectDirCount: target.projectDirs.length,
          summary,
        })
      );
      return;
    } catch {
      this.renderTokenStructureSummaryFallback(target, summary);
    }
  }

  private renderTokenStructureSummaryFallback(target: TokenScanTarget, summary: TokenStructureSummary): void {
    const mostRecentMs = summary.files.reduce((max, file) => Math.max(max, file.latestTimestampMs), 0);
    const headerLines: string[] = [
      `Scope: ${target.scopeLabel}`,
      `Source: ${target.sourceLabel}`,
      `Project dirs: ${target.projectDirs.length}`,
      `JSONL files: ${summary.totalFiles}`,
      `Records: ${this.formatTokenNumber(summary.parsedLines)} parsed / ${this.formatTokenNumber(summary.invalidLines)} invalid`,
      `Records with token fields: ${this.formatTokenNumber(summary.recordsWithTokens)}`,
      `Total token values: ${this.formatTokenNumber(Math.round(summary.totalTokens))}`,
    ];

    if (mostRecentMs > 0) {
      headerLines.push(`Most recent activity: ${new Date(mostRecentMs).toLocaleString()}`);
    }

    console.log(
      boxen(headerLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'gray',
        title: ' Token Structure ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    this.renderTokenFieldSection(summary.tokenFields.slice(0, 10));
    this.renderTokenGroupSection('Role Token Breakdown', summary.roleBreakdown.slice(0, 8), chalk.cyan);
    this.renderTokenGroupSection('Event Type Token Breakdown', summary.typeBreakdown.slice(0, 8), chalk.green);
    this.renderTokenFileSection(summary.files.slice(0, 8));
    this.renderTokenDaySection(summary.dayBreakdown.slice(-7));
  }

  private renderTokenFieldSection(fields: TokenFieldAggregate[]): void {
    console.log('');
    console.log(chalk.bold('  Token Fields (Top 10)'));
    if (fields.length === 0) {
      console.log(chalk.dim('  - (no token fields found)'));
      return;
    }

    const maxValue = fields.reduce((max, field) => Math.max(max, field.total), 0);
    fields.forEach((field) => {
      const label = this.truncateBlockName(field.name, 34).padEnd(34, ' ');
      const row = this.renderTokenBar(field.total, maxValue, chalk.blue);
      const valueText = this.formatTokenNumber(Math.round(field.total)).padStart(9, ' ');
      console.log(`  ${row} ${label} ${valueText} tok ${chalk.dim(`${field.count} hits`)}`);
    });
  }

  private renderTokenGroupSection(
    title: string,
    groups: TokenGroupAggregate[],
    colorize: (value: string) => string
  ): void {
    console.log('');
    console.log(chalk.bold(`  ${title}`));
    if (groups.length === 0) {
      console.log(chalk.dim('  - (none)'));
      return;
    }

    const maxValue = groups.reduce((max, group) => Math.max(max, group.totalTokens), 0);
    groups.forEach((group) => {
      const label = this.truncateBlockName(group.name, 22).padEnd(22, ' ');
      const row = this.renderTokenBar(group.totalTokens, maxValue, colorize);
      const valueText = this.formatTokenNumber(Math.round(group.totalTokens)).padStart(9, ' ');
      const recordsText = `${this.formatTokenNumber(group.records)} records`;
      console.log(`  ${row} ${label} ${valueText} tok ${chalk.dim(recordsText)}`);
    });
  }

  private renderTokenFileSection(files: TokenFileAggregate[]): void {
    console.log('');
    console.log(chalk.bold('  Top JSONL Files'));
    if (files.length === 0) {
      console.log(chalk.dim('  - (none)'));
      return;
    }

    files.forEach((file) => {
      const relativePath = path.relative(process.cwd(), file.filePath);
      const displayPath =
        relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) ? relativePath : file.filePath;
      const tokenText = this.formatTokenNumber(Math.round(file.totalTokens)).padStart(9, ' ');
      const linesText = `${this.formatTokenNumber(file.parsedLines)} parsed / ${this.formatTokenNumber(file.invalidLines)} invalid`;
      console.log(`  - ${chalk.cyan(this.truncateBlockName(displayPath, 64))}`);
      console.log(`    ${tokenText} tok  ${chalk.dim(linesText)}`);
    });
  }

  private renderTokenDaySection(days: TokenDayAggregate[]): void {
    console.log('');
    console.log(chalk.bold('  Daily Trend (Last 7 Days)'));
    if (days.length === 0) {
      console.log(chalk.dim('  - (no timestamp data)'));
      return;
    }

    const maxValue = days.reduce((max, day) => Math.max(max, day.totalTokens), 0);
    days.forEach((day) => {
      const row = this.renderTokenBar(day.totalTokens, maxValue, chalk.yellow);
      const valueText = this.formatTokenNumber(Math.round(day.totalTokens)).padStart(9, ' ');
      console.log(`  ${row} ${day.day}  ${valueText} tok ${chalk.dim(`${day.records} records`)}`);
    });
  }

  private async renderTokenUsageSummary(target: TokenScanTarget, summary: TokenUsageSummary): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(TokenUsageScreen, {
          scopeLabel: target.scopeLabel,
          sourceLabel: target.sourceLabel,
          projectDirCount: target.projectDirs.length,
          summary,
        })
      );
      return;
    } catch {
      this.renderTokenUsageSummaryFallback(target, summary);
    }
  }

  private renderTokenUsageSummaryFallback(target: TokenScanTarget, summary: TokenUsageSummary): void {
    const recentLabel = summary.latestTimestampMs > 0 ? new Date(summary.latestTimestampMs).toLocaleString() : 'none';
    const windowsText = summary.windows
      .map((window) => `${window.label}: ${this.formatCompactTokenNumber(window.totalTokens)}`)
      .join(' | ');
    const headerLines: string[] = [
      `Scope: ${target.scopeLabel}`,
      `Source: ${target.sourceLabel}`,
      `Project dirs: ${target.projectDirs.length}`,
      `JSONL files: ${summary.totalFiles}`,
      `Usage records: ${this.formatTokenNumber(summary.totalRecords)} over ${this.formatTokenNumber(summary.totalDays)} days`,
      `Total: ${this.formatCompactTokenNumber(summary.totalTokens)}  (in ${this.formatCompactTokenNumber(summary.inputTokens)} / out ${this.formatCompactTokenNumber(summary.outputTokens)})`,
      `Cache: create ${this.formatCompactTokenNumber(summary.cacheCreationTokens)} / read ${this.formatCompactTokenNumber(summary.cacheReadTokens)}`,
      `Recent activity: ${recentLabel}`,
      windowsText,
    ];

    console.log(
      boxen(headerLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Token Usage ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Models'));
    if (summary.models.length === 0) {
      console.log(chalk.dim('  - (no usage records found)'));
    } else {
      summary.models.slice(0, 8).forEach((model, index) => {
        const colorize = this.getUsageModelColor(index);
        const share = summary.totalTokens > 0 ? `${((model.totalTokens / summary.totalTokens) * 100).toFixed(1)}%` : '0.0%';
        const sparkline = this.buildUsageSparkline(summary.chartDays, model.model);
        console.log(
          `  ${colorize('●')} ${this.truncateBlockName(model.model, 26).padEnd(26, ' ')} ${sparkline} ${this.formatCompactTokenNumber(model.totalTokens).padStart(8, ' ')} ${chalk.dim(share)}`
        );
        console.log(
          `    in ${this.formatCompactTokenNumber(model.inputTokens)}  out ${this.formatCompactTokenNumber(model.outputTokens)}  cache ${this.formatCompactTokenNumber(model.cacheCreationTokens + model.cacheReadTokens)}  ${chalk.dim(`${model.records} rec / ${model.activeDays} days`)}`
        );
      });
    }

    console.log('');
    console.log(chalk.bold('  Daily Totals'));
    if (summary.days.length === 0) {
      console.log(chalk.dim('  - (no day buckets found)'));
      return;
    }

    const maxValue = summary.chartDays.reduce((max, day) => Math.max(max, day.totalTokens), 0);
    summary.days.slice(-10).forEach((day) => {
      const row = this.renderTokenBar(day.totalTokens, maxValue, chalk.yellow);
      const dominant = day.models
        .slice(0, 2)
        .map((model) => `${this.truncateBlockName(model.model, 18)} ${this.formatCompactTokenNumber(model.totalTokens)}`)
        .join(' | ');
      console.log(
        `  ${row} ${day.day}  ${this.formatCompactTokenNumber(day.totalTokens).padStart(8, ' ')} ${chalk.dim(`${day.records} rec`)}`
      );
      if (dominant) {
        console.log(`    ${chalk.dim(dominant)}`);
      }
    });
  }

  private getUsageModelColor(index: number): (value: string) => string {
    const palette = [chalk.hex('#A5B4FC'), chalk.hex('#4ADE80'), chalk.hex('#FACC15'), chalk.hex('#38BDF8'), chalk.hex('#F472B6')];
    return palette[index % palette.length];
  }

  private buildUsageSparkline(days: TokenUsageDayAggregate[], modelName: string): string {
    const levels = '▁▂▃▄▅▆▇█';
    const values = days.map((day) => day.models.find((model) => model.model === modelName)?.totalTokens ?? 0);
    const maxValue = values.reduce((max, value) => Math.max(max, value), 0);
    if (maxValue <= 0) {
      return chalk.dim('·'.repeat(Math.max(8, values.length)));
    }

    return values
      .map((value) => {
        if (value <= 0) {
          return chalk.dim('·');
        }
        const level = Math.min(levels.length - 1, Math.max(0, Math.round((value / maxValue) * (levels.length - 1))));
        return levels[level];
      })
      .join('');
  }

  private renderTokenBar(value: number, maxValue: number, colorize: (value: string) => string): string {
    if (maxValue <= 0 || value <= 0) {
      return chalk.dim('.'.repeat(CommandHandler.TOKEN_BAR_WIDTH));
    }
    const ratio = Math.max(0, Math.min(1, value / maxValue));
    const filledLength = Math.max(1, Math.round(ratio * CommandHandler.TOKEN_BAR_WIDTH));
    const filled = colorize('#'.repeat(filledLength));
    const empty = chalk.dim('.'.repeat(Math.max(0, CommandHandler.TOKEN_BAR_WIDTH - filledLength)));
    return `${filled}${empty}`;
  }

  private formatTokenNumber(value: number): string {
    return Math.round(value).toLocaleString('en-US');
  }

  private formatCompactTokenNumber(value: number): string {
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
    }
    if (absolute >= 1_000) {
      return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)}k`;
    }
    return `${Math.round(value)}`;
  }

  private async scanSkills(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Scanning workspace skills...');
    } else {
      this.uiRenderer.renderInfo('Scanning workspace skills...');
    }

    try {
      const requestedPath = args.join(' ').trim();
      const resolvedTarget = await this.resolveSkillScanTarget(requestedPath);
      const targetPath = resolvedTarget.targetPath;
      const scopeLabel = resolvedTarget.scopeLabel;
      const targetStat = await fs.stat(targetPath);
      if (!targetStat.isDirectory()) {
        throw new Error(`Skills scan target is not a directory: ${targetPath}`);
      }

      const result = await this.skillScanner.scan(targetPath);
      if (spinner) {
        spinner.stop('Skills scan completed');
      } else {
        this.uiRenderer.renderSuccess('Skills scan completed');
      }

      await this.renderSkillsOverview(scopeLabel, result);
      this.recordCommandData(
        'skills',
        [
          `root=${result.rootPath}`,
          `scannedFiles=${result.scannedFileCount}`,
          `skills=${result.skills.length}`,
          `supportFiles=${result.totalResourceFiles}`,
          ...result.skills.slice(0, 12).map((skill) => {
            const resources =
              skill.resourceSummaries.length > 0
                ? skill.resourceSummaries.map((resource) => `${resource.label}:${resource.fileCount}`).join(', ')
                : 'none';
            return `${skill.name} | ${skill.relativeDir} | ${skill.purpose} | resources=${resources}`;
          }),
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan skills';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('skills', `failed: ${message}`);
    }
  }

  private async resolveSkillScanTarget(requestedPath: string): Promise<{ targetPath: string; scopeLabel: string }> {
    const normalized = requestedPath.trim().toLowerCase();
    if (!normalized) {
      return {
        targetPath: process.cwd(),
        scopeLabel: 'current_project',
      };
    }

    if (normalized === 'cursor' || normalized === 'cursor-skills' || normalized === 'skills-cursor') {
      const cursorSkillsPath =
        (await this.resolveCursorDataDirectory('skills-cursor')) ?? path.join(os.homedir(), '.cursor', 'skills-cursor');
      return {
        targetPath: cursorSkillsPath,
        scopeLabel: 'cursor_skills',
      };
    }

    const targetPath = path.resolve(process.cwd(), requestedPath);
    return {
      targetPath,
      scopeLabel: path.relative(process.cwd(), targetPath) || '.',
    };
  }

  private async scanRules(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Scanning workspace rules...');
    } else {
      this.uiRenderer.renderInfo('Scanning workspace rules...');
    }

    try {
      const requestedPath = args.join(' ').trim();
      const targetPath = requestedPath ? path.resolve(process.cwd(), requestedPath) : process.cwd();
      const scopeLabel = requestedPath ? path.relative(process.cwd(), targetPath) || '.' : 'current_project';
      const targetStat = await fs.stat(targetPath);
      if (!targetStat.isDirectory()) {
        throw new Error(`Rules scan target is not a directory: ${targetPath}`);
      }

      const result = await this.ruleScanner.scan(targetPath);
      if (spinner) {
        spinner.stop('Rules scan completed');
      } else {
        this.uiRenderer.renderSuccess('Rules scan completed');
      }

      await this.renderRulesScanResult(scopeLabel, result);
      this.recordCommandData(
        'rules',
        [
          `root=${result.rootPath}`,
          `scope=${scopeLabel}`,
          `scannedFiles=${result.scannedFileCount}`,
          `candidateFiles=${result.candidateFileCount}`,
          `matchedFiles=${result.matchedFileCount}`,
          `rules=${result.totalRules}`,
          ...result.files.slice(0, 16).map((file) => {
            const preview = file.rules
              .slice(0, 6)
              .map((rule) => `L${rule.lineStart}${rule.lineEnd > rule.lineStart ? `-${rule.lineEnd}` : ''}: ${rule.text}`)
              .join(' | ');
            return `${file.relativePath} [${file.labels.join(', ')}] => ${preview || '(no rules)'}`;
          }),
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan rules';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('rules', `failed: ${message}`);
    }
  }

  private async renderRulesScanResult(scopeLabel: string, result: RulesScanResult): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(RulesScanScreen, {
          scopeLabel,
          result,
        })
      );
      return;
    } catch {
      this.renderRulesScanResultFallback(scopeLabel, result);
    }
  }

  private renderRulesScanResultFallback(scopeLabel: string, result: RulesScanResult): void {
    const summaryLines = [
      `${chalk.gray('Scope')} ${chalk.white(scopeLabel)}`,
      `${chalk.gray('Workspace')} ${chalk.white(result.rootPath)}`,
      `${chalk.gray('Scanned files')} ${chalk.white(result.scannedFileCount)}    ${chalk.gray('Candidate files')} ${chalk.white(
        result.candidateFileCount
      )}`,
      `${chalk.gray('Matched files')} ${chalk.cyan(result.matchedFileCount)}    ${chalk.gray('Extracted rules')} ${chalk.cyan(
        result.totalRules
      )}`,
      chalk.dim('Rule detection is deterministic and line-based. Results are excerpts, not semantic summaries.'),
    ];

    console.log('');
    console.log(
      boxen(summaryLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Rules Scan ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    if (result.files.length === 0) {
      console.log('');
      console.log(chalk.yellow('  No explicit rule lines were detected in the target workspace.'));
      console.log(chalk.dim('  Tip: place instructions in AGENTS.md, CLAUDE.md, .cursor/.claude, rules/, or system-prompt files.'));
      return;
    }

    console.log('');
    console.log(chalk.bold('  Detected Rules'));
    result.files.forEach((file) => {
      console.log('');
      console.log(this.renderRulesFileHeader(file));
      file.rules.forEach((rule) => {
        console.log(this.renderRuleLine(rule));
      });
    });
  }

  private renderRulesFileHeader(file: RulesFile): string {
    const labelText = file.labels.length > 0 ? ` [${file.labels.join(', ')}]` : '';
    return (
      chalk.dim('  - ') +
      chalk.cyan(file.relativePath) +
      chalk.dim(labelText) +
      chalk.dim(`  (${file.rules.length} rule${file.rules.length === 1 ? '' : 's'})`)
    );
  }

  private renderRuleLine(rule: ExtractedRule): string {
    const lineLabel =
      rule.lineStart === rule.lineEnd ? `L${rule.lineStart}` : `L${rule.lineStart}-${rule.lineEnd}`;
    const signalLabel =
      rule.signal === 'explicit' ? chalk.green('explicit') : chalk.yellow('section');
    const headingText =
      rule.headingPath.length > 0 ? chalk.dim(`  (${rule.headingPath.join(' > ')})`) : '';
    return `      ${chalk.dim(lineLabel.padEnd(8, ' '))}${signalLabel} ${chalk.white(rule.text)}${headingText}`;
  }

  private async renderSkillsOverview(scopeLabel: string, result: SkillScanResult): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(SkillsOverviewScreen, {
          scopeLabel,
          result,
        })
      );
      return;
    } catch {
      this.renderSkillsOverviewFallback(result);
    }
  }

  private renderSkillsOverviewFallback(result: SkillScanResult): void {
    const totalInstructionTokens = result.skills.reduce((sum, skill) => sum + skill.instructionTokenEstimate, 0);
    const skillFolders = new Set(result.skills.map((skill) => skill.relativeDir)).size;
    const resourceCoverage = this.buildSkillCoverageSummary(result.skills);
    const overviewLines = [
      `${chalk.gray('Workspace')} ${chalk.white(result.rootPath)}`,
      `${chalk.gray('Scanned files')} ${chalk.white(result.scannedFileCount)}    ${chalk.gray('Skills')} ${chalk.cyan(
        result.skills.length
      )}    ${chalk.gray('Skill folders')} ${chalk.white(skillFolders)}`,
      `${chalk.gray('Instruction footprint')} ${chalk.white(this.formatTokenNumber(totalInstructionTokens))} tok    ${chalk.gray(
        'Support files'
      )} ${chalk.white(result.totalResourceFiles)}`,
      `${chalk.gray('Coverage')} ${resourceCoverage}`,
    ];

    console.log('');
    console.log(
      boxen(overviewLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Skills Workspace ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    if (result.skills.length === 0) {
      console.log('');
      console.log(chalk.yellow('  No SKILL.md files found in this directory tree.'));
      console.log(chalk.dim('  Tip: add a skill folder that contains a SKILL.md file, then run /skills again.'));
      return;
    }

    result.skills.forEach((skill, index) => {
      console.log('');
      console.log(this.renderSkillCard(skill, index));
    });
  }

  private buildSkillCoverageSummary(skills: SkillSummary[]): string {
    if (skills.length === 0) {
      return chalk.dim('no skill resources detected yet');
    }

    const counts = {
      agents: 0,
      scripts: 0,
      references: 0,
      assets: 0,
      extras: 0,
    };

    skills.forEach((skill) => {
      if (skill.resourceSummaries.some((resource) => resource.kind === 'agents' && resource.fileCount > 0)) {
        counts.agents += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'scripts' && resource.fileCount > 0)) {
        counts.scripts += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'references' && resource.fileCount > 0)) {
        counts.references += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'assets' && resource.fileCount > 0)) {
        counts.assets += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'other' && resource.fileCount > 0)) {
        counts.extras += 1;
      }
    });

    const chips: string[] = [];
    if (counts.agents > 0) {
      chips.push(chalk.cyan(`agents ${counts.agents}`));
    }
    if (counts.scripts > 0) {
      chips.push(chalk.magenta(`scripts ${counts.scripts}`));
    }
    if (counts.references > 0) {
      chips.push(chalk.green(`references ${counts.references}`));
    }
    if (counts.assets > 0) {
      chips.push(chalk.yellow(`assets ${counts.assets}`));
    }
    if (counts.extras > 0) {
      chips.push(chalk.gray(`extras ${counts.extras}`));
    }

    return chips.length > 0 ? chips.join(chalk.dim('  ·  ')) : chalk.dim('SKILL.md only');
  }

  private renderSkillCard(skill: SkillSummary, index: number): string {
    const cardWidth = this.getSkillCardWidth();
    const contentWidth = Math.max(24, cardWidth - 6);
    const relatedLine =
      skill.resourceSummaries.length > 0
        ? skill.resourceSummaries.map((resource) => `${resource.label} (${resource.fileCount})`).join(', ')
        : 'SKILL.md only';
    const samplePaths = skill.resourceSummaries.flatMap((resource) => resource.samplePaths).slice(0, 4).join(', ');
    const sectionList = skill.headings.join(' · ');
    const footprint = `SKILL.md ~${this.formatTokenNumber(skill.instructionTokenEstimate)} tok, support files ${skill.totalResourceFiles}`;

    const lines: string[] = [];
    lines.push(...this.wrapSkillField('Purpose', skill.purpose, contentWidth));

    if (skill.whenToUse) {
      lines.push(...this.wrapSkillField('When to use', skill.whenToUse, contentWidth));
    } else if (skill.description && this.normalizeSkillText(skill.description) !== this.normalizeSkillText(skill.purpose)) {
      lines.push(...this.wrapSkillField('Description', skill.description, contentWidth));
    }

    lines.push(...this.wrapSkillField('Path', skill.relativeDir, contentWidth));
    lines.push(...this.wrapSkillField('Core file', skill.skillFileRelativePath, contentWidth));
    lines.push(...this.wrapSkillField('Related', relatedLine, contentWidth));

    if (samplePaths) {
      lines.push(...this.wrapSkillField('Samples', samplePaths, contentWidth));
    }

    if (sectionList) {
      lines.push(...this.wrapSkillField('Sections', sectionList, contentWidth));
    }

    lines.push(...this.wrapSkillField('Footprint', footprint, contentWidth));

    const borderColors = ['cyan', 'green', 'yellow', 'magenta'] as const;
    return boxen(lines.join('\n'), {
      borderStyle: 'round',
      borderColor: borderColors[index % borderColors.length],
      title: ` ${skill.title} `,
      titleAlignment: 'left',
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      width: cardWidth,
    });
  }

  private getSkillCardWidth(): number {
    const terminalWidth = process.stdout.columns ?? 120;
    return Math.max(44, Math.min(100, terminalWidth - 2));
  }

  private wrapSkillField(label: string, value: string, width: number): string[] {
    const normalizedValue = this.normalizeSkillText(value);
    if (!normalizedValue) {
      return [];
    }

    const prefix = `${label}: `;
    const continuationPrefix = ' '.repeat(prefix.length);
    const wrapped = this.wrapPlainText(normalizedValue, Math.max(16, width - prefix.length));

    return wrapped.map((line, index) =>
      index === 0 ? `${chalk.gray(prefix)}${chalk.white(line)}` : `${chalk.gray(continuationPrefix)}${chalk.white(line)}`
    );
  }

  private wrapPlainText(value: string, maxWidth: number): string[] {
    if (value.length <= maxWidth) {
      return [value];
    }

    const words = value.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [''];
    }

    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      if (word.length > maxWidth) {
        if (current) {
          lines.push(current);
          current = '';
        }

        for (let index = 0; index < word.length; index += maxWidth) {
          lines.push(word.slice(index, index + maxWidth));
        }
        continue;
      }

      const next = current ? `${current} ${word}` : word;
      if (next.length > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }

    if (current) {
      lines.push(current);
    }

    return lines;
  }

  private normalizeSkillText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private async scanPromptAssets(): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Analyzing prompt assets...');
    } else {
      this.uiRenderer.renderInfo('Analyzing prompt assets...');
    }

    try {
      const { mode, warning, result, anatomyView } = await this.withTimeout(
        async () => {
          const tokenization = await this.resolvePromptScanTokenizationStrategy();
          const result = await this.promptAssetScanner.scan(process.cwd(), {
            tokenCounter: (text, _filePath) => tokenization.countTokens(text),
          });
          const anatomyView = await this.buildContextAnatomyView(result.files, tokenization.countTokens);
          return {
            mode: tokenization.getMode(),
            warning: tokenization.getWarning(),
            result,
            anatomyView,
          };
        },
        CommandHandler.SCAN_PROMPT_TIMEOUT_MS,
        `/scan_prompt timed out after ${this.formatTimeoutMs(CommandHandler.SCAN_PROMPT_TIMEOUT_MS)}.`
      );
      if (spinner) {
        spinner.stop('Prompt analysis completed');
      } else {
        this.uiRenderer.renderSuccess('Prompt analysis completed');
      }

      const modeLabel =
        mode === 'count_tokens'
          ? 'messages/count_tokens'
          : mode === 'messages_usage'
            ? 'messages usage.input_tokens'
            : 'local estimated tokens';

      if (result.files.length === 0) {
        console.log('');
        console.log(chalk.bold('  Prompt Asset Scan'));
        console.log(chalk.dim('  - ') + chalk.gray('Project: ') + chalk.white(result.rootPath));
        console.log(chalk.dim('  - ') + chalk.gray('Scanned files: ') + chalk.white(result.scannedFileCount));
        console.log(chalk.dim('  - ') + chalk.gray('Prompt assets: ') + chalk.white(result.files.length));
        this.uiRenderer.renderInfo(`Tokenizer mode: ${modeLabel}`);
        if (warning) {
          this.uiRenderer.renderWarning(warning);
        }
        this.uiRenderer.renderWarning('No prompt assets found in current directory');
        this.renderContextAnatomyView(anatomyView);
        this.recordCommandData(
          'scan_prompt',
          [
            `project=${result.rootPath}`,
            `scannedFiles=${result.scannedFileCount}`,
            'promptAssets=0',
            `tokenizerMode=${modeLabel}`,
            'contextAnatomy:',
            ...anatomyView.summary,
          ].join('\n')
        );
        return;
      }
      await this.renderPromptScanResult({
        modeLabel,
        warning,
        result,
        anatomyView,
      });
      const topFiles = result.files
        .slice()
        .sort((a, b) => b.tokenCount - a.tokenCount || a.relativePath.localeCompare(b.relativePath))
        .slice(0, 12)
        .map((file) => `${file.relativePath} (${file.tokenCount} tok, ${file.categories.join('|')})`)
        .join('\n');
      this.recordCommandData(
        'scan_prompt',
        [
          `project=${result.rootPath}`,
          `scannedFiles=${result.scannedFileCount}`,
          `promptAssets=${result.files.length}`,
          `tokenizerMode=${modeLabel}`,
          'contextAnatomy:',
          ...anatomyView.summary,
          'topFiles:',
          topFiles || '(none)',
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan prompt assets';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('scan_prompt', `failed: ${message}`);
    }
  }

  private async renderPromptScanResult(presentation: PromptScanPresentation): Promise<void> {
    try {
      await renderStaticInkScreen(
        createElement(ScanPromptScreen, {
          scopeLabel: 'current_project',
          rootPath: presentation.result.rootPath,
          tokenizerModeLabel: presentation.modeLabel,
          tokenizerWarning: presentation.warning,
          scannedFileCount: presentation.result.scannedFileCount,
          files: presentation.result.files,
          anatomyLines: presentation.anatomyView.lines,
          anatomySummary: presentation.anatomyView.summary,
          recommendations: presentation.anatomyView.recommendations,
        })
      );
      return;
    } catch {
      this.renderPromptScanResultFallback(presentation);
    }
  }

  private renderPromptScanResultFallback(presentation: PromptScanPresentation): void {
    const { modeLabel, warning, result, anatomyView } = presentation;
    const categoryOrder: PromptAssetCategory[] = ['project-config', 'prompt-file', 'rules', 'system-prompt', 'docs'];
    const categoryNames: Record<PromptAssetCategory, string> = {
      'project-config': 'Project Config',
      'prompt-file': '.prompt Files',
      rules: 'rules/ Files',
      'system-prompt': 'System Prompt',
      docs: 'docs/ Files',
    };

    this.uiRenderer.renderInfo(`Tokenizer mode: ${modeLabel}`);
    if (warning) {
      this.uiRenderer.renderWarning(warning);
    }

    console.log('');
    console.log(chalk.bold('  Prompt Asset Scan'));
    console.log(chalk.dim('  - ') + chalk.gray('Project: ') + chalk.white(result.rootPath));
    console.log(chalk.dim('  - ') + chalk.gray('Scanned files: ') + chalk.white(result.scannedFileCount));
    console.log(chalk.dim('  - ') + chalk.gray('Prompt assets: ') + chalk.white(result.files.length));

    console.log('');
    console.log(chalk.bold('  Categories'));
    categoryOrder.forEach((category) => {
      const count = result.files.filter((file) => file.categories.includes(category)).length;
      if (count > 0) {
        console.log(chalk.dim('  - ') + chalk.gray(categoryNames[category] + ': ') + chalk.white(count));
      }
    });

    console.log('');
    console.log(chalk.bold('  Files'));
    result.files.forEach((file) => {
      const tag = file.categories.map((category) => categoryNames[category]).join(', ');
      const tokenInfo = file.tokenCount > 0 ? `${file.tokenCount.toString().padStart(5)} tok` : '  n/a tok';
      console.log(chalk.dim('  - ') + chalk.cyan(file.relativePath) + chalk.dim(`  ${tokenInfo}  [${tag}]`));
    });
    console.log('');

    this.renderContextAnatomyView(anatomyView);
  }

  private async withTimeout<T>(task: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);

      task()
        .then((value) => {
          clearTimeout(timeoutHandle);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }

  private async resolvePromptScanTokenizationStrategy(): Promise<PromptScanTokenizationStrategy> {
    let mode: PromptScanTokenizerMode = 'estimated';
    let warning: string | undefined;

    try {
      mode = await this.claudeTokenizer.getActiveMode();
    } catch (error) {
      warning = this.formatPromptScanTokenizerFallbackWarning(error);
    }

    return {
      countTokens: async (text: string) => {
        if (mode === 'estimated') {
          return estimateTokenCount(text);
        }

        try {
          return await this.claudeTokenizer.countTextTokens(text);
        } catch (error) {
          mode = 'estimated';
          warning ??= this.formatPromptScanTokenizerFallbackWarning(error);
          return estimateTokenCount(text);
        }
      },
      getMode: () => mode,
      getWarning: () => warning,
    };
  }

  private formatPromptScanTokenizerFallbackWarning(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown tokenizer error';
    return `Tokenizer unavailable. Falling back to local token estimates. Reason: ${message}`;
  }

  private formatTimeoutMs(timeoutMs: number): string {
    const totalSeconds = Math.max(1, Math.round(timeoutMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (seconds === 0) {
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${minutes}m ${seconds}s`;
  }

  private async buildContextAnatomyLines(
    files: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }>
  ): Promise<string[]> {
    const systemFiles = files.filter((file) =>
      file.categories.includes('project-config') || file.categories.includes('system-prompt')
    );
    const docsFiles = files.filter(
      (file) =>
        !systemFiles.some((systemFile) => systemFile.relativePath === file.relativePath) &&
        file.categories.includes('docs')
    );

    const systemPromptTokens = systemFiles.reduce((sum, file) => sum + file.tokenCount, 0);
    const docsTokens = docsFiles.reduce((sum, file) => sum + file.tokenCount, 0);

    const messages = this.conversationManager.getMessages();
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const userMessageTokens = latestUserMessage ? await this.claudeTokenizer.countTextTokens(latestUserMessage.content) : 0;
    const historyParts = await Promise.all(
      messages
        .filter((message) => message.id !== latestUserMessage?.id)
        .map((message) => this.claudeTokenizer.countTextTokens(message.content))
    );
    const historyTokens = historyParts.reduce((sum, value) => sum + value, 0);

    const totalTokens = systemPromptTokens + docsTokens + historyTokens + userMessageTokens;
    const contextLimit = await this.resolveContextAnatomyLimit();
    const truncatedTokens = Math.max(0, totalTokens - contextLimit.usableContextTokens);
    const denominator = Math.max(1, totalTokens);

    const buckets: AnatomyBucket[] = [
      this.createAnatomyBucket('System Prompt', systemPromptTokens, denominator, chalk.blue),
      this.createAnatomyBucket('Docs', docsTokens, denominator, chalk.green),
      this.createAnatomyBucket('History', historyTokens, denominator, chalk.yellow),
      this.createAnatomyBucket('User Message', userMessageTokens, denominator, chalk.white),
    ];

    const lines: string[] = [];
    lines.push(chalk.bold('Segment          Tokens       Share   Context Load'));
    lines.push(chalk.dim('────────────────────────────────────────────────────────'));
    buckets.forEach((bucket) => {
      lines.push(this.renderAnatomyRow(bucket));
    });

    const docDetailFiles = docsFiles
      .slice()
      .sort((a, b) => b.tokenCount - a.tokenCount || a.relativePath.localeCompare(b.relativePath))
      .slice(0, 6);

    if (docDetailFiles.length > 0) {
      const docsIndex = buckets.findIndex((bucket) => bucket.name === 'Docs');
      if (docsIndex >= 0) {
        const rowOffset = 2; // header + divider
        docDetailFiles.forEach((file, index) => {
          const branch = index === docDetailFiles.length - 1 ? '`-' : '|-';
          lines.splice(
            rowOffset + docsIndex + 1 + index,
            0,
            chalk.dim(
              `${' '.repeat(2)}${branch} ${this.truncatePathForAnatomy(file.relativePath).padEnd(28, ' ')} ${this
                .formatTokenNumber(file.tokenCount)
                .padStart(8, ' ')} tok`
            )
          );
        });
      }
    }

    lines.push(chalk.dim('────────────────────────────────────────────────────────'));
    lines.push(
      chalk.dim(
        `Context window estimate: ${this.formatTokenNumber(contextLimit.contextWindowTokens)} tok (model: ${contextLimit.model})`
      )
    );
    lines.push(
      chalk.dim(
        `Usable estimate: ${this.formatTokenNumber(contextLimit.usableContextTokens)} tok (reserve ${this.formatTokenNumber(
          contextLimit.bufferTokens
        )} tok)`
      )
    );
    if (truncatedTokens > 0) {
      lines.push(chalk.red(`Potential overflow: ${this.formatTokenNumber(truncatedTokens)} tok beyond usable estimate`));
    }
    return lines;
  }

  private renderContextAnatomy(lines: string[]): void {
    console.log(
      boxen(lines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Context Anatomy ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      })
    );
  }

  private async buildContextAnatomyView(
    files: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }>,
    countTokens: PromptScanTokenCounter
  ): Promise<ContextAnatomyView> {
    const systemFiles: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }> = [];
    const promptLibraryFiles: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }> = [];
    const referenceDocsFiles: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }> = [];

    files.forEach((file) => {
      const bucket = this.classifyPromptAssetForAnatomy(file);
      if (bucket === 'system') {
        systemFiles.push(file);
        return;
      }
      if (bucket === 'prompt_library') {
        promptLibraryFiles.push(file);
        return;
      }
      referenceDocsFiles.push(file);
    });

    const systemPromptTokens = systemFiles.reduce((sum, file) => sum + file.tokenCount, 0);
    const promptLibraryTokens = promptLibraryFiles.reduce((sum, file) => sum + file.tokenCount, 0);
    const docsTokens = referenceDocsFiles.reduce((sum, file) => sum + file.tokenCount, 0);

    const messages = this.conversationManager.getMessages();
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const historyMessages = messages.filter((message) => message.id !== latestUserMessage?.id);
    const [userMessageTokens, historyTokenParts] = await Promise.all([
      latestUserMessage ? countTokens(latestUserMessage.content) : Promise.resolve(0),
      Promise.all(historyMessages.map((message) => countTokens(message.content))),
    ]);
    const historyTokens = historyTokenParts.reduce((sum, value) => sum + value, 0);

    const totalTokens = systemPromptTokens + promptLibraryTokens + docsTokens + historyTokens + userMessageTokens;
    const contextLimit = await this.resolveContextAnatomyLimit();
    const overflowTokens = Math.max(0, totalTokens - contextLimit.usableContextTokens);
    const usableHeadroom = Math.max(0, contextLimit.usableContextTokens - totalTokens);
    const hardHeadroom = Math.max(0, contextLimit.contextWindowTokens - totalTokens);
    const budgetUtilization = contextLimit.usableContextTokens <= 0 ? 0 : totalTokens / contextLimit.usableContextTokens;
    const latestUserShare = totalTokens <= 0 ? 0 : userMessageTokens / totalTokens;
    const turnDepthRatio = totalTokens <= 0 ? 0 : Math.max(0, (totalTokens - userMessageTokens) / totalTokens);

    const segmentDefinitions: Array<{
      key: ContextAnatomySegmentKey;
      label: string;
      shortLabel: string;
      tokenCount: number;
      itemCount: number;
      colorize: (value: string) => string;
      barChar: string;
    }> = [
      {
        key: 'system',
        label: 'Core instructions',
        shortLabel: 'S',
        tokenCount: systemPromptTokens,
        itemCount: systemFiles.length,
        colorize: chalk.blue,
        barChar: 'S',
      },
      {
        key: 'prompt_library',
        label: 'Rules & prompts',
        shortLabel: 'P',
        tokenCount: promptLibraryTokens,
        itemCount: promptLibraryFiles.length,
        colorize: chalk.magenta,
        barChar: 'P',
      },
      {
        key: 'reference_docs',
        label: 'Reference docs',
        shortLabel: 'D',
        tokenCount: docsTokens,
        itemCount: referenceDocsFiles.length,
        colorize: chalk.green,
        barChar: 'D',
      },
      {
        key: 'chat_history',
        label: 'Chat history',
        shortLabel: 'H',
        tokenCount: historyTokens,
        itemCount: historyMessages.length,
        colorize: chalk.yellow,
        barChar: 'H',
      },
      {
        key: 'active_request',
        label: 'Active request',
        shortLabel: 'U',
        tokenCount: userMessageTokens,
        itemCount: latestUserMessage ? 1 : 0,
        colorize: chalk.white,
        barChar: 'U',
      },
    ];

    const segments = segmentDefinitions.map((segment) => {
      const shareOfInput = totalTokens <= 0 ? 0 : segment.tokenCount / totalTokens;
      const shareOfWindow = contextLimit.usableContextTokens <= 0 ? 0 : segment.tokenCount / contextLimit.usableContextTokens;
      const { note, severity } = this.describeContextSegment(segment.key, {
        tokenCount: segment.tokenCount,
        shareOfInput,
        itemCount: segment.itemCount,
        totalTokens,
        latestUserShare,
        turnDepthRatio,
      });

      return {
        ...segment,
        shareOfInput,
        shareOfWindow,
        note,
        severity,
      };
    });

    const drivers: ContextAnatomyDriver[] = [
      ...systemFiles.map((file) =>
        this.createContextAnatomyDriver(file.relativePath, file.tokenCount, totalTokens, contextLimit.usableContextTokens, 'Core', chalk.blue)
      ),
      ...promptLibraryFiles.map((file) =>
        this.createContextAnatomyDriver(
          file.relativePath,
          file.tokenCount,
          totalTokens,
          contextLimit.usableContextTokens,
          'Rules',
          chalk.magenta
        )
      ),
      ...referenceDocsFiles.map((file) =>
        this.createContextAnatomyDriver(
          file.relativePath,
          file.tokenCount,
          totalTokens,
          contextLimit.usableContextTokens,
          'Docs',
          chalk.green
        )
      ),
    ];

    if (historyTokens > 0) {
      drivers.push(
        this.createContextAnatomyDriver(
          `Chat history (${historyMessages.length} turns)`,
          historyTokens,
          totalTokens,
          contextLimit.usableContextTokens,
          'History',
          chalk.yellow
        )
      );
    }

    if (userMessageTokens > 0) {
      drivers.push(
        this.createContextAnatomyDriver(
          'Active user request',
          userMessageTokens,
          totalTokens,
          contextLimit.usableContextTokens,
          'Live ask',
          chalk.white
        )
      );
    }

    const topDrivers = drivers
      .slice()
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))
      .slice(0, 6);
    const dominantSegment = segments
      .slice()
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))[0];

    const lines: string[] = [];
    lines.push(chalk.bold('Budget'));
    lines.push(
      `Window load : ${this.renderStackedContextBar(
        segments,
        totalTokens,
        contextLimit.usableContextTokens
      )} ${this.formatTokenNumber(totalTokens)} / ${this.formatTokenNumber(contextLimit.usableContextTokens)} tok (${this.formatRatioPercent(
        budgetUtilization
      )})`
    );
    lines.push(
      `Payload mix : ${this.renderStackedContextBar(segments, totalTokens, Math.max(1, totalTokens), { fillWidth: true })}`
    );
    lines.push(chalk.dim(`Legend     : ${this.renderContextSegmentLegend()}`));
    lines.push(
      `Focus      : live ask ${this.formatRatioPercent(latestUserShare)} of payload | history drag ${this.formatRatioPercent(
        turnDepthRatio
      )} | ${
        dominantSegment && dominantSegment.tokenCount > 0
          ? `${dominantSegment.label.toLowerCase()} lead at ${this.formatRatioPercent(dominantSegment.shareOfInput)}`
          : 'no meaningful context loaded yet'
      }`
    );
    lines.push(
      `Headroom   : ${this.formatTokenNumber(usableHeadroom)} tok before reserve | ${this.formatTokenNumber(
        hardHeadroom
      )} tok before hard cap | ${this.renderContextBudgetStatus(budgetUtilization, overflowTokens)}`
    );
    lines.push(
      chalk.dim(
        `Model      : ${contextLimit.model} | reserve ${this.formatTokenNumber(
          contextLimit.bufferTokens
        )} tok kept for reply/autocompact`
      )
    );
    lines.push('');
    lines.push(chalk.bold('Segments'));
    lines.push(chalk.bold('Segment              Tokens    Input  Window  Focus'));
    lines.push(chalk.dim('-'.repeat(72)));
    segments.forEach((segment) => {
      lines.push(this.renderContextSegmentRow(segment));
    });
    lines.push('');
    lines.push(chalk.bold('Top Context Drivers'));
    if (topDrivers.length === 0) {
      lines.push(chalk.dim('No prompt assets or live conversation context detected yet.'));
    } else {
      lines.push(chalk.bold('Source                        Tokens   Share  Kind'));
      lines.push(chalk.dim('-'.repeat(60)));
      topDrivers.forEach((driver, index) => {
        lines.push(this.renderContextDriverRow(driver, index));
      });
    }

    const recommendations = this.buildContextAnatomyRecommendations({
      segments,
      drivers: topDrivers,
      totalTokens,
      usableHeadroom,
      overflowTokens,
      latestUserShare,
      turnDepthRatio,
    });

    const summary = [
      `budget: ${this.formatTokenNumber(totalTokens)} / ${this.formatTokenNumber(
        contextLimit.usableContextTokens
      )} tok (${this.formatRatioPercent(budgetUtilization)} of safe window)`,
      `headroom: ${this.formatTokenNumber(usableHeadroom)} tok before reserve`,
      `dominant: ${dominantSegment?.label ?? 'none'} (${this.formatRatioPercent(dominantSegment?.shareOfInput ?? 0)})`,
      `liveAsk: ${this.formatRatioPercent(latestUserShare)} | historyDrag: ${this.formatRatioPercent(turnDepthRatio)}`,
      ...recommendations.map((item) => `action: ${item}`),
    ];

    return { lines, recommendations, summary };
  }

  private renderContextAnatomyView(view: ContextAnatomyView): void {
    console.log(
      boxen(view.lines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Context Anatomy ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      })
    );

    if (view.recommendations.length > 0) {
      console.log(chalk.cyan('  Actions'));
      view.recommendations.forEach((advice) => {
        console.log(chalk.cyan(`  - ${advice}`));
      });
    }
  }

  private classifyPromptAssetForAnatomy(file: {
    relativePath: string;
    categories: PromptAssetCategory[];
    tokenCount: number;
  }): 'system' | 'prompt_library' | 'reference_docs' {
    if (file.categories.includes('project-config') || file.categories.includes('system-prompt')) {
      return 'system';
    }
    if (file.categories.includes('prompt-file') || file.categories.includes('rules')) {
      return 'prompt_library';
    }
    return 'reference_docs';
  }

  private createContextAnatomyDriver(
    label: string,
    tokenCount: number,
    totalTokens: number,
    usableContextTokens: number,
    kind: string,
    colorize: (value: string) => string
  ): ContextAnatomyDriver {
    return {
      label,
      tokenCount,
      shareOfInput: totalTokens <= 0 ? 0 : tokenCount / totalTokens,
      shareOfWindow: usableContextTokens <= 0 ? 0 : tokenCount / usableContextTokens,
      kind,
      colorize,
    };
  }

  private describeContextSegment(
    key: ContextAnatomySegmentKey,
    stats: {
      tokenCount: number;
      shareOfInput: number;
      itemCount: number;
      totalTokens: number;
      latestUserShare: number;
      turnDepthRatio: number;
    }
  ): { note: string; severity: ContextActionSeverity } {
    if (stats.tokenCount <= 0) {
      switch (key) {
        case 'active_request':
          return { note: 'no live ask yet', severity: 'watch' };
        case 'chat_history':
          return { note: 'no prior turns', severity: 'stable' };
        default:
          return { note: 'not present', severity: 'stable' };
      }
    }

    switch (key) {
      case 'system':
        if (stats.shareOfInput >= 0.25 || stats.tokenCount >= 12000) {
          return { note: 'trim instruction sprawl', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.15) {
          return { note: 'keep stable, prune stale rules', severity: 'watch' };
        }
        return { note: 'stable prefix', severity: 'stable' };
      case 'prompt_library':
        if (stats.shareOfInput >= 0.25) {
          return { note: 'dedupe overlapping prompts', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.15) {
          return { note: 'watch for rule overlap', severity: 'watch' };
        }
        return { note: 'reusable prompt assets', severity: 'stable' };
      case 'reference_docs':
        if (stats.shareOfInput >= 0.25) {
          return { note: 'summarize before send', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.12) {
          return { note: 'attach narrower excerpts', severity: 'watch' };
        }
        return { note: 'cheap enough', severity: 'stable' };
      case 'chat_history':
        if (stats.turnDepthRatio > 0.85 || stats.shareOfInput >= 0.35) {
          return { note: 'roll up older turns', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.2) {
          return { note: 'watch drift and repeats', severity: 'watch' };
        }
        return { note: 'recent context only', severity: 'stable' };
      case 'active_request':
        if (stats.latestUserShare <= 0.08) {
          return { note: 'state output more clearly', severity: 'watch' };
        }
        return { note: 'goal is visible', severity: 'stable' };
      default:
        return { note: 'stable', severity: 'stable' };
    }
  }

  private buildContextAnatomyRecommendations(args: {
    segments: ContextAnatomySegment[];
    drivers: ContextAnatomyDriver[];
    totalTokens: number;
    usableHeadroom: number;
    overflowTokens: number;
    latestUserShare: number;
    turnDepthRatio: number;
  }): string[] {
    if (args.totalTokens <= 0) {
      return ['No prompt assets or live conversation context detected yet. Run /scan_prompt after you have a real request.'];
    }

    const recommendations: string[] = [];
    const largestTrimCandidate = args.segments
      .filter((segment) => segment.key !== 'active_request' && segment.tokenCount > 0)
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))[0];

    if (args.overflowTokens > 0) {
      recommendations.push(
        largestTrimCandidate
          ? `Cut at least ${this.formatTokenNumber(args.overflowTokens)} tok before the next send. Start with ${largestTrimCandidate.label.toLowerCase()} (${this.formatTokenNumber(
              largestTrimCandidate.tokenCount
            )} tok).`
          : `Cut at least ${this.formatTokenNumber(args.overflowTokens)} tok before the next send.`
      );
    } else if (args.usableHeadroom < 4000) {
      recommendations.push(
        `Only ${this.formatTokenNumber(args.usableHeadroom)} tok remain before the reserved buffer. Summarize history or docs before another long turn.`
      );
    } else {
      recommendations.push(
        `${this.formatTokenNumber(args.usableHeadroom)} tok of safe headroom remain, so the next gains are more about focus than raw overflow.`
      );
    }

    const dominantSegment = args.segments
      .filter((segment) => segment.key !== 'active_request' && segment.tokenCount > 0)
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))[0];

    if (dominantSegment && dominantSegment.shareOfInput >= 0.25) {
      const segmentAdvice: Record<Exclude<ContextAnatomySegmentKey, 'active_request'>, string> = {
        system: `Core instructions already take ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Tighten base rules before stacking more context.`,
        prompt_library: `Rules and prompt assets take ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Merge overlapping prompts before adding more.`,
        reference_docs: `Reference docs take ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Quote only the sections needed for this task.`,
        chat_history: `Chat history takes ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Replace older turns with a short recap.`,
      };
      if (dominantSegment.key !== 'active_request') {
        recommendations.push(segmentAdvice[dominantSegment.key]);
      }
    }

    if (args.turnDepthRatio > 0.85) {
      recommendations.push(
        `Older context dominates the window. The live ask is only ${this.formatRatioPercent(
          args.latestUserShare
        )} of the payload, so restate the goal and desired output format explicitly.`
      );
    } else if (args.latestUserShare > 0 && args.latestUserShare < 0.08) {
      recommendations.push(
        `The live ask is only ${this.formatRatioPercent(
          args.latestUserShare
        )} of the payload. Add a tighter goal line or checklist so it stays salient.`
      );
    }

    const largestDriver = args.drivers[0];
    if (largestDriver && largestDriver.shareOfInput >= 0.18 && largestDriver.kind !== 'Live ask') {
      recommendations.push(
        `Largest single context driver is ${largestDriver.label} (${this.formatTokenNumber(
          largestDriver.tokenCount
        )} tok). Make that cheaper before tuning smaller assets.`
      );
    }

    return Array.from(new Set(recommendations)).slice(0, 4);
  }

  private renderContextBudgetStatus(utilization: number, overflowTokens: number): string {
    if (overflowTokens > 0) {
      return chalk.red(`over safe budget by ${this.formatTokenNumber(overflowTokens)} tok`);
    }
    if (utilization >= 0.95) {
      return chalk.red('critical pressure');
    }
    if (utilization >= 0.85) {
      return chalk.yellow('warning pressure');
    }
    if (utilization >= 0.7) {
      return chalk.yellow('caution zone');
    }
    return chalk.green('healthy headroom');
  }

  private renderContextSegmentLegend(): string {
    return [
      `${chalk.blue('S')} core`,
      `${chalk.magenta('P')} prompts`,
      `${chalk.green('D')} docs`,
      `${chalk.yellow('H')} history`,
      `${chalk.white('U')} live ask`,
      `${chalk.dim('.')} free`,
    ].join(chalk.dim(' | '));
  }

  private renderContextSegmentRow(segment: ContextAnatomySegment): string {
    const labelText = segment.label.padEnd(20, ' ');
    const label = segment.tokenCount > 0 ? segment.colorize(labelText) : chalk.gray(labelText);
    const tokens = this.formatTokenNumber(segment.tokenCount).padStart(8, ' ');
    const inputShare = this.formatRatioPercent(segment.shareOfInput).padStart(6, ' ');
    const windowShare = this.formatRatioPercent(segment.shareOfWindow).padStart(6, ' ');
    const note = this.colorizeContextSeverity(segment.note, segment.severity);
    return `${label}  ${tokens}  ${chalk.dim(inputShare)}  ${chalk.dim(windowShare)}  ${note}`;
  }

  private renderContextDriverRow(driver: ContextAnatomyDriver, index: number): string {
    const rank = `${index + 1}.`.padStart(3, ' ');
    const source = this.truncateBlockName(driver.label, 28).padEnd(28, ' ');
    const tokens = this.formatTokenNumber(driver.tokenCount).padStart(8, ' ');
    const share = this.formatRatioPercent(driver.shareOfInput).padStart(6, ' ');
    return `${chalk.dim(rank)} ${driver.colorize(source)}  ${tokens}  ${chalk.dim(share)}  ${chalk.gray(driver.kind)}`;
  }

  private renderStackedContextBar(
    segments: ContextAnatomySegment[],
    totalTokens: number,
    denominator: number,
    options?: { fillWidth?: boolean }
  ): string {
    const width = CommandHandler.ANATOMY_BAR_WIDTH;
    if (width <= 0) {
      return '';
    }
    if (totalTokens <= 0 || denominator <= 0) {
      return chalk.dim('.'.repeat(width));
    }

    const normalizedFill = options?.fillWidth ? 1 : Math.max(0, Math.min(1, totalTokens / denominator));
    const filledWidth = normalizedFill > 0 ? Math.max(1, Math.round(normalizedFill * width)) : 0;
    const segmentWidths = this.allocateBarWidths(
      segments.map((segment) => segment.tokenCount),
      filledWidth
    );

    const filled = segments
      .map((segment, index) => {
        const count = segmentWidths[index] ?? 0;
        return count > 0 ? segment.colorize(segment.barChar.repeat(count)) : '';
      })
      .join('');
    const empty = chalk.dim('.'.repeat(Math.max(0, width - filledWidth)));
    const overflowSuffix =
      !options?.fillWidth && totalTokens > denominator
        ? chalk.red(` +${this.formatTokenNumber(totalTokens - denominator)} overflow`)
        : '';

    return `${filled}${empty}${overflowSuffix}`;
  }

  private allocateBarWidths(values: number[], totalWidth: number): number[] {
    if (totalWidth <= 0 || values.length === 0) {
      return values.map(() => 0);
    }

    const positiveValues = values.map((value) => Math.max(0, value));
    const total = positiveValues.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return values.map(() => 0);
    }

    const baseWidths = positiveValues.map((value) => Math.floor((value / total) * totalWidth));
    let assigned = baseWidths.reduce((sum, value) => sum + value, 0);
    const remainders = positiveValues
      .map((value, index) => ({
        index,
        remainder: (value / total) * totalWidth - baseWidths[index],
      }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

    let cursor = 0;
    while (assigned < totalWidth && cursor < remainders.length) {
      baseWidths[remainders[cursor].index] += 1;
      assigned += 1;
      cursor += 1;
    }

    return baseWidths;
  }

  private colorizeContextSeverity(value: string, severity: ContextActionSeverity): string {
    if (severity === 'trim') {
      return chalk.red(value);
    }
    if (severity === 'watch') {
      return chalk.yellow(value);
    }
    return chalk.green(value);
  }

  private formatRatioPercent(value: number): string {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    const percent = safeValue * 100;
    if (percent >= 10 || percent === 0) {
      return `${Math.round(percent)}%`;
    }
    return `${percent.toFixed(1)}%`;
  }

  private async resolveContextAnatomyLimit(): Promise<{
    model: string;
    contextWindowTokens: number;
    bufferTokens: number;
    usableContextTokens: number;
  }> {
    let model = 'unknown';
    try {
      const config = await this.configStore.getConfig();
      model = config.providers[config.activeProvider]?.model?.trim() || 'unknown';
    } catch {
      model = 'unknown';
    }
    const contextWindowTokens = this.estimateContextWindowTokens(model);
    const bufferTokens = Math.round(contextWindowTokens * CommandHandler.AUTOCOMPACT_BUFFER_RATIO);
    const usableContextTokens = Math.max(1, contextWindowTokens - bufferTokens);
    return { model, contextWindowTokens, bufferTokens, usableContextTokens };
  }

  private async resolveClaudeProjectDirectories(projectsRoot: string, rootPath: string): Promise<string[]> {
    const normalizedRoot = path.resolve(rootPath);
    const projectEntries = await this.listClaudeProjectDirEntries(projectsRoot);
    if (projectEntries.length === 0) {
      return [];
    }

    const exactMatches = this.findClaudeProjectExactMatches(projectsRoot, projectEntries, normalizedRoot);
    if (exactMatches.length > 0) {
      return exactMatches;
    }

    const fallback: string[] = [];
    const seen = new Set<string>();
    for (const candidateRoot of this.buildPathAncestors(normalizedRoot)) {
      const baseName = path.basename(candidateRoot).toLowerCase();
      if (!baseName) {
        continue;
      }

      for (const entry of projectEntries) {
        const name = entry.name.toLowerCase();
        if (!name.endsWith(`-${baseName}`)) {
          continue;
        }
        const fullPath = path.join(projectsRoot, entry.name);
        if (seen.has(fullPath)) {
          continue;
        }
        seen.add(fullPath);
        fallback.push(fullPath);
      }
    }

    if (fallback.length > 0) {
      return fallback.slice(0, 3);
    }

    const scored = projectEntries
      .map((entry) => ({
        fullPath: path.join(projectsRoot, entry.name),
        score: this.scoreClaudeProjectDirMatch(entry.name, normalizedRoot),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.fullPath.localeCompare(b.fullPath));

    if (scored.length === 0) {
      return fallback;
    }

    return scored.slice(0, 3).map((candidate) => candidate.fullPath);
  }

  private async listClaudeProjectDirEntries(projectsRoot: string): Promise<Array<{ name: string }>> {
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name }));
    } catch {
      return [];
    }
  }

  private async resolveClaudeTokenScanTarget(request: TokenScanRequest): Promise<TokenScanTarget> {
    const projectsRoot = await this.resolveClaudeDataDirectory('projects');
    if (!projectsRoot || !(await this.pathExists(projectsRoot))) {
      return {
        source: 'claude',
        scopeLabel: request.scope === 'all' ? 'all_projects' : 'current_project',
        sourceLabel: projectsRoot ?? path.join(os.homedir(), '.claude', 'projects'),
        projectDirs: [],
        filePaths: [],
      };
    }

    const projectDirs =
      request.scope === 'all'
        ? await this.listClaudeProjectDirectories(projectsRoot)
        : await this.resolveClaudeProjectDirectories(projectsRoot, process.cwd());

    const uniqueFiles = new Set<string>();
    const filePaths: string[] = [];
    const perProjectLimit =
      request.scope === 'all'
        ? CommandHandler.MAX_TOKEN_SCAN_FILES_PER_PROJECT_ALL
        : CommandHandler.MAX_TOKEN_SCAN_FILES_PER_PROJECT;

    for (const projectDir of projectDirs) {
      const files = await this.listRecentJsonlFiles(projectDir, perProjectLimit);
      for (const filePath of files) {
        if (uniqueFiles.has(filePath)) {
          continue;
        }
        uniqueFiles.add(filePath);
        filePaths.push(filePath);
        if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
          break;
        }
      }
      if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
        break;
      }
    }

    return {
      source: 'claude',
      scopeLabel: request.scope === 'all' ? 'all_projects' : 'current_project',
      sourceLabel: request.scope === 'all' ? projectsRoot : path.resolve(process.cwd()),
      projectDirs,
      filePaths,
    };
  }

  private async resolveCodexTokenScanTarget(request: TokenScanRequest): Promise<TokenScanTarget> {
    const sessionsRoot = await this.resolveCodexDataDirectory('sessions');
    if (!sessionsRoot || !(await this.pathExists(sessionsRoot))) {
      return {
        source: 'codex',
        scopeLabel: request.scope === 'all' ? 'all_sessions' : 'current_project',
        sourceLabel: sessionsRoot ?? path.join(os.homedir(), '.codex', 'sessions'),
        projectDirs: [],
        filePaths: [],
      };
    }

    const allFiles = await this.listRecentCodexRolloutFiles(sessionsRoot, CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL * 4);
    const currentWorkspace = path.resolve(process.cwd());
    const filePaths: string[] = [];
    for (const filePath of allFiles) {
      if (request.scope === 'current') {
        const sessionCwd = await this.readCodexSessionCwd(filePath);
        if (!sessionCwd || !this.pathsAreRelated(sessionCwd, currentWorkspace)) {
          continue;
        }
      }
      filePaths.push(filePath);
      if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
        break;
      }
    }

    return {
      source: 'codex',
      scopeLabel: request.scope === 'all' ? 'all_sessions' : 'current_project',
      sourceLabel: request.scope === 'all' ? sessionsRoot : currentWorkspace,
      projectDirs: request.scope === 'all' ? [sessionsRoot] : [currentWorkspace],
      filePaths,
    };
  }

  private async resolveCursorTokenScanTarget(request: TokenScanRequest): Promise<TokenScanTarget> {
    const projectsRoot = await this.resolveCursorDataDirectory('projects');
    if (!projectsRoot || !(await this.pathExists(projectsRoot))) {
      return {
        source: 'cursor',
        scopeLabel: request.scope === 'all' ? 'all_projects' : 'current_project',
        sourceLabel: projectsRoot ?? path.join(os.homedir(), '.cursor', 'projects'),
        projectDirs: [],
        filePaths: [],
      };
    }

    const projectDirs =
      request.scope === 'all'
        ? await this.listCursorProjectDirectories(projectsRoot)
        : await this.resolveCursorProjectDirectories(projectsRoot, process.cwd());

    const uniqueFiles = new Set<string>();
    const filePaths: string[] = [];
    const perProjectLimit =
      request.scope === 'all'
        ? CommandHandler.MAX_TOKEN_SCAN_FILES_PER_PROJECT_ALL
        : CommandHandler.MAX_TOKEN_SCAN_FILES_PER_PROJECT;

    for (const projectDir of projectDirs) {
      const files = await this.listRecentCursorTranscriptFiles(projectDir, perProjectLimit);
      for (const filePath of files) {
        if (uniqueFiles.has(filePath)) {
          continue;
        }
        uniqueFiles.add(filePath);
        filePaths.push(filePath);
        if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
          break;
        }
      }
      if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
        break;
      }
    }

    return {
      source: 'cursor',
      scopeLabel: request.scope === 'all' ? 'all_projects' : 'current_project',
      sourceLabel: request.scope === 'all' ? projectsRoot : path.resolve(process.cwd()),
      projectDirs,
      filePaths,
    };
  }

  private async listRecentCodexRolloutFiles(rootPath: string, limit: number): Promise<string[]> {
    const queue = [rootPath];
    const files: Array<{ fullPath: string; mtimeMs: number }> = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }> = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) {
          continue;
        }
        if (!/^rollout-.*\.jsonl$/i.test(entry.name)) {
          continue;
        }
        try {
          const stat = await fs.stat(fullPath);
          files.push({ fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }

    return files
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, limit))
      .map((item) => item.fullPath);
  }

  private async listRecentCursorTranscriptFiles(projectDir: string, limit: number): Promise<string[]> {
    const transcriptsRoot = path.join(projectDir, 'agent-transcripts');
    const queue = [transcriptsRoot];
    const files: Array<{ fullPath: string; mtimeMs: number }> = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }> = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }

        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) {
          continue;
        }

        try {
          const stat = await fs.stat(fullPath);
          files.push({ fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }

    return files
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, limit))
      .map((item) => item.fullPath);
  }

  private async readCodexSessionCwd(filePath: string): Promise<string> {
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return '';
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 80);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const cwd = this.getStringAtPaths(parsed, [['payload', 'cwd']]) ?? this.getStringAtPaths(parsed, [['cwd']]);
      if (cwd) {
        return path.resolve(cwd);
      }
    }
    return '';
  }

  private async detectTranscriptSourceFromPath(inputPath: string, fallback: TokenScanSource): Promise<TokenScanSource> {
    const normalizedPath = inputPath.replace(/\\/g, '/').toLowerCase();
    if (normalizedPath.includes('/.codex/sessions/') || normalizedPath.includes('/.codex/archived_sessions/')) {
      return 'codex';
    }
    if (normalizedPath.includes('/.cursor/projects/') || normalizedPath.includes('/agent-transcripts/')) {
      return 'cursor';
    }
    if (normalizedPath.includes('/.claude/')) {
      return 'claude';
    }

    let stat;
    try {
      stat = await fs.stat(inputPath);
    } catch {
      return fallback;
    }

    const probeFile = stat.isFile()
      ? inputPath
      : (await this.listRecentCodexRolloutFiles(inputPath, 1))[0] ??
        (await this.listRecentCursorTranscriptFiles(inputPath, 1))[0] ??
        (await this.listRecentJsonlFiles(inputPath, 1))[0];
    if (!probeFile) {
      return fallback;
    }

    let raw = '';
    try {
      raw = await fs.readFile(probeFile, 'utf8');
    } catch {
      return fallback;
    }

    const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) {
      return fallback;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine) as unknown;
    } catch {
      return fallback;
    }

    const topType = this.getStringAtPaths(parsed, [['type']])?.toLowerCase() ?? '';
    return topType === 'session_meta' || topType === 'turn_context' || topType === 'response_item' || topType === 'event_msg'
      ? 'codex'
      : this.getStringAtPaths(parsed, [['role']]) && this.getValueAtPath(parsed, ['message', 'content']) !== null
        ? 'cursor'
      : fallback;
  }

  private pathsAreRelated(leftPath: string, rightPath: string): boolean {
    const left = path.resolve(leftPath).toLowerCase();
    const right = path.resolve(rightPath).toLowerCase();
    const sep = path.sep.toLowerCase();
    return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
  }

  private findClaudeProjectExactMatches(
    projectsRoot: string,
    projectEntries: Array<{ name: string }>,
    rootPath: string
  ): string[] {
    const ancestors = this.buildPathAncestors(rootPath);
    const entryMap = new Map(projectEntries.map((entry) => [entry.name.toLowerCase(), entry.name]));

    for (const candidateRoot of ancestors) {
      for (const candidateName of this.buildClaudeProjectPathCandidates(candidateRoot)) {
        const matched = entryMap.get(candidateName.toLowerCase());
        if (matched) {
          return [path.join(projectsRoot, matched)];
        }
      }
    }

    return [];
  }

  private buildPathAncestors(inputPath: string): string[] {
    const ancestors: string[] = [];
    let current = path.resolve(inputPath);
    while (true) {
      ancestors.push(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return ancestors;
  }

  private buildClaudeProjectPathCandidates(inputPath: string): string[] {
    const resolved = path.resolve(inputPath);
    const percentEncoded = this.encodeClaudeProjectPath(resolved);
    const legacyDashed = resolved.replace(/[\\/:]/g, '-');
    return Array.from(new Set([percentEncoded, legacyDashed]));
  }

  private scoreClaudeProjectDirMatch(entryName: string, rootPath: string): number {
    const normalizedEntry = entryName.toLowerCase();
    let bestScore = 0;

    for (const candidateRoot of this.buildPathAncestors(rootPath)) {
      const legacyDashed = candidateRoot.replace(/[\\/:]/g, '-').toLowerCase();
      const baseName = path.basename(candidateRoot).toLowerCase();
      let score = 0;

      if (legacyDashed && normalizedEntry === legacyDashed) {
        score += 100;
      } else if (legacyDashed && normalizedEntry.endsWith(legacyDashed)) {
        score += 60;
      }

      if (baseName && normalizedEntry.endsWith(`-${baseName}`)) {
        score += 15;
      }

      const rootParts = candidateRoot
        .toLowerCase()
        .split(/[\\/]+/)
        .filter(Boolean)
        .slice(-3);
      const tailHits = rootParts.filter((part) => normalizedEntry.includes(part)).length;
      score += tailHits * 5;

      if (score > bestScore) {
        bestScore = score;
      }
    }

    return bestScore;
  }

  private normalizeCursorProjectKey(value: string): string {
    return path
      .resolve(value)
      .replace(/\\/g, '/')
      .replace(/:/g, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  }

  private scoreCursorProjectDirMatch(entryName: string, rootPath: string): number {
    const normalizedEntry = this.normalizeCursorProjectKey(entryName);
    const candidates = this.buildPathAncestors(rootPath).map((candidateRoot) => this.normalizeCursorProjectKey(candidateRoot));

    if (candidates.includes(normalizedEntry)) {
      return 100;
    }

    let bestScore = 0;
    for (const candidate of candidates) {
      let score = 0;
      if (normalizedEntry.endsWith(candidate)) {
        score += 60;
      }

      const candidateParts = candidate.split('-').filter(Boolean);
      const matchedParts = candidateParts.filter((part) => normalizedEntry.includes(part)).length;
      score += matchedParts * 6;

      if (score > bestScore) {
        bestScore = score;
      }
    }

    return bestScore;
  }

  private async listRecentJsonlFiles(
    projectDir: string,
    limit: number = CommandHandler.MAX_CLAUDE_HISTORY_FILES
  ): Promise<string[]> {
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
          .map(async (entry) => {
            const fullPath = path.join(projectDir, entry.name);
            try {
              const stat = await fs.stat(fullPath);
              return { fullPath, mtimeMs: stat.mtimeMs };
            } catch {
              return null;
            }
          })
      );

      return files
        .filter((item): item is { fullPath: string; mtimeMs: number } => item !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, Math.max(1, limit))
        .map((item) => item.fullPath);
    } catch {
      return [];
    }
  }

  private async readChatTurnsFromJsonl(filePath: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const result: Array<{ role: 'user' | 'assistant'; text: string }> = [];

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      const item = this.extractClaudeChatItem(parsed);
      if (!item) {
        continue;
      }

      result.push(item);
      if (result.length >= CommandHandler.MAX_CLAUDE_HISTORY_ITEMS) {
        break;
      }
    }

    return result;
  }

  private async readChatItemsFromJsonl(filePath: string): Promise<string[]> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const result: string[] = [];

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      const item = this.extractClaudeChatItem(parsed);
      if (!item) {
        continue;
      }

      result.push(`[${item.role}] ${item.text}`);
      if (result.length >= CommandHandler.MAX_CLAUDE_HISTORY_ITEMS) {
        break;
      }
    }

    return result;
  }

  private extractClaudeChatItem(payload: unknown): { role: 'user' | 'assistant'; text: string } | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const topType = typeof record.type === 'string' ? record.type : '';
    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const roleRaw = typeof message?.role === 'string' ? message.role : topType;
    const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : null;
    if (!role) {
      return null;
    }

    const content = this.extractClaudeContentText(message?.content);
    if (!content) {
      return null;
    }

    return { role, text: content };
  }

  private extractClaudeContentText(content: unknown): string {
    if (typeof content === 'string') {
      return this.compactHistoryText(content);
    }

    if (!Array.isArray(content)) {
      return '';
    }

    const segments: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';

      if (type === 'text' && typeof record.text === 'string') {
        segments.push(record.text);
        continue;
      }

      if (type === 'tool_result' && typeof record.content === 'string') {
        segments.push(record.content);
        continue;
      }

      if (typeof record.content === 'string') {
        segments.push(record.content);
      }
    }

    return this.compactHistoryText(segments.join('\n'));
  }

  private compactHistoryText(input: string): string {
    const normalized = input.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) {
      return '';
    }

    const maxChars = 900;
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars)}...(truncated)`;
  }

  private encodeClaudeProjectPath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    // Use a collision-safe encoding: percent-encode separators so that
    // "/foo/bar" and "/foo-bar" can never produce the same output.
    return resolved.replace(/[\\/:]/g, (ch) =>
      ch === '\\' ? '%5C' : ch === '/' ? '%2F' : '%3A'
    );
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private truncateBlockName(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    const fileName = path.basename(value);
    if (fileName.length <= maxLength) {
      return fileName;
    }
    if (maxLength <= 3) {
      return fileName.slice(0, maxLength);
    }
    return `${fileName.slice(0, maxLength - 3)}...`;
  }

  private createAnatomyBucket(
    name: string,
    tokenCount: number,
    denominator: number,
    colorize: (value: string) => string,
    options?: { fillChar?: '█' | '▓'; warning?: boolean }
  ): AnatomyBucket {
    return {
      name,
      tokenCount,
      percent: denominator <= 0 ? 0 : Math.round((tokenCount / denominator) * 100),
      colorize,
      fillChar: options?.fillChar,
      warning: options?.warning,
    };
  }

  private renderAnatomyRow(bucket: AnatomyBucket): string {
    const fillChar = bucket.fillChar ?? '█';
    const barLen = bucket.tokenCount > 0 ? Math.max(1, Math.round((bucket.percent / 100) * CommandHandler.ANATOMY_BAR_WIDTH)) : 0;
    const filled = barLen > 0 ? bucket.colorize(fillChar.repeat(barLen)) : '';
    const empty = chalk.dim('░'.repeat(Math.max(0, CommandHandler.ANATOMY_BAR_WIDTH - barLen)));
    const bar = `${filled}${empty}`;
    const label = bucket.name.padEnd(14, ' ');
    const tokenText = this.formatTokenNumber(bucket.tokenCount).padStart(9, ' ');
    const percentText = bucket.warning ? ' WARN' : `${bucket.percent}%`.padStart(5, ' ');
    const percentStyled = bucket.warning ? chalk.red(percentText) : chalk.dim(percentText);
    const labelStyled = bucket.warning ? chalk.red(label) : chalk.gray(label);

    return `${labelStyled}  ${tokenText} tok  ${percentStyled}  ${bar}`;
  }

  private truncatePathForAnatomy(relativePath: string): string {
    if (relativePath.length <= 28) {
      return relativePath;
    }
    return `...${relativePath.slice(-25)}`;
  }

  private formatStateLine(
    label: string,
    value: string,
    tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default' = 'default',
    note?: string
  ): string {
    const labelText = chalk.gray(`${label.padEnd(13)} `);
    const valueText = this.colorizeStateValue(value, tone);
    return note ? `${labelText}${valueText} ${chalk.dim(`(${note})`)}` : `${labelText}${valueText}`;
  }

  private colorizeStateValue(
    value: string,
    tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default'
  ): string {
    switch (tone) {
      case 'accent':
        return chalk.cyan(value);
      case 'success':
        return chalk.green(value);
      case 'warning':
        return chalk.yellow(value);
      case 'danger':
        return chalk.red(value);
      case 'muted':
        return chalk.gray(value);
      default:
        return chalk.white(value);
    }
  }

  private formatPathForState(value: string): string {
    return path.resolve(value);
  }

  private summarizeProviderConfigSource(sources: ProviderConfigSources): string {
    const runtimeSources = Array.from(
      new Set(
        [sources.apiKey, sources.baseUrl, sources.model].filter(
          (item): item is 'session' | 'env' | 'local' => item === 'session' || item === 'env' || item === 'local'
        )
      )
    );

    if (runtimeSources.length === 0) {
      return 'not configured';
    }

    if (runtimeSources.length === 1) {
      return this.describeRuntimeSource(runtimeSources[0]);
    }

    return `mixed (${runtimeSources.map((item) => this.describeRuntimeSource(item)).join(' + ')})`;
  }

  private describeRuntimeSource(source: 'session' | 'env' | 'local'): string {
    if (source === 'session') {
      return 'session override';
    }

    if (source === 'env') {
      return 'environment';
    }

    return 'local config file';
  }

  private describeConfigValueSource(source: ConfigValueSource): string {
    switch (source) {
      case 'session':
        return 'session override';
      case 'env':
        return 'environment';
      case 'local':
        return 'local config file';
      case 'default':
        return 'provider default';
      default:
        return 'not set';
    }
  }

  private getSessionOverrideLabels(sources: ProviderConfigSources): string[] {
    const labels: string[] = [];

    if (sources.apiKey === 'session') {
      labels.push('API Key');
    }

    if (sources.baseUrl === 'session') {
      labels.push('Base URL');
    }

    if (sources.model === 'session') {
      labels.push('Model');
    }

    return labels;
  }

  private recordCommandData(command: string, data: string): void {
    this.onCommandDataGenerated(command, data);
  }
}
