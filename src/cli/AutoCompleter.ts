import chalk from 'chalk';
import { CommandRegistry } from './CommandRegistry.js';

export class AutoCompleter {
  private commandRegistry: CommandRegistry;
  private currentSuggestions: string[] = [];
  private suggestionIndex = -1;
  private lastQuery = '';

  constructor(commandRegistry: CommandRegistry) {
    this.commandRegistry = commandRegistry;
  }

  completer(line: string): [string[], string] {
    if (!line.startsWith('/')) {
      return [[], line];
    }

    const query = line.slice(1);
    const commands = this.commandRegistry.searchCommands(query);
    const completions = commands.map((cmd) => '/' + cmd.name);

    return [completions, line];
  }

  getSuggestions(input: string): string[] {
    if (!input.startsWith('/')) {
      return [];
    }

    const query = input.slice(1);
    const commands = this.commandRegistry.searchCommands(query);

    return commands.map((cmd) => cmd.name);
  }

  renderSuggestions(input: string): string {
    const lines = this.getSuggestionLines(input, 6);
    if (lines.length === 0) {
      return '';
    }
    return '\n' + lines.join('\n');
  }

  getSuggestionLines(input: string, limit = 6): string[] {
    const suggestions = this.getSuggestions(input);
    if (suggestions.length === 0) {
      this.currentSuggestions = [];
      this.suggestionIndex = -1;
      return [];
    }

    const query = input.startsWith('/') ? input.slice(1).toLowerCase() : input.toLowerCase();
    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.suggestionIndex = 0;
    }

    this.currentSuggestions = suggestions;
    if (this.suggestionIndex < 0 || this.suggestionIndex >= suggestions.length) {
      this.suggestionIndex = 0;
    }

    const pageSize = Math.max(1, limit);
    const activeIndex = this.suggestionIndex;
    const windowStart = Math.floor(activeIndex / pageSize) * pageSize;
    const shown = suggestions.slice(windowStart, windowStart + pageSize);
    const maxCmdWidth = Math.max(...shown.map((name) => this.getDisplayWidth(`/${name}`)), this.getDisplayWidth('/command'));
    const commandColumnWidth = Math.min(28, maxCmdWidth + 2);
    const totalWidth = Math.max(40, process.stdout.columns ?? 120);
    const descWidth = Math.max(12, totalWidth - 6 - commandColumnWidth);

    const lines: string[] = [];
    shown.forEach((cmdName, offset) => {
      const command = this.commandRegistry.getCommand(cmdName);
      if (!command) {
        return;
      }

      const absoluteIndex = windowStart + offset;
      const isActive = absoluteIndex === activeIndex;
      const rawCommand = this.padToWidth(`/${cmdName}`, commandColumnWidth);
      // Keep suggestion rows short and stable to avoid terminal wrap artifacts while typing.
      const descBase = command.description || command.usage || '';
      const desc = this.truncateToWidth(descBase, descWidth);

      const marker = isActive ? chalk.white('> ') : chalk.dim('  ');
      const commandText = isActive ? chalk.blueBright(rawCommand) : chalk.gray(rawCommand);
      const descText = isActive ? chalk.rgb(192, 200, 255)(desc) : chalk.dim(desc);
      lines.push(` ${marker}${commandText}${descText}`);
    });

    if (suggestions.length > shown.length) {
      const currentPage = Math.floor(windowStart / pageSize) + 1;
      const totalPages = Math.ceil(suggestions.length / pageSize);
      lines.push(chalk.dim(`  ... page ${currentPage}/${totalPages}, ${suggestions.length} commands`));
    }

    return lines;
  }

  getCompletion(input: string): string | null {
    if (!input.startsWith('/')) {
      return null;
    }

    const query = input.slice(1);
    const suggestions = this.getSuggestions(input);

    if (this.suggestionIndex >= 0 && this.suggestionIndex < suggestions.length) {
      return '/' + suggestions[this.suggestionIndex];
    }

    if (suggestions.length === 1) {
      return '/' + suggestions[0];
    }

    if (suggestions.length > 1) {
      const commonPrefix = this.findCommonPrefix(suggestions);
      if (commonPrefix.length > query.length) {
        return '/' + commonPrefix;
      }
    }

    return null;
  }

  getHighlightedCompletion(input: string): string | null {
    if (!input.startsWith('/')) {
      return null;
    }

    const suggestions = this.getSuggestions(input);
    if (this.suggestionIndex >= 0 && this.suggestionIndex < suggestions.length) {
      return '/' + suggestions[this.suggestionIndex];
    }

    return null;
  }

  private findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (strings[i].indexOf(prefix) !== 0) {
        prefix = prefix.slice(0, -1);
        if (prefix === '') return '';
      }
    }
    return prefix;
  }

  nextSuggestion(): void {
    if (this.currentSuggestions.length > 0) {
      this.suggestionIndex = (this.suggestionIndex + 1) % this.currentSuggestions.length;
    }
  }

  previousSuggestion(): void {
    if (this.currentSuggestions.length > 0) {
      this.suggestionIndex =
        this.suggestionIndex <= 0 ? this.currentSuggestions.length - 1 : this.suggestionIndex - 1;
    }
  }

  resetSuggestions(): void {
    this.currentSuggestions = [];
    this.suggestionIndex = -1;
    this.lastQuery = '';
  }
  private truncateToWidth(text: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return '';
    }
    if (this.getDisplayWidth(text) <= maxWidth) {
      return text;
    }
    const suffix = maxWidth >= 3 ? '...' : '.';
    const target = maxWidth - this.getDisplayWidth(suffix);
    if (target <= 0) {
      return suffix.slice(0, maxWidth);
    }

    let result = '';
    for (const char of Array.from(text)) {
      const next = result + char;
      if (this.getDisplayWidth(next) > target) {
        break;
      }
      result = next;
    }
    return result + suffix;
  }

  private padToWidth(text: string, width: number): string {
    const current = this.getDisplayWidth(text);
    if (current >= width) {
      return text;
    }
    return text + ' '.repeat(width - current);
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

    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;

    if (
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    ) {
      return 0;
    }

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
}
