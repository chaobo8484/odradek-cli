import readline from 'readline';
import chalk from 'chalk';
import inquirer from 'inquirer';
import boxen from 'boxen';
import { ConversationManager } from './ConversationManager.js';
import { CommandHandler } from './CommandHandler.js';
import { UIRenderer } from './UIRenderer.js';
import { CommandRegistry } from './CommandRegistry.js';
import { AutoCompleter } from './AutoCompleter.js';
import { Spinner } from './Spinner.js';
import { ConfigDiagnostics, ConfigStore, ProviderConfig, ProviderConfigSources } from './ConfigStore.js';
import { LLMClient } from '../llm/LLMClient.js';
import { createDefaultAdapters } from '../llm/adapters/createDefaultAdapters.js';

const CLAUDE_META = {
  displayName: 'Claude',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
};

export class CLI {
  private rl: readline.Interface;
  private conversationManager: ConversationManager;
  private commandHandler: CommandHandler;
  private uiRenderer: UIRenderer;
  private commandRegistry: CommandRegistry;
  private autoCompleter: AutoCompleter;
  private inlineSuggestionLines = 0;
  private lastInlineSuggestionQuery = '';
  private promptVisibleLines = 0;
  private readonly promptPrefix = '❯ ';
  private configStore: ConfigStore;
  private llmClient: LLMClient;
  private isInteractiveCommandActive = false;
  private commandDataHistory: Array<{ timestamp: Date; command: string; data: string }> = [];
  private isLineProcessing = false;
  private readonly onInputAssistKeypress = (_str: string, key: readline.Key): void => {
    if (!this.canRenderInlineSuggestions()) {
      return;
    }

    if ((key.ctrl && key.name === 'c') || key.name === 'return' || key.name === 'enter' || key.name === 'escape') {
      this.clearInlineSuggestions();
      return;
    }

    const baseInput = this.getCurrentReadlineInput();
    const trimmed = baseInput.trimStart();

    if (trimmed.startsWith('/') && (key.name === 'up' || key.name === 'down')) {
      if (key.name === 'up') {
        this.autoCompleter.previousSuggestion();
      } else {
        this.autoCompleter.nextSuggestion();
      }

      setImmediate(() => {
        if (this.getCurrentReadlineInput() !== baseInput) {
          this.setReadlineInput(baseInput);
        }
        this.updateInlineSuggestionsFromReadline(true);
      });
      return;
    }

    if (trimmed.startsWith('/') && key.name === 'tab') {
      const completion = this.autoCompleter.getHighlightedCompletion(trimmed);
      if (completion) {
        setImmediate(() => {
          this.setReadlineInput(completion);
          this.updateInlineSuggestionsFromReadline(true);
        });
        return;
      }
    }

    setImmediate(() => {
      this.updateInlineSuggestionsFromReadline();
    });
  };

  constructor() {
    this.commandRegistry = new CommandRegistry();
    this.autoCompleter = new AutoCompleter(this.commandRegistry);
    this.conversationManager = new ConversationManager();
    this.uiRenderer = new UIRenderer(this.conversationManager);
    this.configStore = new ConfigStore();
    this.llmClient = new LLMClient(this.configStore, createDefaultAdapters(), this.buildCommandDataContext.bind(this));

    this.commandHandler = new CommandHandler(
      this.conversationManager,
      this.uiRenderer,
      this.commandRegistry,
      this.startConfigFlow.bind(this),
      this.handleApiKeySwitch.bind(this),
      this.startModelSwitchFlow.bind(this),
      this.recordCommandData.bind(this),
      this.handleProjectContextCommand.bind(this),
      this.trustCurrentPath.bind(this),
      this.checkCurrentPathTrust.bind(this)
    );

    this.rl = this.createReadlineInterface();
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
    const rlMaybeClosed = this.rl as readline.Interface & { closed?: boolean };
    if (rlMaybeClosed.closed) {
      return;
    }

    const divider = chalk.dim(this.getPromptDivider());
    console.log(divider);
    this.rl.setPrompt(chalk.white(this.promptPrefix));
    this.rl.prompt();
    this.promptVisibleLines = 2;
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
    console.log('');
    console.log(chalk.bold('  Aeris'));
    console.log(chalk.dim('  Internal Build: v0.0.2_1'));
    console.log('');
    await this.renderHomeConfigStatus();
    await this.renderHomeProjectContextStatus();
    await this.renderHomeTrustStatus();
    console.log('');
    console.log(chalk.dim('  Type a message to start chatting'));
    console.log(chalk.dim('  Type ') + chalk.cyan('/') + chalk.dim(' for commands, press ') + chalk.cyan('Tab') + chalk.dim(' to autocomplete'));
    console.log('');
  }

