import readline from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';
import { render } from 'ink';
import { createElement } from 'react';
import { ConversationManager } from './ConversationManager.js';
import { CommandHandler } from './CommandHandler.js';
import { UIRenderer } from './UIRenderer.js';
import { CommandRegistry } from './CommandRegistry.js';
import { AutoCompleter } from './AutoCompleter.js';
import { Spinner } from './Spinner.js';
import { ConfigDiagnostics, ConfigStore, ProviderConfigSources } from './ConfigStore.js';
import { getProviderMeta, ProviderName, PROVIDER_NAMES } from '../config/providerCatalog.js';
import { LLMClient } from '../llm/LLMClient.js';
import { createDefaultAdapters } from '../llm/adapters/createDefaultAdapters.js';
import { LLMAdapter } from '../llm/adapters/types.js';
import { TrustDecision, TrustPrompt } from './ink/TrustPrompt.js';

export class CLI {
  private static readonly EXIT_CONFIRM_WINDOW_MS = 3000;
  private conversationManager: ConversationManager;
  private commandHandler: CommandHandler;
  private uiRenderer: UIRenderer;
  private commandRegistry: CommandRegistry;
  private autoCompleter: AutoCompleter;
  private inlineSuggestionLines = 0;
  private lastInlineSuggestionQuery = '';
  private promptVisibleLines = 0;
  private inputValue = '';
  private inputCursor = 0;
  private inputHistory: string[] = [];
  private historyIndex = -1;
  private historyDraftValue = '';
  private readonly promptPrefix = '> ';
  private readonly promptPlaceholder = 'Type a message or / for commands';
  private readonly homeAccent = chalk.hex('#D6F54A');
  private readonly homePanelBorder = chalk.hex('#5E6575');
  private readonly homeMuted = chalk.hex('#9299A8');
  private readonly homeTitle = chalk.hex('#F5F7FA');
  private readonly homeSuccess = chalk.hex('#8CE36B');
  private readonly homeWarning = chalk.hex('#F0C35C');
  private readonly homeDanger = chalk.hex('#FF7A72');
  private readonly internalBuildVersion = this.readPackageVersion();
  private configStore: ConfigStore;
  private llmClient: LLMClient;
  private readonly adaptersByProvider: Map<ProviderName, LLMAdapter>;
  private isInteractiveCommandActive = false;
  private commandDataHistory: Array<{ timestamp: Date; command: string; data: string }> = [];
  private isLineProcessing = false;
  private pendingExitConfirmationUntil = 0;
  private pendingExitConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
  private exitConfirmationNoticeVisible = false;
  private activeDetailPageContext: { command: string; dialogueTurns: number } | null = null;
  private isReturningFromDetailPage = false;
  private readonly onInputAssistKeypress = (str: string, key: readline.Key): void => {
    if (!(key.ctrl && key.name === 'c') && this.hasPendingExitConfirmation()) {
      this.clearPendingExitConfirmation(true);
    }

    if (!this.canInteractWithInput()) {
      return;
    }

    if (key.ctrl && key.name === 'c') {
      void this.handleSigint();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      void this.submitCurrentInput();
      return;
    }

    if (key.name === 'escape') {
      this.autoCompleter.resetSuggestions();
      this.renderPromptArea();
      return;
    }

    if (this.shouldUseCommandSuggestionNavigation(key)) {
      if (key.name === 'up') {
        this.autoCompleter.previousSuggestion();
      } else {
        this.autoCompleter.nextSuggestion();
      }
      this.renderPromptArea();
      return;
    }

    if ((key.name === 'up' || key.name === 'down') && this.navigateHistory(key.name === 'up' ? -1 : 1)) {
      this.renderPromptArea();
      return;
    }

    if (key.name === 'tab') {
      const completion = this.autoCompleter.getHighlightedCompletion(this.getCurrentReadlineInput().trimStart());
      if (completion) {
        this.setReadlineInput(completion);
        this.renderPromptArea();
        return;
      }
    }

    if ((key.ctrl && key.name === 'a') || key.name === 'home') {
      this.inputCursor = 0;
      this.renderPromptArea();
      return;
    }

    if ((key.ctrl && key.name === 'e') || key.name === 'end') {
      this.inputCursor = this.getInputCharCount();
      this.renderPromptArea();
      return;
    }

    if (key.ctrl && key.name === 'u') {
      this.setReadlineInput('');
      this.renderPromptArea();
      return;
    }

    if (key.ctrl && key.name === 'l') {
      this.resetTerminalView();
      this.renderPromptArea();
      return;
    }

    if (key.name === 'left' && this.moveInputCursor(-1)) {
      this.renderPromptArea();
      return;
    }

    if (key.name === 'right' && this.moveInputCursor(1)) {
      this.renderPromptArea();
      return;
    }

    if (key.name === 'backspace' && this.deleteInputBeforeCursor()) {
      this.renderPromptArea();
      return;
    }

    if (key.name === 'delete' && this.deleteInputAtCursor()) {
      this.renderPromptArea();
      return;
    }

    if (this.isPrintableInput(str, key)) {
      this.insertTextAtCursor(str);
      this.renderPromptArea();
    }
  };

  constructor() {
    this.commandRegistry = new CommandRegistry();
    this.autoCompleter = new AutoCompleter(this.commandRegistry);
    this.conversationManager = new ConversationManager();
    this.uiRenderer = new UIRenderer(this.conversationManager);
    this.configStore = new ConfigStore();
    const adapters = createDefaultAdapters();
    this.adaptersByProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.llmClient = new LLMClient(this.configStore, adapters, this.buildCommandDataContext.bind(this));

    this.commandHandler = new CommandHandler(
      this.conversationManager,
      this.uiRenderer,
      this.commandRegistry,
      this.startModelSwitchFlow.bind(this),
      this.handleProviderSwitch.bind(this),
      this.recordCommandData.bind(this),
      this.handleProjectContextCommand.bind(this),
      this.trustCurrentPath.bind(this),
      this.checkCurrentPathTrust.bind(this)
    );
  }

  async start() {
    this.resetTerminalView();

    const canStart = await this.ensureWorkspaceTrustBeforeStart();
    if (!canStart) {
      process.exit(0);
    }

    await this.showWelcome();
    this.setupReadline();
    this.applyBlockCursorStyle();
    this.showPrompt();
  }

  private getPromptText(): string {
    return this.promptPrefix;
  }

  private showPrompt(): void {
    if (!process.stdout.isTTY) {
      return;
    }
    this.renderPromptArea();
  }

  private resetTerminalView(): void {
    if (process.stdout.isTTY) {
      // Clear screen + scrollback, then move cursor to top-left.
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      return;
    }
    console.clear();
  }

