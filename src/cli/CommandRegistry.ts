export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  category?: string;
}

export type CommandResolution =
  | { status: 'exact' | 'prefix'; command: Command }
  | { status: 'ambiguous'; matches: Command[] }
  | { status: 'unknown' };

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  constructor() {
    this.registerDefaultCommands();
  }

  private registerDefaultCommands(): void {
    this.register({ name: 'help', description: 'Show help information', usage: '/help', category: 'Navigation' });
    this.register({
      name: 'menu',
      description: 'Open the interactive command menu',
      aliases: ['nav'],
      usage: '/menu',
      category: 'Navigation',
    });
    this.register({
      name: 'back',
      description: 'Return to the previous detail page or to home',
      aliases: ['return'],
      usage: '/back',
      category: 'Navigation',
    });
    this.register({
      name: 'home',
      description: 'Return to the home screen without changing the welcome layout',
      aliases: ['welcome'],
      usage: '/home',
      category: 'Navigation',
    });
    this.register({ name: 'state', description: 'Show current project and runtime status', usage: '/state', category: 'Workspace' });
    this.register({ name: 'clear', description: 'Clear conversation history', usage: '/clear', category: 'Session' });
    this.register({ name: 'history', description: 'Show all conversation messages', usage: '/history', category: 'Session' });
    this.register({ name: 'collapse', description: 'Collapse messages', usage: '/collapse [id|all]', category: 'Session' });
    this.register({ name: 'expand', description: 'Expand messages', usage: '/expand [id|all]', category: 'Session' });
    this.register({ name: 'exit', description: 'Exit the program', aliases: ['quit'], usage: '/exit', category: 'Navigation' });
    this.register({ name: 'analyze', description: 'Analyze conversation pattern', usage: '/analyze', category: 'Session' });
    this.register({
      name: 'export',
      description: 'Export current diagnostic data as JSON for Claude, Codex, or Cursor sessions',
      usage: '/export [claude|codex|cursor]',
      category: 'Session',
    });
    this.register({
      name: 'model',
      description: 'Set the active API model for the current provider',
      usage: '/model [model-name|clear]',
      category: 'Configuration',
    });
    this.register({
      name: 'provider',
      description: 'Switch the active LLM provider',
      usage: '/provider [claude|openrouter|qwen]',
      category: 'Configuration',
    });
    this.register({
      name: 'trustpath',
      description: 'Trust the current working directory',
      aliases: ['trust'],
      usage: '/trustpath',
      category: 'Configuration',
    });
    this.register({
      name: 'trustcheck',
      description: 'Quickly check whether current directory is trusted',
      aliases: ['truststatus'],
      usage: '/trustcheck',
      category: 'Configuration',
    });
    this.register({
      name: 'skills',
      description: 'Scan local SKILL.md files and render a Skills overview page',
      aliases: ['scan_skills', 'skillscan'],
      usage: '/skills [path|cursor]',
      category: 'Workspace',
    });
    this.register({
      name: 'scan_prompt',
      description: 'Scan prompt/rules/agent assets in the current project',
      aliases: ['scanprompt'],
      usage: '/scan_prompt',
      category: 'Workspace',
    });
    this.register({
      name: 'rules',
      description: 'Detect explicit project rules and instruction lines in a workspace',
      aliases: ['scan_rules', 'rulecheck'],
      usage: '/rules [path]',
      category: 'Workspace',
    });
    this.register({
      name: 'scan_tokens',
      description: 'Parse Claude, Codex, or Cursor session JSONL token structures and render token analytics',
      aliases: ['scantokens', 'tokenscan'],
      usage: '/scan_tokens [claude|codex|cursor] [current|all|path]',
      category: 'Workspace',
    });
    this.register({
      name: 'token_usage',
      description: 'Aggregate daily token usage by model from Claude, Codex, or Cursor session JSONL files',
      aliases: ['tokenusage', 'usage_tokens'],
      usage: '/token_usage [claude|codex|cursor] [current|all|path]',
      category: 'Workspace',
    });
    this.register({
      name: 'cost',
      description: 'Estimate current request cost from active model, prompt/context tokens, and OpenRouter pricing',
      aliases: ['pricing', 'estimate_cost'],
      usage: '/cost [codex|claude|cursor]',
      category: 'Workspace',
    });
    this.register({
      name: 'context_health',
      description: 'Check context window health from Claude, Codex, or Cursor usage records',
      aliases: ['ctxhealth', 'contexthealth'],
      usage: '/context_health [claude|codex|cursor] [current|all|path]',
      category: 'Workspace',
    });
    this.register({
      name: 'noise_eval',
      description: 'Run evidence-first noise evaluation across outcome, process, context, and validation',
      aliases: ['noise'],
      usage: '/noise_eval [claude|codex|cursor] [current|all|path]',
      category: 'Workspace',
    });
    this.register({
      name: 'context_noise',
      description: 'Legacy alias for the formal noise evaluation command',
      aliases: ['ctxnoise', 'contextnoise'],
      usage: '/context_noise [claude|codex|cursor] [current|all|path]',
      category: 'Workspace',
    });
    this.register({
      name: 'todo_granularity',
      description: 'Analyze todo granularity against Claude, Codex, or Cursor context/token usage',
      aliases: ['todograin', 'todocontext'],
      usage: '/todo_granularity [claude|codex|cursor] [current|all|path]',
      category: 'Workspace',
    });
    this.register({
      name: 'projectcontext',
      description: 'Toggle project context injection for model requests',
      aliases: ['projectctx'],
      usage: '/projectcontext [on|off|status]',
      category: 'Configuration',
    });
  }

  register(command: Command): void {
    this.commands.set(command.name, command);
    if (command.aliases) {
      command.aliases.forEach((alias) => {
        this.commands.set(alias, command);
      });
    }
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  resolveCommand(name: string): CommandResolution {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return { status: 'unknown' };
    }

    const exact = this.commands.get(normalized);
    if (exact) {
      return { status: 'exact', command: exact };
    }

    const prefixMatches = this.findCommandsByPrefix(normalized);
    if (prefixMatches.length === 1) {
      return { status: 'prefix', command: prefixMatches[0] };
    }

    if (prefixMatches.length > 1) {
      return { status: 'ambiguous', matches: prefixMatches };
    }

    return { status: 'unknown' };
  }

  getAllCommands(): Command[] {
    const uniqueCommands = new Map<string, Command>();
    this.commands.forEach((cmd, key) => {
      if (key === cmd.name) {
        uniqueCommands.set(cmd.name, cmd);
      }
    });
    return Array.from(uniqueCommands.values());
  }

  getCommandCategories(): string[] {
    return Array.from(
      new Set(
        this.getAllCommands()
          .map((command) => command.category?.trim())
          .filter((category): category is string => Boolean(category))
      )
    );
  }

  getCommandsByCategory(category: string): Command[] {
    return this.getAllCommands().filter((command) => command.category === category);
  }

  searchCommands(query: string): Command[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllCommands().filter(
      (cmd) => cmd.name.toLowerCase().startsWith(lowerQuery) || cmd.description.toLowerCase().includes(lowerQuery)
    );
  }

  getCommandNames(): string[] {
    return this.getAllCommands().map((cmd) => cmd.name);
  }

  findCommandsByPrefix(query: string): Command[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const matched = new Map<string, Command>();
    this.commands.forEach((command, key) => {
      if (key.toLowerCase().startsWith(normalized)) {
        matched.set(command.name, command);
      }
    });

    return Array.from(matched.values());
  }
}