  private async renderHomeConfigStatus(): Promise<void> {
    try {
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const claudeConfig = config.providers.claude ?? {};
      const apiKey = claudeConfig.apiKey?.trim();
      const currentModel = claudeConfig.model?.trim();
      const currentBaseUrl = claudeConfig.baseUrl?.trim() || CLAUDE_META.defaultBaseUrl;
      const sourceSummary = this.summarizeProviderConfigSource(diagnostics.providerSources.claude);

      if (apiKey && currentModel) {
        console.log(chalk.green('  Model Config: ready'));
        console.log(chalk.dim('  Config source: ') + chalk.cyan(sourceSummary));
        console.log(chalk.dim('  Current model: ') + chalk.cyan(currentModel));
        console.log(chalk.dim('  Base URL: ') + chalk.cyan(currentBaseUrl));
        this.renderEnvironmentStatusLines(diagnostics);
        return;
      }

      console.log(chalk.yellow('  Model Config: incomplete'));
      if (!apiKey) {
        console.log(
          chalk.dim('  Set ') +
            chalk.cyan('AERIS_CLAUDE_API_KEY') +
            chalk.dim(' or run ') +
            chalk.cyan('/modelconfig') +
            chalk.dim(' to finish setup')
        );
      }
      if (!currentModel) {
        console.log(
          chalk.dim('  Set ') +
            chalk.cyan('AERIS_CLAUDE_MODEL') +
            chalk.dim(' or run ') +
            chalk.cyan('/model <model-name>') +
            chalk.dim(' to finish setup')
        );
      }
      console.log(chalk.dim('  Current Base URL: ') + chalk.cyan(currentBaseUrl));
      this.renderEnvironmentStatusLines(diagnostics);
    } catch {
      console.log(chalk.red('  Failed to read model configuration state'));
      console.log(chalk.dim('  Run ') + chalk.cyan('/modelconfig') + chalk.dim(' to configure again'));
    }
  }