  private async showWelcome(): Promise<void> {
    console.clear();
    this.inlineSuggestionLines = 0;
    this.lastInlineSuggestionQuery = '';
    this.promptVisibleLines = 0;
    this.activeDetailPageContext = null;

    const windowWidth = this.getHomeWindowWidth();
    const panelContentWidth = Math.max(30, windowWidth - 4);
    const [configLines, projectContextLines, trustLines] = await Promise.all([
      this.getHomeConfigStatusLines(panelContentWidth),
      this.getHomeProjectContextStatusLines(panelContentWidth),
      this.getHomeTrustStatusLines(panelContentWidth),
    ]);

    if (!process.stdout.isTTY || windowWidth < 72) {
      await this.showCompactWelcome(configLines, projectContextLines, trustLines);
      return;
    }

    const workspaceLines = [...projectContextLines, ...trustLines];
    const bodyLines = [
      ...this.buildHomeHeroLines(windowWidth),
      '',
      ...this.buildHomeSection('Runtime', configLines, windowWidth),
      '',
      ...this.buildHomeSection('Workspace', workspaceLines, windowWidth),
      '',
      ...this.buildHomeSection('Quick Start', this.getHomeQuickStartLines(panelContentWidth), windowWidth),
    ];

    console.log('');
    this.renderHomeWindow(bodyLines, windowWidth);
    console.log('');
  }

  private async showCompactWelcome(
    configLines: string[],
    projectContextLines: string[],
    trustLines: string[]
  ): Promise<void> {
    console.log('');
    console.log(this.homeTitle.bold('  Odradek'));
    console.log(`  ${this.homeAccent('='.repeat(Math.min(40, Math.max(18, (process.stdout.columns ?? 80) - 6))))}`);
    console.log('');

    const sections: Array<{ title: string; lines: string[] }> = [
      { title: 'Runtime', lines: configLines },
      { title: 'Workspace', lines: [...projectContextLines, ...trustLines] },
      { title: 'Quick Start', lines: this.getHomeQuickStartLines(Math.max(24, (process.stdout.columns ?? 80) - 6)) },
    ];

    sections.forEach((section) => {
      console.log(this.homeTitle.bold(`  ${section.title}`));
      section.lines.forEach((line) => console.log(`  ${line}`));
      console.log('');
    });
  }

  private getHomeWindowWidth(): number {
    const columns = process.stdout.columns ?? 88;
    return Math.max(60, Math.min(104, columns - 6));
  }

  private renderHomeWindow(bodyLines: string[], width: number): void {
    bodyLines.forEach((line) => {
      console.log(`  ${line}`);
    });
  }

  private buildHomeHeroLines(width: number): string[] {
    return [this.buildHomeHeaderLine(width), ...this.buildHomeSignalStrip(width)];
  }

  private buildHomeHeaderLine(width: number): string {
    const titleText = 'ODRADEK';
    const title = this.homeTitle.bold(titleText);
    const buildText = `Internal build: ${this.internalBuildVersion}`;
    const buildLabel = this.homeMuted(buildText);
    const gapWidth = Math.max(1, width - this.getDisplayWidth(titleText) - this.getDisplayWidth(buildText));
    return `${title}${' '.repeat(gapWidth)}${buildLabel}`;
  }

