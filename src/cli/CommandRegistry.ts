export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
}

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  constructor() {
    this.registerDefaultCommands();
  }

  private registerDefaultCommands(): void {
    this.register({ name: 'help', description: 'Show help information', usage: '/help' });
    this.register({ name: 'state', description: 'Show current project and runtime status', usage: '/state' });
    this.register({ name: 'clear', description: 'Clear conversation history', usage: '/clear' });
    this.register({ name: 'history', description: 'Show all conversation messages', usage: '/history' });
    this.register({ name: 'collapse', description: 'Collapse messages', usage: '/collapse [id|all]' });
    this.register({ name: 'expand', description: 'Expand messages', usage: '/expand [id|all]' });
    this.register({ name: 'exit', description: 'Exit the program', aliases: ['quit'], usage: '/exit' });
    this.register({ name: 'analyze', description: 'Analyze conversation pattern', usage: '/analyze' });
    this.register({
      name: 'export',
      description: 'Export current diagnostic data as JSON for Claude or Codex sessions',
      usage: '/export [claude|codex]',
    });
    this.register({
      name: 'model',
      description: 'Set the active API model for the current provider',
      usage: '/model [model-name|clear]',
    });
    this.register({
      name: 'provider',
      description: 'Switch the active LLM provider',
      usage: '/provider [claude|openrouter|qwen]',
    });
    this.register({
      name: 'trustpath',
      description: 'Trust the current working directory',
      aliases: ['trust'],
      usage: '/trustpath',
    });
    this.register({
      name: 'trustcheck',
      description: 'Quickly check whether current directory is trusted',
      aliases: ['truststatus'],
      usage: '/trustcheck',
    });
    this.register({
      name: 'skills',
      description: 'Scan local SKILL.md files and render a Skills overview page',
      aliases: ['scan_skills', 'skillscan'],
      usage: '/skills [path]',
    });
    this.register({
      name: 'scan_prompt',
      description: 'Scan prompt/rules/agent assets in the current project',
      aliases: ['scanprompt'],
      usage: '/scan_prompt',
    });
    this.register({
      name: 'rules',
      description: 'Detect explicit project rules and instruction lines in a workspace',
      aliases: ['scan_rules', 'rulecheck'],
      usage: '/rules [path]',
    });
    this.register({
      name: 'scan_tokens',
      description: 'Parse Claude or Codex session JSONL token structures and render token analytics',
      aliases: ['scantokens', 'tokenscan'],
      usage: '/scan_tokens [claude|codex] [current|all|path]',
    });
    this.register({
      name: 'context_health',
      description: 'Check context window health from Claude or Codex usage records',
      aliases: ['ctxhealth', 'contexthealth'],
      usage: '/context_health [claude|codex] [current|all|path]',
    });
    this.register({
      name: 'noise_eval',
      description: 'Run evidence-first noise evaluation across outcome, process, context, and validation',
      aliases: ['noise'],
      usage: '/noise_eval [claude|codex] [current|all|path]',
    });
    this.register({
      name: 'context_noise',
      description: 'Legacy alias for the formal noise evaluation command',
      aliases: ['ctxnoise', 'contextnoise'],
      usage: '/context_noise [claude|codex] [current|all|path]',
    });
    this.register({
      name: 'todo_granularity',
      description: 'Analyze todo granularity against Claude or Codex context/token usage',
      aliases: ['todograin', 'todocontext'],
      usage: '/todo_granularity [claude|codex] [current|all|path]',
    });
    this.register({
      name: 'projectcontext',
      description: 'Toggle project context injection for model requests',
      aliases: ['projectctx'],
      usage: '/projectcontext [on|off|status]',
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

  getAllCommands(): Command[] {
    const uniqueCommands = new Map<string, Command>();
    this.commands.forEach((cmd, key) => {
      if (key === cmd.name) {
        uniqueCommands.set(cmd.name, cmd);
      }
    });
    return Array.from(uniqueCommands.values());
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