  private async renderHomeProjectContextStatus(): Promise<void> {
    try {
      const config = await this.configStore.getConfig();
      const enabled = config.projectContextEnabled;
      const state = enabled ? chalk.green('enabled') : chalk.yellow('disabled');
      console.log(chalk.dim('  Project Context: ') + state);
      console.log(
        chalk.dim('  Toggle with ') +
          chalk.cyan('/projectcontext on') +
          chalk.dim(' / ') +
          chalk.cyan('/projectcontext off')
      );
    } catch {
      console.log(chalk.red('  Project Context: failed to read config'));
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

    this.renderWorkspaceTrustPrompt(currentPath);

    try {
      const { decision } = await inquirer.prompt<{ decision: 'trust' | 'exit' }>([
        {
          type: 'list',
          name: 'decision',
          message: 'Select an option',
          choices: [
            { name: 'Yes, I trust this folder', value: 'trust' },
            { name: 'No, exit', value: 'exit' },
          ],
          default: 'trust',
          pageSize: 2,
        },
      ]);

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

  private renderWorkspaceTrustPrompt(currentPath: string): void {
    const divider = chalk.yellow(this.getPromptDivider());
    console.log(divider);
    console.log(chalk.yellow.bold('Accessing workspace:'));
    console.log('');
    console.log(chalk.white(currentPath));
    console.log('');
    console.log(
      chalk.gray(
        "Quick safety check: Is this a project you created or one you trust? If not, review this folder before continuing."
      )
    );
    console.log('');
    console.log(chalk.gray("Aeris will be able to read, edit, and execute files here."));
    console.log('');
    console.log(chalk.gray('Security guide'));
    console.log('');
  }

  private async renderHomeTrustStatus(): Promise<void> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      const status = trusted ? chalk.green('trusted') : chalk.yellow('not trusted');
      console.log(chalk.dim('  Trust Check: ') + status);
      console.log(chalk.dim('  Current path: ') + chalk.cyan(currentPath));
      if (!trusted) {
        console.log(chalk.dim('  Run ') + chalk.cyan('/trustpath') + chalk.dim(' to trust this directory'));
      }
    } catch {
      console.log(chalk.red('  Trust Check: failed'));
    }
  }

  private setupReadline(): void {
    this.bindLineModeHandlers();
    this.bindInputAssistHandlers();
  }

  private createReadlineInterface(): readline.Interface {
    const isTerminal = Boolean(process.stdout.isTTY);
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan(this.getPromptText()),
      completer: this.autoCompleter.completer.bind(this.autoCompleter),
      terminal: isTerminal,
    });
  }

  private bindLineModeHandlers(): void {
    this.rl.removeAllListeners('line');
    this.rl.removeAllListeners('SIGINT');

    this.rl.on('line', async (line) => {
      this.isLineProcessing = true;
      try {
        this.clearInlineSuggestions();
        this.clearPromptEchoBlock();
        const input = line.trim();
        if (input) {
          await this.handleInput(input);
        }
      } finally {
        this.isLineProcessing = false;
        if (!this.isInteractiveCommandActive) {
          this.showPrompt();
        }
      }
    });

    this.rl.on('SIGINT', () => {
      this.exitWithFarewell();
    });
  }

  private bindInputAssistHandlers(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    readline.emitKeypressEvents(process.stdin, this.rl);
    process.stdin.removeListener('keypress', this.onInputAssistKeypress);
    process.stdin.on('keypress', this.onInputAssistKeypress);
  }

  private getCurrentReadlineInput(): string {
    const rlWithLine = this.rl as readline.Interface & { line?: string };
    return typeof rlWithLine.line === 'string' ? rlWithLine.line : '';
  }

  private updateInlineSuggestionsFromReadline(force = false): void {
    if (!this.canRenderInlineSuggestions()) {
      return;
    }

    const line = this.getCurrentReadlineInput();
    const trimmed = line.trimStart();

    if (!trimmed.startsWith('/')) {
      this.clearInlineSuggestions();
      this.lastInlineSuggestionQuery = '';
      return;
    }

    const query = trimmed.slice(1).toLowerCase();
    if (!force && query === this.lastInlineSuggestionQuery && this.inlineSuggestionLines > 0) {
      return;
    }

    const lines = this.autoCompleter.getSuggestionLines(trimmed, 6);
    this.renderInlineSuggestions(lines);
    this.lastInlineSuggestionQuery = query;
  }

  private renderInlineSuggestions(lines: string[]): void {
    if (!this.canRenderInlineSuggestions()) {
      return;
    }

    this.clearInlineSuggestions();
    if (lines.length === 0) {
      return;
    }

    const safeLines = this.fitSuggestionLinesToTerminal(lines);
    const promptWidth = this.getDisplayWidth(this.promptPrefix);
    const inputWidth = this.getDisplayWidth(this.getCurrentReadlineInput());

    readline.moveCursor(process.stdout, 0, 1);
    safeLines.forEach((line, index) => {
      readline.clearLine(process.stdout, 0);
      process.stdout.write(line);
      if (index < safeLines.length - 1) {
        process.stdout.write('\n');
      }
    });

    readline.moveCursor(process.stdout, 0, -safeLines.length);
    readline.cursorTo(process.stdout, promptWidth + inputWidth);

    this.inlineSuggestionLines = safeLines.length;
  }

  private clearInlineSuggestions(): void {
    if (!process.stdout.isTTY || this.inlineSuggestionLines === 0 || this.promptVisibleLines === 0) {
      return;
    }

    const promptWidth = this.getDisplayWidth(this.promptPrefix);
    const inputWidth = this.getDisplayWidth(this.getCurrentReadlineInput());

    readline.moveCursor(process.stdout, 0, 1);
    for (let i = 0; i < this.inlineSuggestionLines; i++) {
      readline.clearLine(process.stdout, 0);
      if (i < this.inlineSuggestionLines - 1) {
        readline.moveCursor(process.stdout, 0, 1);
      }
    }

    readline.moveCursor(process.stdout, 0, -this.inlineSuggestionLines);
    readline.cursorTo(process.stdout, promptWidth + inputWidth);
    this.inlineSuggestionLines = 0;
  }

  private clearSuggestions(): void {
    this.clearInlineSuggestions();
    this.autoCompleter.resetSuggestions();
    this.lastInlineSuggestionQuery = '';
  }

  private clearPromptEchoBlock(): void {
    if (!process.stdout.isTTY) {
      return;
    }

    const rlMaybeClosed = this.rl as readline.Interface & { closed?: boolean };
    if (rlMaybeClosed.closed) {
      return;
    }

    if (this.promptVisibleLines <= 0) {
      return;
    }

    // Remove only the visible prompt block (divider + prompt line), do not erase chat content above it.
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    for (let i = 1; i < this.promptVisibleLines; i++) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }

    this.promptVisibleLines = 0;
  }

  private canRenderInlineSuggestions(): boolean {
    return Boolean(
      process.stdin.isTTY &&
        process.stdout.isTTY &&
        !this.isInteractiveCommandActive &&
        !this.isLineProcessing &&
        this.promptVisibleLines > 0
    );
  }

  private setReadlineInput(value: string): void {
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(value);
  }

  private fitSuggestionLinesToTerminal(lines: string[]): string[] {
    const columns = Math.max(20, (process.stdout.columns ?? 120) - 1);
    return lines.map((line) => this.truncateAnsiLine(line, columns));
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

  private async handleInput(input: string): Promise<void> {
    this.clearInlineSuggestions();
    this.lastInlineSuggestionQuery = '';

    if (input.startsWith('/')) {
      const normalizedCommand = input.slice(1).trim().split(/\s+/)[0]?.toLowerCase() || 'unknown';
      const safeInput = this.maskSensitiveCommandInput(input);
      this.recordCommandData(normalizedCommand, `invoked ${safeInput}`);
      this.uiRenderer.renderCommandInvocation(safeInput);
      await this.commandHandler.handleCommand(input);
      if (normalizedCommand === 'clear') {
        this.commandDataHistory = [];
      }
      return;
    }

    this.conversationManager.addMessage('user', input);
    this.uiRenderer.renderLastMessage();

    const spinner = new Spinner();
    console.log('');
    spinner.start('Thinking...');

    try {
      const response = await this.llmClient.generateReply(this.conversationManager.getMessages());
      spinner.stop();
      this.conversationManager.addMessage(
        'assistant',
        response.content,
        response.appendix ? { appendix: response.appendix } : undefined
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
    if ((normalizedCommand === 'apikey' || normalizedCommand === 'setkey') && rest.length > 0) {
      return `/${command} ********`;
    }

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

  private async startConfigFlow(): Promise<void> {
    this.isInteractiveCommandActive = true;
    this.clearSuggestions();

    try {
      const config = await this.configStore.getStoredConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const current = config.providers.claude ?? {};

      await this.renderConfigHeader(diagnostics);
      this.renderClaudeSnapshot(current);
      this.renderEnvironmentStatusLines(diagnostics);

      const update: ProviderConfig = {};

      this.renderConfigStep('Step 1/3', 'API key');
      if (current.apiKey?.trim()) {
        const { apiKeyMode } = await inquirer.prompt<{ apiKeyMode: 'keep' | 'update' | 'clear' }>([
          {
            type: 'list',
            name: 'apiKeyMode',
            message: 'How should we handle the API key?',
            choices: [
              { name: 'Keep current key', value: 'keep' },
              { name: 'Update API key', value: 'update' },
              { name: 'Clear API key', value: 'clear' },
            ],
          },
        ]);

        if (apiKeyMode === 'keep') {
          await this.showWelcome();
          this.uiRenderer.renderCommandInvocation('/modelconfig');
          this.uiRenderer.renderCommandResult('No config changes made');
          this.recordCommandData('modelconfig', 'No config changes made');
          return;
        } else if (apiKeyMode === 'update') {
          const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
            {
              type: 'password',
              name: 'apiKey',
              message: 'Enter new API key',
              mask: '*',
              validate: (value: string) => Boolean(value.trim()) || 'API key cannot be empty',
            },
          ]);
          update.apiKey = apiKey.trim();
        } else if (apiKeyMode === 'clear') {
          update.apiKey = undefined;
        }
      } else {
        const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
          {
            type: 'password',
            name: 'apiKey',
            message: 'Enter Claude API key (optional, can be configured later)',
            mask: '*',
          },
        ]);
        if (apiKey.trim()) {
          update.apiKey = apiKey.trim();
        }
      }

      this.renderConfigStep('Step 2/3', 'Base URL');
      const currentBaseUrl = current.baseUrl?.trim();
      if (currentBaseUrl) {
        const { baseUrlMode } = await inquirer.prompt<{ baseUrlMode: 'keep' | 'update' | 'default' }>([
          {
            type: 'list',
            name: 'baseUrlMode',
            message: `Current Base URL: ${currentBaseUrl}. What do you want to do?`,
            choices: [
              { name: 'Keep current Base URL', value: 'keep' },
              { name: 'Update Base URL', value: 'update' },
              { name: `Reset to default (${CLAUDE_META.defaultBaseUrl})`, value: 'default' },
            ],
            default: 'keep',
          },
        ]);

        if (baseUrlMode === 'update') {
          const { baseUrl } = await inquirer.prompt<{ baseUrl: string }>([
            {
              type: 'input',
              name: 'baseUrl',
              message: 'Enter custom Base URL',
              default: currentBaseUrl,
              validate: (value: string) => Boolean(value.trim()) || 'Base URL cannot be empty',
            },
          ]);
          update.baseUrl = baseUrl.trim();
        } else if (baseUrlMode === 'default') {
          update.baseUrl = undefined;
        }
      } else {
        const { useCustomBaseUrl } = await inquirer.prompt<{ useCustomBaseUrl: boolean }>([
          {
            type: 'confirm',
            name: 'useCustomBaseUrl',
            message: `Use a custom Base URL? (default: ${CLAUDE_META.defaultBaseUrl})`,
            default: false,
          },
        ]);

        if (useCustomBaseUrl) {
          const { baseUrl } = await inquirer.prompt<{ baseUrl: string }>([
            {
              type: 'input',
              name: 'baseUrl',
              message: 'Enter custom Base URL',
              default: CLAUDE_META.defaultBaseUrl,
              validate: (value: string) => Boolean(value.trim()) || 'Base URL cannot be empty',
            },
          ]);
          update.baseUrl = baseUrl.trim();
        }
      }

      this.renderConfigStep('Step 3/3', 'Model name');
      const { model } = await inquirer.prompt<{ model: string }>([
        {
          type: 'input',
          name: 'model',
          message: 'Enter Claude model name',
          default: current.model?.trim() || '',
          validate: (value: string) => Boolean(value.trim()) || 'Model name cannot be empty',
        },
      ]);
      update.model = model.trim();

      await this.configStore.setProviderConfig('claude', update);
      await this.configStore.setActiveProvider('claude');

      const resolveNext = <K extends keyof ProviderConfig>(key: K): ProviderConfig[K] => {
        return Object.prototype.hasOwnProperty.call(update, key) ? update[key] : current[key];
      };

      this.renderConfigSummary({
        apiKey: resolveNext('apiKey'),
        baseUrl: resolveNext('baseUrl'),
        model: resolveNext('model'),
      });
      this.uiRenderer.renderCommandResult('Claude configuration updated');
      this.recordCommandData('modelconfig', 'Claude configuration updated');
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        this.uiRenderer.renderCommandResult('Config dialog dismissed');
        this.recordCommandData('modelconfig', 'Config dialog dismissed');
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to complete config flow';
      this.uiRenderer.renderError(message);
      this.recordCommandData('modelconfig', `failed: ${message}`);
    } finally {
      this.isInteractiveCommandActive = false;
      this.autoCompleter.resetSuggestions();
      this.applyBlockCursorStyle();
      this.ensureInputReadyAfterConfig();
    }
  }

  private async handleApiKeySwitch(args: string[]): Promise<void> {
    const invokedCommand = args.length > 0 ? '/apikey ********' : '/apikey';

    try {
      const rawInput = args.join(' ').trim();

      if (rawInput) {
        const normalized = rawInput.toLowerCase();
        if (normalized === 'clear' || normalized === 'unset' || normalized === 'remove') {
          await this.configStore.setProviderConfig('claude', { apiKey: undefined });
          await this.configStore.setActiveProvider('claude');
          await this.refreshHomeAfterModelCommand(invokedCommand, 'Claude API key cleared (local config updated)');
          return;
        }

        await this.configStore.setProviderConfig('claude', { apiKey: rawInput });
        await this.configStore.setActiveProvider('claude');
        await this.refreshHomeAfterModelCommand(invokedCommand, 'Claude API key updated (local config updated)');
        return;
      }

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        this.uiRenderer.renderError('Usage: /apikey [your-api-key|clear]');
        this.recordCommandData('apikey', 'failed: Non-interactive mode requires inline API key or clear.');
        return;
      }

      this.isInteractiveCommandActive = true;
      this.clearSuggestions();
      const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
        {
          type: 'password',
          name: 'apiKey',
          message: 'Enter Claude API key (type "clear" to remove)',
          mask: '*',
          validate: (value: string) => Boolean(value.trim()) || 'API key cannot be empty',
        },
      ]);

      const normalized = apiKey.trim().toLowerCase();
      if (normalized === 'clear' || normalized === 'unset' || normalized === 'remove') {
        await this.configStore.setProviderConfig('claude', { apiKey: undefined });
        await this.configStore.setActiveProvider('claude');
        await this.refreshHomeAfterModelCommand(invokedCommand, 'Claude API key cleared (local config updated)');
        return;
      }

      await this.configStore.setProviderConfig('claude', { apiKey: apiKey.trim() });
      await this.configStore.setActiveProvider('claude');
      await this.refreshHomeAfterModelCommand(invokedCommand, 'Claude API key updated (local config updated)');
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        this.uiRenderer.renderCommandResult('API key update canceled');
        this.recordCommandData('apikey', 'API key update canceled');
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to update API key';
      this.uiRenderer.renderError(message);
      this.recordCommandData('apikey', `failed: ${message}`);
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
      const providerConfig = config.providers.claude ?? {};
      const apiKey = providerConfig.apiKey?.trim();
      if (!apiKey) {
        this.uiRenderer.renderError('Claude API key is missing. Set AERIS_CLAUDE_API_KEY or run /modelconfig first.');
        this.recordCommandData(
          'model',
          'failed: Claude API key is missing. Set AERIS_CLAUDE_API_KEY or run /modelconfig first.'
        );
        return;
      }

      const currentBaseUrl = providerConfig.baseUrl?.trim() || CLAUDE_META.defaultBaseUrl;
      const currentConfiguredModel = providerConfig.model?.trim();
      const currentEffectiveModel = currentConfiguredModel || 'Not set';
      let targetModel: string | undefined;

      if (args.length > 0) {
        const rawInput = args.join(' ').trim();
        if (!rawInput) {
          await this.refreshHomeAfterModelCommand(invokedCommand, `Current model: ${currentEffectiveModel}`);
          return;
        }

        const availableModels = await this.fetchAvailableModels(currentBaseUrl, apiKey);
        if (!availableModels.includes(rawInput)) {
          const preview = availableModels.slice(0, 10).join(', ');
          const suffix = availableModels.length > 10 ? ', ...' : '';
          this.uiRenderer.renderError(`Model not available for current API key: ${rawInput}`);
          this.uiRenderer.renderInfo(`Available models: ${preview}${suffix}`);
          this.recordCommandData('model', `failed: model not available: ${rawInput}`);
          return;
        }
        targetModel = rawInput;
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          this.uiRenderer.renderError('Interactive model selection requires a TTY. Use /model <model-name> instead.');
          this.recordCommandData('model', 'failed: Interactive model selection requires a TTY.');
          return;
        }

        const availableModels = await this.fetchAvailableModels(currentBaseUrl, apiKey);
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

      const previousConfiguredModel = currentConfiguredModel;
      const previousEffectiveModel = currentEffectiveModel;
      const nextEffectiveModel = targetModel?.trim() || 'Not set';
      const normalizedPreviousConfigured = previousConfiguredModel?.trim() || '';
      const normalizedTarget = targetModel?.trim() || '';
      const isSameConfiguredValue = normalizedPreviousConfigured === normalizedTarget;

      if (isSameConfiguredValue) {
        await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${previousEffectiveModel}`);
        return;
      }

      await this.configStore.setProviderConfig('claude', { model: targetModel });
      await this.refreshHomeAfterModelCommand(invokedCommand, `Model switched: ${previousEffectiveModel} -> ${nextEffectiveModel}`);
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

  private async fetchAvailableModels(baseUrl: string, apiKey: string): Promise<string[]> {
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

    const url = `${normalizedBase}/models`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    const raw = await response.text();
    if (!response.ok) {
      const preview = raw.slice(0, 300);
      throw new Error(`Failed to fetch models (${response.status}) from ${url}: ${preview}`);
    }

    let payload: unknown;
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      throw new Error('Model list response is not valid JSON.');
    }

    const models = this.extractModelIds(payload);
    if (models.length === 0) {
      throw new Error('Model list response did not contain any model IDs.');
    }

    return models;
  }

  private extractModelIds(payload: unknown): string[] {
    const add = (result: string[], seen: Set<string>, value: unknown): void => {
      if (typeof value === 'string' && value.trim()) {
        const id = value.trim();
        if (!seen.has(id)) {
          seen.add(id);
          result.push(id);
        }
      }
    };

    const readCollection = (collection: unknown[], result: string[], seen: Set<string>): void => {
      collection.forEach((item) => {
        if (typeof item === 'string') {
          add(result, seen, item);
          return;
        }

        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          add(result, seen, record.id);
          add(result, seen, record.model);
          add(result, seen, record.name);
        }
      });
    };

    const result: string[] = [];
    const seen = new Set<string>();

    if (Array.isArray(payload)) {
      readCollection(payload, result, seen);
      return result;
    }

    if (!payload || typeof payload !== 'object') {
      return result;
    }

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      readCollection(record.data, result, seen);
    }
    if (Array.isArray(record.models)) {
      readCollection(record.models, result, seen);
    }

    return result;
  }

  private ensureInputReadyAfterConfig(): void {
    try {
      process.stdin.resume();
    } catch {
      // Ignore stdin resume errors.
    }

    const rlMaybeClosed = this.rl as readline.Interface & { closed?: boolean };
    if (rlMaybeClosed.closed) {
      this.rl = this.createReadlineInterface();
      this.bindLineModeHandlers();
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

  private async renderConfigHeader(diagnostics: ConfigDiagnostics): Promise<void> {
    const header = [
      chalk.bold('Claude API Configuration'),
      chalk.dim('Configure API Key / Base URL / Model'),
      '',
      `${chalk.gray('Default Base URL:')} ${chalk.cyan(CLAUDE_META.defaultBaseUrl)}`,
      `${chalk.gray('Config File:')} ${chalk.dim(this.configStore.getConfigPath())}`,
      `${chalk.gray('Environment Keys:')} ${chalk.dim('AERIS_CLAUDE_API_KEY, AERIS_CLAUDE_BASE_URL, AERIS_CLAUDE_MODEL')}`,
      diagnostics.loadedEnvFiles.length > 0
        ? `${chalk.gray('Loaded Env Files:')} ${chalk.dim(diagnostics.loadedEnvFiles.join(', '))}`
        : `${chalk.gray('Loaded Env Files:')} ${chalk.dim('none detected')}`,
    ].join('\n');

    console.log('');
    console.log(
      boxen(header, {
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        margin: { top: 0, right: 0, bottom: 1, left: 0 },
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' /modelconfig ',
        titleAlignment: 'left',
      })
    );
  }

  private renderClaudeSnapshot(config: ProviderConfig): void {
    const apiValue = config.apiKey?.trim() ? chalk.green(this.maskApiKey(config.apiKey)) : chalk.yellow('Not set');
    const baseUrlValue = config.baseUrl?.trim() ? chalk.white(config.baseUrl.trim()) : chalk.dim('Using default');
    const modelValue = config.model?.trim() ? chalk.white(config.model.trim()) : chalk.yellow('Not set');

    const snapshot = [
      `${chalk.gray('Current API Key')} : ${apiValue}`,
      `${chalk.gray('Current Base URL')} : ${baseUrlValue}`,
      `${chalk.gray('Current Model')} : ${modelValue}`,
    ].join('\n');

    console.log(
      boxen(snapshot, {
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        margin: { top: 0, right: 0, bottom: 1, left: 0 },
        borderStyle: 'single',
        borderColor: 'gray',
        title: ' Current State ',
        titleAlignment: 'left',
      })
    );
  }

  private renderConfigStep(title: string, subtitle: string): void {
    console.log(chalk.cyan(`  ${title}`) + chalk.dim(`  ${subtitle}`));
  }

  private renderEnvironmentStatusLines(diagnostics: ConfigDiagnostics): void {
    const providerSources = diagnostics.providerSources.claude;
    const envOverrides = this.getEnvironmentOverrideLabels(providerSources);

    if (diagnostics.loadedEnvFiles.length > 0) {
      console.log(chalk.dim('  Loaded env files: ') + chalk.cyan(diagnostics.loadedEnvFiles.join(', ')));
    }

    if (envOverrides.length === 0 && diagnostics.projectContextEnabledSource !== 'env') {
      return;
    }

    const segments = [...envOverrides];
    if (diagnostics.projectContextEnabledSource === 'env') {
      segments.push('Project Context');
    }

    console.log(chalk.yellow('  Environment override active: ') + chalk.white(segments.join(', ')));
    console.log(chalk.dim('  Runtime values from process.env/.env take precedence over saved local config'));
  }

  private getEnvironmentOverrideLabels(sources: ProviderConfigSources): string[] {
    const labels: string[] = [];

    if (sources.apiKey === 'env') {
      labels.push('API Key');
    }

    if (sources.baseUrl === 'env') {
      labels.push('Base URL');
    }

    if (sources.model === 'env') {
      labels.push('Model');
    }

    return labels;
  }

  private summarizeProviderConfigSource(sources: ProviderConfigSources): string {
    const runtimeSources = new Set(
      [sources.apiKey, sources.baseUrl, sources.model].filter((item) => item === 'env' || item === 'local')
    );

    if (runtimeSources.has('env') && runtimeSources.has('local')) {
      return 'mixed (environment + local)';
    }

    if (runtimeSources.has('env')) {
      return 'environment';
    }

    if (runtimeSources.has('local')) {
      return 'local config file';
    }

    return 'not configured';
  }

  private renderConfigSummary(config: ProviderConfig): void {
    const apiValue = config.apiKey?.trim() ? chalk.green(this.maskApiKey(config.apiKey)) : chalk.yellow('Not set');
    const baseUrlValue = config.baseUrl?.trim() ? chalk.white(config.baseUrl.trim()) : chalk.cyan(CLAUDE_META.defaultBaseUrl);
    const modelValue = config.model?.trim() ? chalk.white(config.model.trim()) : chalk.yellow('Not set');

    const summary = [
      `${chalk.gray('API Key')} : ${apiValue}`,
      `${chalk.gray('Base URL')} : ${baseUrlValue}`,
      `${chalk.gray('Model')} : ${modelValue}`,
    ].join('\n');

    console.log('');
    console.log(
      boxen(summary, {
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        borderStyle: 'round',
        borderColor: 'green',
        title: ' Saved ',
        titleAlignment: 'left',
      })
    );
  }

  private maskApiKey(apiKey?: string): string {
    const trimmed = apiKey?.trim() ?? '';
    if (!trimmed) return 'Not set';
    if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
    return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
  }

  private isPromptCancelError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ExitPromptError';
  }

  private exitWithFarewell(): never {
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
    this.rl.close();
  }
}