  private buildHomeSignalStrip(width: number): string[] {
    const palette = ['#3A4311', '#596A17', '#7F971E', '#AAC52B', '#D7F54A'];
    const glyphs = ['░', '░', '▒', '▓', '█'];

    return Array.from({ length: 3 }, (_unused, rowIndex) => {
      let line = '';
      for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
        const wave = Math.sin(columnIndex / 3.6 + rowIndex * 0.85);
        const ripple = Math.cos(columnIndex / 10.5 - rowIndex * 0.75);
        const focusBoost = columnIndex < width * 0.22 ? 0.22 : columnIndex > width * 0.74 ? 0.18 : 0;
        const intensity = Math.max(0.08, Math.min(0.98, 0.46 + wave * 0.22 + ripple * 0.18 + focusBoost));
        const colorIndex = Math.min(palette.length - 1, Math.floor(intensity * palette.length));
        const glyphIndex = Math.min(glyphs.length - 1, Math.floor(intensity * glyphs.length));
        line += chalk.hex(palette[colorIndex])(glyphs[glyphIndex]);
      }
      return line;
    });
  }

  private buildHomeSection(title: string, lines: string[], width: number): string[] {
    const titleText = title.toUpperCase();
    const topFill = Math.max(0, width - this.getDisplayWidth(titleText) - 5);
    return [
      this.homePanelBorder('┌─ ') + this.homeTitle.bold(titleText) + this.homePanelBorder(` ${'─'.repeat(topFill)}┐`),
      ...lines.map((line) => `${this.homePanelBorder('│ ')}${this.padAnsiText(line, width - 4)}${this.homePanelBorder(' │')}`),
      this.homePanelBorder(`└${'─'.repeat(width - 2)}┘`),
    ];
  }

  private getHomeQuickStartLines(width: number): string[] {
    return [
      this.formatHomeKeyValueLine('chat', 'Type anything below to start a conversation', width, 'muted'),
      this.formatHomeKeyValueLine('commands', '/ opens the command palette and type /help to see all commands', width, 'accent')
    ];
  }

  private formatHomeKeyValueLine(
    label: string,
    value: string,
    width: number,
    tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default' = 'default'
  ): string {
    const normalizedLabel = `${label.padEnd(13)} `;
    const valueWidth = Math.max(8, width - this.getDisplayWidth(normalizedLabel));
    return this.homeMuted(normalizedLabel) + this.colorizeHomeValue(this.truncatePlainText(value, valueWidth), tone);
  }

  private formatHomeParallelKeyValueLines(
    left: {
      label: string;
      value: string;
      tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default';
    },
    right: {
      label: string;
      value: string;
      tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default';
    },
    width: number
  ): string[] {
    if (width < 56) {
      return [
        this.formatHomeKeyValueLine(left.label, left.value, width, left.tone),
        this.formatHomeKeyValueLine(right.label, right.value, width, right.tone),
      ];
    }

    const gap = 4;
    const leftWidth = Math.max(18, Math.floor((width - gap) / 2));
    const rightWidth = Math.max(18, width - gap - leftWidth);
    const leftLine = this.formatHomeKeyValueLine(left.label, left.value, leftWidth, left.tone);
    const rightLine = this.formatHomeKeyValueLine(right.label, right.value, rightWidth, right.tone);
    return [`${this.padAnsiText(leftLine, leftWidth)}${' '.repeat(gap)}${this.padAnsiText(rightLine, rightWidth)}`];
  }

  private formatHomeWrappedKeyValueLines(
    label: string,
    value: string,
    width: number,
    tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default' = 'default'
  ): string[] {
    const normalizedLabel = `${label.padEnd(13)} `;
    const continuationLabel = ' '.repeat(this.getDisplayWidth(normalizedLabel));
    const valueWidth = Math.max(8, width - this.getDisplayWidth(normalizedLabel));
    const wrappedValueLines = this.wrapPlainText(value, valueWidth);

    return wrappedValueLines.map((line, index) => {
      const displayLabel = index === 0 ? normalizedLabel : continuationLabel;
      return this.homeMuted(displayLabel) + this.colorizeHomeValue(line, tone);
    });
  }

  private readPackageVersion(): string {
    try {
      const currentFilePath = fileURLToPath(import.meta.url);
      const packageJsonPath = path.resolve(path.dirname(currentFilePath), '../../package.json');
      const raw = fs.readFileSync(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private colorizeHomeValue(
    value: string,
    tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'default'
  ): string {
    switch (tone) {
      case 'accent':
        return this.homeAccent(value);
      case 'success':
        return this.homeSuccess(value);
      case 'warning':
        return this.homeWarning(value);
      case 'danger':
        return this.homeDanger(value);
      case 'muted':
        return this.homeMuted(value);
      default:
        return this.homeTitle(value);
    }
  }

  private truncatePlainText(value: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return '';
    }

    if (this.getDisplayWidth(value) <= maxWidth) {
      return value;
    }

    const ellipsis = maxWidth >= 3 ? '...' : '.';
    const targetWidth = Math.max(0, maxWidth - this.getDisplayWidth(ellipsis));
    let truncated = '';

    for (const character of Array.from(value)) {
      const candidate = truncated + character;
      if (this.getDisplayWidth(candidate) > targetWidth) {
        break;
      }
      truncated = candidate;
    }

    return truncated + ellipsis;
  }

  private truncateMiddleText(value: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return '';
    }

    if (this.getDisplayWidth(value) <= maxWidth) {
      return value;
    }

    const ellipsis = maxWidth >= 3 ? '...' : '.';
    const targetWidth = Math.max(0, maxWidth - this.getDisplayWidth(ellipsis));
    const headWidth = Math.ceil(targetWidth / 2);
    const tailWidth = Math.floor(targetWidth / 2);

    let head = '';
    for (const character of Array.from(value)) {
      const candidate = head + character;
      if (this.getDisplayWidth(candidate) > headWidth) {
        break;
      }
      head = candidate;
    }

    let tail = '';
    for (const character of Array.from(value).reverse()) {
      const candidate = character + tail;
      if (this.getDisplayWidth(candidate) > tailWidth) {
        break;
      }
      tail = candidate;
    }

    return `${head}${ellipsis}${tail}`;
  }

  private wrapPlainText(value: string, maxWidth: number): string[] {
    if (maxWidth <= 0) {
      return [''];
    }

    if (!value) {
      return [''];
    }

    const lines: string[] = [];
    let currentLine = '';

    for (const character of Array.from(value)) {
      const candidate = currentLine + character;
      if (currentLine && this.getDisplayWidth(candidate) > maxWidth) {
        lines.push(currentLine);
        currentLine = character;
        continue;
      }

      currentLine = candidate;
    }

    if (currentLine || lines.length === 0) {
      lines.push(currentLine);
    }

    return lines;
  }

  private formatDisplayPathForHome(inputPath: string): string {
    return path.resolve(inputPath);
  }

  private padAnsiText(value: string, width: number): string {
    const visibleWidth = this.getDisplayWidth(this.stripAnsi(value));
    if (visibleWidth >= width) {
      return value;
    }
    return value + ' '.repeat(width - visibleWidth);
  }

  private stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private async getHomeConfigStatusLines(width: number): Promise<string[]> {
    try {
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const activeProvider = config.activeProvider;
      const providerMeta = getProviderMeta(activeProvider);
      const providerConfig = config.providers[activeProvider] ?? {};
      const apiKey = providerConfig.apiKey?.trim();
      const currentModel = providerConfig.model?.trim();
      const currentBaseUrl = providerConfig.baseUrl?.trim() || providerMeta.defaultBaseUrl;
      const sourceSummary = this.summarizeProviderConfigSource(diagnostics.providerSources[activeProvider]);
      const lines: string[] = [];

      if (apiKey && currentModel) {
        lines.push(this.formatHomeKeyValueLine('status', 'ready', width, 'success'));
        lines.push(this.formatHomeKeyValueLine('provider', providerMeta.displayName, width, 'default'));
        lines.push(this.formatHomeKeyValueLine('source', sourceSummary, width, 'accent'));
        lines.push(this.formatHomeKeyValueLine('model', currentModel, width, 'accent'));
        lines.push(...this.formatHomeWrappedKeyValueLines('path', this.formatDisplayPathForHome(process.cwd()), width, 'muted'));
        lines.push(this.formatHomeKeyValueLine('endpoint', currentBaseUrl, width, 'muted'));
        lines.push(...this.getEnvironmentStatusLines(diagnostics, activeProvider, width));
        return lines;
      }

      lines.push(this.formatHomeKeyValueLine('status', 'needs setup', width, 'warning'));
      lines.push(this.formatHomeKeyValueLine('provider', providerMeta.displayName, width, 'default'));
      lines.push(...this.formatHomeWrappedKeyValueLines('path', this.formatDisplayPathForHome(process.cwd()), width, 'muted'));
      if (!apiKey) {
        lines.push(
          this.formatHomeKeyValueLine(
            'missing key',
            `Set ${providerMeta.envKeys.apiKey.join(' / ')} in .env`,
            width,
            'warning'
          )
        );
      }
      if (!currentModel) {
        lines.push(
          this.formatHomeKeyValueLine(
            'missing model',
            `Set ${providerMeta.envKeys.model.join(' / ')} or run /model <model-name>`,
            width,
            'warning'
          )
        );
      }
      lines.push(this.formatHomeKeyValueLine('endpoint', currentBaseUrl, width, 'muted'));
      lines.push(...this.getEnvironmentStatusLines(diagnostics, activeProvider, width));
      return lines;
    } catch {
      return [
        this.formatHomeKeyValueLine('status', 'failed to read model configuration state', width, 'danger'),
        this.formatHomeKeyValueLine('hint', 'Check your .env and restart the CLI', width, 'muted'),
      ];
    }
  }

  private async getHomeProjectContextStatusLines(width: number): Promise<string[]> {
    try {
      const claudeCodeActive = this.hasUserWorkspaceToolingDirectory('.claude');
      const codexActive = this.hasUserWorkspaceToolingDirectory('.codex');
      return [
        ...this.formatHomeParallelKeyValueLines(
          {
            label: 'Claude Code',
            value: claudeCodeActive ? 'active' : 'not active',
            tone: claudeCodeActive ? 'success' : 'muted',
          },
          {
            label: 'OpenAI Codex',
            value: codexActive ? 'active' : 'not active',
            tone: codexActive ? 'success' : 'muted',
          },
          width
        ),
      ];
    } catch {
      const claudeCodeActive = this.hasUserWorkspaceToolingDirectory('.claude');
      const codexActive = this.hasUserWorkspaceToolingDirectory('.codex');
      return [
        ...this.formatHomeParallelKeyValueLines(
          {
            label: 'Claude Code',
            value: claudeCodeActive ? 'active' : 'not active',
            tone: claudeCodeActive ? 'success' : 'muted',
          },
          {
            label: 'OpenAI Codex',
            value: codexActive ? 'active' : 'not active',
            tone: codexActive ? 'success' : 'muted',
          },
          width
        ),
      ];
    }
  }

  private async ensureWorkspaceTrustBeforeStart(): Promise<boolean> {
    const currentPath = process.cwd();
    const trusted = await this.configStore.isPathTrusted(currentPath);
    if (trusted) {
      return true;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(chalk.yellow('Workspace trust required before starting CLI.'));
      console.log(chalk.dim(`Current path: ${currentPath}`));
      console.log(chalk.dim('Run in interactive mode and trust this directory first.'));
      return false;
    }

    try {
      const decision = await this.renderWorkspaceTrustPrompt(currentPath);

      if (decision === 'trust') {
        await this.configStore.trustPath(currentPath);
        console.log(chalk.green('\nTrusted current directory. Starting CLI...\n'));
        return true;
      }

      console.log(chalk.yellow('\nTrust not granted. Exiting.\n'));
      return false;
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        console.log(chalk.yellow('\nTrust prompt canceled. Exiting.\n'));
        return false;
      }
      throw error;
    }
  }

  private async renderWorkspaceTrustPrompt(currentPath: string): Promise<TrustDecision> {
    return new Promise<TrustDecision>((resolve) => {
      let settled = false;

      const handleDecision = (decision: TrustDecision) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(decision);
      };

      render(createElement(TrustPrompt, { currentPath, onDecision: handleDecision }), {
        exitOnCtrlC: false,
        patchConsole: false,
      });
    });
  }

  private async getHomeTrustStatusLines(width: number): Promise<string[]> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      if (trusted) {
        return [];
      }

      return [
        this.formatHomeKeyValueLine('hint', 'Run /trustpath to trust this directory', width, 'accent'),
      ];
    } catch {
      return [this.formatHomeKeyValueLine('trust', 'failed', width, 'danger')];
    }
  }

  private hasUserWorkspaceToolingDirectory(directoryName: '.claude' | '.codex'): boolean {
    try {
      return fs.existsSync(path.join(os.homedir(), directoryName));
    } catch {
      return false;
    }
  }

  private setupReadline(): void {
    this.bindInputAssistHandlers();
  }

  private bindInputAssistHandlers(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.removeListener('keypress', this.onInputAssistKeypress);
    process.stdin.on('keypress', this.onInputAssistKeypress);
  }

  private canInteractWithInput(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY && !this.isInteractiveCommandActive && !this.isLineProcessing);
  }

  private shouldUseCommandSuggestionNavigation(key?: readline.Key): boolean {
    if (!key || (key.name !== 'up' && key.name !== 'down') || !this.canInteractWithInput()) {
      return false;
    }

    return this.getCurrentReadlineInput().trimStart().startsWith('/');
  }

  private getCurrentReadlineInput(): string {
    return this.inputValue;
  }

  private getReadlineCursorIndex(): number {
    return Math.max(0, Math.min(this.inputCursor, this.getInputCharCount()));
  }

  private getReadlineCursorPos(): readline.CursorPos {
    return {
      rows: 0,
      cols: this.getPromptCursorColumn(),
    };
  }

  private getPromptScreenLineCount(): number {
    return 1;
  }

  private syncPromptLayoutFromReadline(): void {
    const suggestionLines = this.getPromptSuggestionLines();
    this.inlineSuggestionLines = suggestionLines.length;
    this.promptVisibleLines = 3 + suggestionLines.length;
  }

  private updateInlineSuggestionsFromReadline(force = false): void {
    if (!this.canInteractWithInput()) {
      return;
    }

    if (!force && this.lastInlineSuggestionQuery === this.getCurrentReadlineInput().trimStart()) {
      return;
    }

    this.renderPromptArea();
  }

  private renderInlineSuggestions(lines: string[]): void {
    if (!this.canInteractWithInput()) {
      return;
    }
    this.renderPromptArea(lines);
  }

  private clearInlineSuggestions(): void {
    this.inlineSuggestionLines = 0;
  }

  private clearSuggestions(): void {
    this.autoCompleter.resetSuggestions();
    this.lastInlineSuggestionQuery = '';
    this.inlineSuggestionLines = 0;
  }

  private clearPromptEchoBlock(): void {
    if (!process.stdout.isTTY) {
      return;
    }

    if (this.promptVisibleLines <= 0) {
      return;
    }

    readline.moveCursor(process.stdout, 0, -1);
    for (let i = 0; i < this.promptVisibleLines; i += 1) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      if (i < this.promptVisibleLines - 1) {
        readline.moveCursor(process.stdout, 0, 1);
      }
    }
    if (this.promptVisibleLines > 1) {
      readline.moveCursor(process.stdout, 0, -(this.promptVisibleLines - 1));
    }

    this.promptVisibleLines = 0;
    this.inlineSuggestionLines = 0;
  }

  private canRenderInlineSuggestions(): boolean {
    return this.canInteractWithInput();
  }

  private setReadlineInput(value: string): void {
    const normalized = value.replace(/\r/g, '').replace(/\n/g, ' ');
    this.inputValue = normalized;
    this.inputCursor = this.getCharCount(normalized);
    this.historyIndex = -1;
    this.historyDraftValue = '';
    this.lastInlineSuggestionQuery = '';
  }

  private fitSuggestionLinesToTerminal(lines: string[]): string[] {
    const columns = Math.max(20, (process.stdout.columns ?? 120) - 2);
    return lines.map((line) => `  ${this.truncateAnsiLine(line, columns)}`);
  }

  private truncateAnsiLine(input: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return '';
    }

    const ansiPattern = /\x1b\[[0-9;]*m/g;
    const textOnly = input.replace(ansiPattern, '');
    if (this.getDisplayWidth(textOnly) <= maxWidth) {
      return input;
    }

    const suffix = maxWidth >= 3 ? '...' : '.';
    const targetWidth = Math.max(0, maxWidth - this.getDisplayWidth(suffix));

    let visible = '';
    for (const ch of Array.from(textOnly)) {
      const next = visible + ch;
      if (this.getDisplayWidth(next) > targetWidth) {
        break;
      }
      visible = next;
    }

    return visible + suffix;
  }

  private renderPromptArea(suggestionLines?: string[]): void {
    if (!process.stdout.isTTY) {
      return;
    }

    const { lines, cursorCol, suggestionCount, query } = this.buildPromptArea(suggestionLines);
    this.clearPromptEchoBlock();

    lines.forEach((line, index) => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(line);
      if (index < lines.length - 1) {
        process.stdout.write('\n');
      }
    });

    const linesBelowInput = Math.max(0, lines.length - 2);
    if (linesBelowInput > 0) {
      readline.moveCursor(process.stdout, 0, -linesBelowInput);
    }
    readline.cursorTo(process.stdout, cursorCol);

    this.promptVisibleLines = lines.length;
    this.inlineSuggestionLines = suggestionCount;
    this.lastInlineSuggestionQuery = query;
  }

  private buildPromptArea(suggestionLines?: string[]): {
    lines: string[];
    cursorCol: number;
    suggestionCount: number;
    query: string;
  } {
    const { line: inputLine, cursorCol } = this.buildPromptInputLine();
    const effectiveSuggestions = suggestionLines ?? this.getPromptSuggestionLines();
    const query = this.getCurrentReadlineInput().trimStart();
    return {
      lines: [chalk.dim(this.getPromptDivider()), inputLine, this.buildPromptFooterLine(), ...effectiveSuggestions],
      cursorCol,
      suggestionCount: effectiveSuggestions.length,
      query,
    };
  }

  private buildPromptInputLine(): { line: string; cursorCol: number } {
    const columns = Math.max(24, process.stdout.columns ?? 80);
    const leftMargin = '  ';
    const prefixWidth = this.getDisplayWidth(leftMargin) + this.getDisplayWidth(this.promptPrefix);
    const visibleWidth = Math.max(8, columns - prefixWidth - 1);

    if (!this.inputValue) {
      return {
        line: `${leftMargin}${this.homeAccent(this.promptPrefix)}${chalk.dim(this.truncatePlainText(this.promptPlaceholder, visibleWidth))}`,
        cursorCol: prefixWidth,
      };
    }

    const window = this.getVisibleInputWindow(visibleWidth);
    return {
      line: `${leftMargin}${this.homeAccent(this.promptPrefix)}${chalk.white(window.visibleText || ' ')}`,
      cursorCol: prefixWidth + window.cursorWidth,
    };
  }

  private buildPromptFooterLine(): string {
    const columns = Math.max(20, process.stdout.columns ?? 80);
    if (this.hasPendingExitConfirmation() || this.exitConfirmationNoticeVisible) {
      return `  ${this.truncateAnsiLine(chalk.yellow('Press Ctrl+C again within 3 seconds to exit.'), columns - 2)}`;
    }

    if (this.activeDetailPageContext) {
      return `  ${this.truncateAnsiLine(chalk.dim(`Ctrl+C back to home · ${this.formatDetailPageHistoryLabel(this.activeDetailPageContext)}`), columns - 2)}`;
    }

    if (this.getCurrentReadlineInput().trimStart().startsWith('/')) {
      return `  ${this.truncateAnsiLine(chalk.dim('Tab complete, ↑↓ choose command, Enter run'), columns - 2)}`;
    }

    return `  ${this.truncateAnsiLine(chalk.dim('/ commands, ↑↓ history, Ctrl+U clear'), columns - 2)}`;
  }

  private getPromptSuggestionLines(): string[] {
    const trimmed = this.getCurrentReadlineInput().trimStart();
    if (!trimmed.startsWith('/')) {
      return [];
    }

    return this.fitSuggestionLinesToTerminal(this.autoCompleter.getSuggestionLines(trimmed, 6));
  }

  private getPromptCursorColumn(): number {
    const leftMargin = '  ';
    const prefixWidth = this.getDisplayWidth(leftMargin) + this.getDisplayWidth(this.promptPrefix);
    if (!this.inputValue) {
      return prefixWidth;
    }

    const columns = Math.max(24, process.stdout.columns ?? 80);
    const visibleWidth = Math.max(8, columns - prefixWidth - 1);
    return prefixWidth + this.getVisibleInputWindow(visibleWidth).cursorWidth;
  }

  private getVisibleInputWindow(maxWidth: number): { visibleText: string; cursorWidth: number } {
    const chars = this.getInputChars();
    if (chars.length === 0) {
      return { visibleText: '', cursorWidth: 0 };
    }

    const cursorIndex = this.getReadlineCursorIndex();
    let start = 0;
    while (start < cursorIndex) {
      const reserveLeft = start > 0 ? 1 : 0;
      const reserveRight = cursorIndex < chars.length ? 1 : 0;
      const widthToCursor = this.getDisplayWidth(chars.slice(start, cursorIndex).join(''));
      if (reserveLeft + widthToCursor + reserveRight <= maxWidth) {
        break;
      }
      start += 1;
    }

    const visibleChars: string[] = [];
    let end = start;
    let usedWidth = start > 0 ? 1 : 0;
    while (end < chars.length) {
      const charWidth = this.getCharDisplayWidth(chars[end]);
      const reserveRight = end < chars.length - 1 ? 1 : 0;
      if (usedWidth + charWidth + reserveRight > maxWidth) {
        break;
      }
      visibleChars.push(chars[end]);
      usedWidth += charWidth;
      end += 1;
    }

    const cursorWidth = (start > 0 ? 1 : 0) + this.getDisplayWidth(chars.slice(start, cursorIndex).join(''));
    return {
      visibleText: `${start > 0 ? '…' : ''}${visibleChars.join('')}${end < chars.length ? '…' : ''}`,
      cursorWidth,
    };
  }

  private submitCurrentInput(): Promise<void> {
    const rawInput = this.inputValue;
    const trimmedInput = rawInput.trim();
    if (this.isLineProcessing || !trimmedInput) {
      this.renderPromptArea();
      return Promise.resolve();
    }

    this.isLineProcessing = true;
    this.clearPendingExitConfirmation();
    this.commitInputToHistory(rawInput);
    this.clearSuggestions();
    this.setReadlineInput('');
    this.clearPromptEchoBlock();

    return this.handleInput(trimmedInput).finally(() => {
      this.isLineProcessing = false;
      if (!this.isInteractiveCommandActive) {
        this.showPrompt();
      }
    });
  }

  private commitInputToHistory(value: string): void {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }

    if (this.inputHistory[this.inputHistory.length - 1] !== value) {
      this.inputHistory.push(value);
    }
    this.historyIndex = -1;
    this.historyDraftValue = '';
  }

  private navigateHistory(direction: -1 | 1): boolean {
    if (this.inputHistory.length === 0) {
      return false;
    }

    if (direction === -1) {
      if (this.historyIndex === -1) {
        this.historyDraftValue = this.inputValue;
        this.historyIndex = this.inputHistory.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      } else {
        return false;
      }

      const next = this.inputHistory[this.historyIndex] ?? '';
      this.inputValue = next;
      this.inputCursor = this.getCharCount(next);
      return true;
    }

    if (this.historyIndex === -1) {
      return false;
    }

    if (this.historyIndex < this.inputHistory.length - 1) {
      this.historyIndex += 1;
      const next = this.inputHistory[this.historyIndex] ?? '';
      this.inputValue = next;
      this.inputCursor = this.getCharCount(next);
      return true;
    }

    this.historyIndex = -1;
    this.inputValue = this.historyDraftValue;
    this.inputCursor = this.getCharCount(this.historyDraftValue);
    this.historyDraftValue = '';
    return true;
  }

  private insertTextAtCursor(text: string): void {
    const cleaned = text.replace(/\r/g, '').replace(/\n/g, ' ');
    if (!cleaned) {
      return;
    }

    const chars = this.getInputChars();
    chars.splice(this.inputCursor, 0, ...Array.from(cleaned));
    this.inputValue = chars.join('');
    this.inputCursor += Array.from(cleaned).length;
    this.historyIndex = -1;
  }

  private moveInputCursor(delta: number): boolean {
    const next = Math.max(0, Math.min(this.getInputCharCount(), this.inputCursor + delta));
    if (next === this.inputCursor) {
      return false;
    }
    this.inputCursor = next;
    return true;
  }

  private deleteInputBeforeCursor(): boolean {
    if (this.inputCursor <= 0) {
      return false;
    }

    const chars = this.getInputChars();
    chars.splice(this.inputCursor - 1, 1);
    this.inputValue = chars.join('');
    this.inputCursor -= 1;
    this.historyIndex = -1;
    return true;
  }

  private deleteInputAtCursor(): boolean {
    const chars = this.getInputChars();
    if (this.inputCursor >= chars.length) {
      return false;
    }

    chars.splice(this.inputCursor, 1);
    this.inputValue = chars.join('');
    this.historyIndex = -1;
    return true;
  }

  private isPrintableInput(str: string, key: readline.Key): boolean {
    if (!str || key.ctrl || key.meta) {
      return false;
    }

    return !/[\r\n\t]/.test(str);
  }

  private getInputChars(): string[] {
    return Array.from(this.inputValue);
  }

  private getInputCharCount(): number {
    return this.getCharCount(this.inputValue);
  }

  private getCharCount(text: string): number {
    return Array.from(text).length;
  }

  private async handleInput(input: string): Promise<void> {
    this.clearPendingExitConfirmation();
    this.clearInlineSuggestions();
    this.lastInlineSuggestionQuery = '';

    if (input.startsWith('/')) {
      const normalizedCommand = input.slice(1).trim().split(/\s+/)[0]?.toLowerCase() || 'unknown';
      const canonicalCommand = this.commandRegistry.getCommand(normalizedCommand)?.name ?? normalizedCommand;
      const safeInput = this.maskSensitiveCommandInput(input);
      this.recordCommandData(normalizedCommand, `invoked ${safeInput}`);
      this.uiRenderer.renderCommandInvocation(safeInput);
      await this.commandHandler.handleCommand(input);
      if (this.isDetailPageCommand(canonicalCommand)) {
        this.activeDetailPageContext = { command: safeInput, dialogueTurns: 0 };
      }
      if (normalizedCommand === 'clear') {
        this.commandDataHistory = [];
      }
      return;
    }

    if (this.activeDetailPageContext) {
      this.activeDetailPageContext = {
        ...this.activeDetailPageContext,
        dialogueTurns: this.activeDetailPageContext.dialogueTurns + 1,
      };
    }

    this.conversationManager.addMessage('user', input);
    this.uiRenderer.renderLastMessage();

    const spinner = new Spinner();
    console.log('');
    spinner.start('Thinking...');

    try {
      const response = await this.llmClient.generateReply(this.conversationManager.getMessages());
      spinner.stop();
      const config = await this.configStore.getConfig();
      const activeProvider = config.activeProvider;
      const modelLabel = config.providers[activeProvider]?.model?.trim();
      this.conversationManager.addMessage(
        'assistant',
        response.content,
        response.appendix || modelLabel
          ? {
              ...(response.appendix ? { appendix: response.appendix } : {}),
              ...(modelLabel ? { modelLabel } : {}),
            }
          : undefined
      );
      this.uiRenderer.renderLastMessage();
    } catch (error) {
      spinner.stop();
      const message = error instanceof Error ? error.message : 'Model request failed. Please check config or network.';
      this.uiRenderer.renderError(message);
    }
  }

  private maskSensitiveCommandInput(input: string): string {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return input;
    }

    const [command, ...rest] = trimmed.slice(1).split(/\s+/);
    const normalizedCommand = command?.toLowerCase() || '';

    return input;
  }

  private recordCommandData(command: string, data: string): void {
    const normalizedCommand = command.trim().toLowerCase() || 'unknown';
    const normalizedData = data.replace(/\r\n/g, '\n').trim();
    if (!normalizedData) {
      return;
    }

    const maxDataChars = 3500;
    const cappedData =
      normalizedData.length > maxDataChars ? `${normalizedData.slice(0, maxDataChars)}\n...(truncated)` : normalizedData;

    this.commandDataHistory.push({
      timestamp: new Date(),
      command: normalizedCommand,
      data: cappedData,
    });

    const maxEntries = 200;
    if (this.commandDataHistory.length > maxEntries) {
      this.commandDataHistory = this.commandDataHistory.slice(this.commandDataHistory.length - maxEntries);
    }
  }

  private buildCommandDataContext(): string {
    const selected = this.commandDataHistory.slice(-60);
    if (selected.length === 0) {
      return '';
    }

    const lines = selected.flatMap((entry) => [
      `[${entry.timestamp.toISOString()}] /${entry.command}`,
      entry.data,
      '',
    ]);

    const merged = ['Command data history:', ...lines].join('\n').trim();
    const maxChars = 18000;
    if (merged.length <= maxChars) {
      return merged;
    }

    return `Command data history:\n...(truncated)\n${merged.slice(merged.length - maxChars)}`;
  }

  private async handleProviderSwitch(args: string[]): Promise<void> {
    const invokedCommand = args.length > 0 ? `/provider ${args.join(' ')}` : '/provider';

    try {
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const currentProvider = config.activeProvider;
      let targetProvider: ProviderName | undefined;

      if (args.length > 0) {
        const rawInput = args.join(' ').trim().toLowerCase();
        if (!rawInput) {
          await this.refreshHomeAfterModelCommand(invokedCommand, `Active provider: ${getProviderMeta(currentProvider).displayName}`);
          return;
        }

        const matched = PROVIDER_NAMES.find((provider) => provider === rawInput);
        if (!matched) {
          this.uiRenderer.renderError(`Unknown provider: ${rawInput}`);
          this.uiRenderer.renderInfo(`Available providers: ${PROVIDER_NAMES.join(', ')}`);
          this.recordCommandData('provider', `failed: unknown provider: ${rawInput}`);
          return;
        }

        targetProvider = matched;
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          this.uiRenderer.renderError('Interactive provider selection requires a TTY. Use /provider <name> instead.');
          this.recordCommandData('provider', 'failed: Interactive provider selection requires a TTY.');
          return;
        }

        this.isInteractiveCommandActive = true;
        this.clearSuggestions();
        const { selectedProvider } = await inquirer.prompt<{ selectedProvider: ProviderName }>([
          {
            type: 'list',
            name: 'selectedProvider',
            message: 'Select the active provider',
            choices: PROVIDER_NAMES.map((provider) => ({
              name:
                provider === currentProvider
                  ? `${getProviderMeta(provider).displayName} (current)`
                  : getProviderMeta(provider).displayName,
              value: provider,
            })),
            default: currentProvider,
          },
        ]);
        targetProvider = selectedProvider;
      }

      if (!targetProvider || targetProvider === currentProvider) {
        await this.refreshHomeAfterModelCommand(invokedCommand, `Provider unchanged: ${getProviderMeta(currentProvider).displayName}`);
        return;
      }

      await this.configStore.setActiveProvider(targetProvider);
      const result =
        diagnostics.activeProviderSource === 'env'
          ? `Active provider saved as ${getProviderMeta(targetProvider).displayName} (env override is still active)`
          : `Active provider switched: ${getProviderMeta(currentProvider).displayName} -> ${getProviderMeta(targetProvider).displayName}`;
      await this.refreshHomeAfterModelCommand(invokedCommand, result);
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        this.uiRenderer.renderCommandResult('Provider switch canceled');
        this.recordCommandData('provider', 'Provider switch canceled');
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to switch provider';
      this.uiRenderer.renderError(message);
      this.recordCommandData('provider', `failed: ${message}`);
    } finally {
      this.isInteractiveCommandActive = false;
      this.autoCompleter.resetSuggestions();
      this.applyBlockCursorStyle();
      this.ensureInputReadyAfterConfig();
    }
  }

  private async startModelSwitchFlow(args: string[]): Promise<void> {
    this.isInteractiveCommandActive = true;
    this.clearSuggestions();

    try {
      const invokedCommand = args.length > 0 ? `/model ${args.join(' ')}` : '/model';
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const provider = config.activeProvider;
      const providerMeta = getProviderMeta(provider);
      const providerConfig = config.providers[provider] ?? {};
      const apiKey = providerConfig.apiKey?.trim();
      if (!apiKey) {
        this.uiRenderer.renderError(
          `${providerMeta.displayName} API key is missing. Set ${providerMeta.envKeys.apiKey.join(' / ')} in .env first.`
        );
        this.recordCommandData(
          'model',
          `failed: ${providerMeta.displayName} API key is missing. Set ${providerMeta.envKeys.apiKey.join(' / ')} in .env first.`
        );
        return;
      }

      const currentBaseUrl = providerConfig.baseUrl?.trim() || providerMeta.defaultBaseUrl;
      const currentEffectiveModelValue = providerConfig.model?.trim() || '';
      const currentEffectiveModel = currentEffectiveModelValue || 'Not set';
      const isSessionModelOverrideActive = diagnostics.providerSources[provider].model === 'session';
      let targetModel: string | undefined;

      if (args.length > 0) {
        const rawInput = args.join(' ').trim();
        if (!rawInput) {
          await this.refreshHomeAfterModelCommand(invokedCommand, `Current model: ${currentEffectiveModel}`);
          return;
        }

        const normalizedInput = rawInput.toLowerCase();
        if (normalizedInput === 'clear' || normalizedInput === 'reset' || normalizedInput === 'default' || normalizedInput === 'unset') {
          if (!isSessionModelOverrideActive) {
            await this.refreshHomeAfterModelCommand(
              invokedCommand,
              `No session model override is active. Current model: ${currentEffectiveModel}`
            );
            return;
          }

          this.configStore.clearSessionProviderConfig(provider, ['model']);
          const nextConfig = await this.configStore.getConfig();
          const nextModel = nextConfig.providers[provider]?.model?.trim() || 'Not set';
          await this.refreshHomeAfterModelCommand(invokedCommand, `Session model cleared. Active model: ${nextModel}`);
          return;
        }

        if (provider === 'openrouter') {
          targetModel = rawInput;
        } else {
          const availableModels = await this.fetchAvailableModels(provider, currentBaseUrl, apiKey);
          if (!availableModels.includes(rawInput)) {
            const preview = availableModels.slice(0, 10).join(', ');
            const suffix = availableModels.length > 10 ? ', ...' : '';
            this.uiRenderer.renderError(`${providerMeta.displayName} model not available for current API key: ${rawInput}`);
            this.uiRenderer.renderInfo(`Available models: ${preview}${suffix}`);
            this.recordCommandData('model', `failed: model not available: ${rawInput}`);
            return;
          }
          targetModel = rawInput;
        }
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          this.uiRenderer.renderError('Interactive model selection requires a TTY. Use /model <model-name> instead.');
          this.recordCommandData('model', 'failed: Interactive model selection requires a TTY.');
          return;
        }

        if (provider === 'openrouter') {
          const { enteredModel } = await inquirer.prompt<{ enteredModel: string }>([
            {
              type: 'input',
              name: 'enteredModel',
              message: `Current model: ${currentEffectiveModel}. Enter the OpenRouter model name`,
              default: currentEffectiveModelValue || providerMeta.modelPlaceholder,
              validate: (value: string) => Boolean(value.trim()) || 'Model name cannot be empty',
            },
          ]);

          const normalizedEntered = enteredModel.trim();
          if (normalizedEntered === currentEffectiveModelValue) {
            await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${currentEffectiveModel}`);
            return;
          }

          targetModel = normalizedEntered;
        } else {
          const availableModels = await this.fetchAvailableModels(provider, currentBaseUrl, apiKey);
          if (availableModels.length === 0) {
            this.uiRenderer.renderError('No available models returned by current API endpoint.');
            this.recordCommandData('model', 'failed: No available models returned by current API endpoint.');
            return;
          }

          const { selectedModel } = await inquirer.prompt<{ selectedModel: string }>([
            {
              type: 'list',
              name: 'selectedModel',
              message: `Current model: ${currentEffectiveModel}. Select target model`,
              choices: availableModels.map((modelName) => ({
                name: modelName === currentEffectiveModel ? `${modelName} (current)` : modelName,
                value: modelName,
              })),
              default: availableModels.includes(currentEffectiveModel) ? currentEffectiveModel : availableModels[0],
              pageSize: Math.min(15, availableModels.length),
            },
          ]);

          if (selectedModel === currentEffectiveModel) {
            await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${currentEffectiveModel}`);
            return;
          }

          targetModel = selectedModel;
        }
      }

      const previousEffectiveModel = currentEffectiveModel;
      const nextEffectiveModel = targetModel?.trim() || 'Not set';
      const normalizedTarget = targetModel?.trim() || '';
      const isSameConfiguredValue = currentEffectiveModelValue === normalizedTarget;

      if (isSameConfiguredValue) {
        await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${previousEffectiveModel}`);
        return;
      }

      this.configStore.setSessionProviderConfig(provider, { model: targetModel });
      await this.refreshHomeAfterModelCommand(
        invokedCommand,
        `Session model switched: ${previousEffectiveModel} -> ${nextEffectiveModel}`
      );
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        this.uiRenderer.renderCommandResult('Model switch canceled');
        this.recordCommandData('model', 'Model switch canceled');
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to switch model';
      this.uiRenderer.renderError(message);
      this.recordCommandData('model', `failed: ${message}`);
    } finally {
      this.isInteractiveCommandActive = false;
      this.autoCompleter.resetSuggestions();
      this.applyBlockCursorStyle();
      this.ensureInputReadyAfterConfig();
    }
  }

  private async refreshHomeAfterModelCommand(command: string, result: string): Promise<void> {
    await this.showWelcome();
    this.uiRenderer.renderCommandInvocation(command);
    this.uiRenderer.renderCommandResult(result);
    const normalizedCommand = command.startsWith('/') ? command.slice(1).split(/\s+/)[0] : command;
    this.recordCommandData(normalizedCommand, result);
  }

  private async handleProjectContextCommand(args: string[]): Promise<void> {
    const invoked = args.length > 0 ? `/projectcontext ${args.join(' ')}` : '/projectcontext';
    const action = args[0]?.trim().toLowerCase() ?? 'status';

    if (action === 'status') {
      const config = await this.configStore.getConfig();
      const state = config.projectContextEnabled ? 'enabled' : 'disabled';
      await this.refreshHomeAfterModelCommand(invoked, `Project context is ${state}`);
      return;
    }

    if (action === 'on' || action === 'enable') {
      await this.configStore.setProjectContextEnabled(true);
      await this.refreshHomeAfterModelCommand(invoked, 'Project context enabled');
      return;
    }

    if (action === 'off' || action === 'disable') {
      await this.configStore.setProjectContextEnabled(false);
      await this.refreshHomeAfterModelCommand(invoked, 'Project context disabled');
      return;
    }

    this.uiRenderer.renderError('Usage: /projectcontext [on|off|status]');
    this.recordCommandData('projectcontext', 'Usage: /projectcontext [on|off|status]');
  }

  private async fetchAvailableModels(provider: ProviderName, baseUrl: string, apiKey: string): Promise<string[]> {
    const normalizedBase = baseUrl.replace(/\/+$/, '');

    // Enforce HTTPS to prevent API key transmission over plain HTTP.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedBase);
    } catch {
      throw new Error(`Invalid Base URL: ${normalizedBase}`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Base URL must use HTTPS (got: ${parsedUrl.protocol}). Refusing to send API key over insecure connection.`);
    }

    const adapter = this.adaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`${getProviderMeta(provider).displayName} adapter not found.`);
    }

    return adapter.listModels({ apiKey, baseUrl: normalizedBase });
  }

  private ensureInputReadyAfterConfig(): void {
    try {
      process.stdin.resume();
    } catch {
      // Ignore stdin resume errors.
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    if (process.stdin.isTTY && process.stdout.isTTY) {
      this.bindInputAssistHandlers();
    }
  }

  private getPromptDivider(): string {
    const width = process.stdout.columns ?? 80;
    return '─'.repeat(width);
  }

  private applyBlockCursorStyle(): void {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2 q');
    }
  }

  private getDisplayWidth(text: string): number {
    let width = 0;
    for (const char of Array.from(text)) {
      width += this.getCharDisplayWidth(char);
    }
    return width;
  }

  private getCharDisplayWidth(char: string): number {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) return 0;

    // Control chars.
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;

    // Combining marks.
    if (
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    ) {
      return 0;
    }

    // Wide characters (CJK, Hangul, full-width forms, most emoji).
    if (
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
        (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd))
    ) {
      return 2;
    }

    return 1;
  }

  private getEnvironmentStatusLines(
    diagnostics: ConfigDiagnostics,
    provider: ProviderName,
    width: number
  ): string[] {
    const providerSources = diagnostics.providerSources[provider];
    const sessionOverrides = this.getSessionOverrideLabels(providerSources);
    const lines: string[] = [];

    if (diagnostics.loadedEnvFiles.length > 0) {
      lines.push(this.formatHomeKeyValueLine('env files', diagnostics.loadedEnvFiles.join(', '), width, 'accent'));
    }

    if (diagnostics.activeProviderSource === 'env') {
      lines.push(this.formatHomeKeyValueLine('env override', 'Active Provider', width, 'warning'));
    }

    if (sessionOverrides.length > 0) {
      lines.push(this.formatHomeKeyValueLine('session', sessionOverrides.join(', '), width, 'success'));
      lines.push(this.formatHomeKeyValueLine('reset', 'Use /model clear to restore the configured default model', width, 'accent'));
    }

    return lines;
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

  private summarizeProviderConfigSource(sources: ProviderConfigSources): string {
    const runtimeSources = Array.from(
      new Set(
        [sources.apiKey, sources.baseUrl, sources.model].filter(
          (item) => item === 'session' || item === 'env' || item === 'local'
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

  private isPromptCancelError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ExitPromptError';
  }

  private async handleSigint(): Promise<void> {
    if (this.activeDetailPageContext && !this.isLineProcessing && !this.isInteractiveCommandActive) {
      await this.returnToWelcomeFromDetailPage();
      return;
    }

    if (this.hasPendingExitConfirmation()) {
      this.clearPendingExitConfirmation(true);
      this.exitWithFarewell();
    }

    this.pendingExitConfirmationUntil = Date.now() + CLI.EXIT_CONFIRM_WINDOW_MS;
    if (this.pendingExitConfirmationTimer) {
      clearTimeout(this.pendingExitConfirmationTimer);
    }
    this.pendingExitConfirmationTimer = setTimeout(() => {
      this.clearPendingExitConfirmation(true);
    }, CLI.EXIT_CONFIRM_WINDOW_MS);

    this.clearSuggestions();
    if (this.getCurrentReadlineInput()) {
      this.setReadlineInput('');
    }
    this.exitConfirmationNoticeVisible = true;
    if (!this.isInteractiveCommandActive && !this.isLineProcessing) {
      this.renderPromptArea();
    }
  }

  private isDetailPageCommand(commandName: string): boolean {
    return new Set([
      'state',
      'skills',
      'scan_prompt',
      'rules',
      'scan_tokens',
      'context_health',
      'noise_eval',
      'context_noise',
      'todo_granularity',
    ]).has(commandName);
  }

  private async returnToWelcomeFromDetailPage(): Promise<void> {
    if (this.isReturningFromDetailPage) {
      return;
    }

    this.isReturningFromDetailPage = true;
    const detailContext = this.activeDetailPageContext;
    this.clearPendingExitConfirmation(true);
    this.clearSuggestions();
    this.setReadlineInput('');
    this.clearPromptEchoBlock();

    try {
      await this.showWelcome();
      if (detailContext) {
        this.uiRenderer.renderCommandInvocation(detailContext.command);
        this.uiRenderer.renderCommandResult(`History: ${this.formatDetailPageHistoryLabel(detailContext)}`);
      }
      this.showPrompt();
    } finally {
      this.isReturningFromDetailPage = false;
    }
  }

  private formatDetailPageHistoryLabel(context: { command: string; dialogueTurns: number }): string {
    return `${context.command} · ${context.dialogueTurns} dialogues`;
  }

  private hasPendingExitConfirmation(): boolean {
    return this.pendingExitConfirmationUntil > Date.now();
  }

  private clearPendingExitConfirmation(clearNotice = false): void {
    this.pendingExitConfirmationUntil = 0;
    if (this.pendingExitConfirmationTimer) {
      clearTimeout(this.pendingExitConfirmationTimer);
      this.pendingExitConfirmationTimer = null;
    }
    if (clearNotice) {
      this.clearExitConfirmationNotice();
    }
  }

  private clearExitConfirmationNotice(): void {
    if (!this.exitConfirmationNoticeVisible) {
      return;
    }

    this.exitConfirmationNoticeVisible = false;

    if (!this.isInteractiveCommandActive && !this.isLineProcessing) {
      this.renderPromptArea();
    }
  }

  private exitWithFarewell(): never {
    this.clearPendingExitConfirmation(true);
    console.log('\nBye!');
    process.exit(0);
  }

  private async trustCurrentPath(): Promise<void> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      if (trusted) {
        this.uiRenderer.renderCommandResult(`Current directory is already trusted: ${currentPath}`);
        this.recordCommandData('trustpath', `Current directory is already trusted: ${currentPath}`);
        return;
      }

      await this.configStore.trustPath(currentPath);
      this.uiRenderer.renderCommandResult(`Trusted current directory: ${currentPath}`);
      this.recordCommandData('trustpath', `Trusted current directory: ${currentPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to trust current directory';
      this.uiRenderer.renderError(message);
      this.recordCommandData('trustpath', `failed: ${message}`);
    }
  }

  private async checkCurrentPathTrust(): Promise<void> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      if (trusted) {
        this.uiRenderer.renderCommandResult(`Trust check passed: ${currentPath}`);
        this.recordCommandData('trustcheck', `Trust check passed: ${currentPath}`);
        return;
      }

      this.uiRenderer.renderCommandResult(`Trust check failed: ${currentPath} (run /trustpath)`);
      this.recordCommandData('trustcheck', `Trust check failed: ${currentPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to verify trust status';
      this.uiRenderer.renderError(message);
      this.recordCommandData('trustcheck', `failed: ${message}`);
    }
  }

  stop(): void {
    this.clearPendingExitConfirmation(true);
    process.stdin.removeListener('keypress', this.onInputAssistKeypress);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  }
}
