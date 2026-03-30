import { Dirent, promises as fs } from 'fs';
import path from 'path';

export interface ExtractedRule {
  text: string;
  lineStart: number;
  lineEnd: number;
  headingPath: string[];
  signal: 'explicit' | 'section';
}

export interface RulesFile {
  relativePath: string;
  labels: string[];
  rules: ExtractedRule[];
}

export interface RulesScanResult {
  rootPath: string;
  scannedFileCount: number;
  candidateFileCount: number;
  matchedFileCount: number;
  totalRules: number;
  files: RulesFile[];
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.idea',
  '.vscode',
  '.cache',
  'coverage',
]);

const RULE_FILE_NAMES = new Set([
  'agents.md',
  'claude.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.rules',
  'copilot-instructions.md',
]);

const SYSTEM_PROMPT_NAME = /system[-_\s]?prompts?/i;
const CODE_FENCE_PATTERN = /^(```|~~~)/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_PATTERN = /^\s*(?:[-*+]|(?:\d+\.))\s+(?:\[[ xX]\]\s+)?(.+)$/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?[-:\s]+\|[-|:\s]*$/;
const INDENTED_CONTINUATION_PATTERN = /^(?:\s{2,}|\t+)/;
const EXPLICIT_RULE_PATTERN =
  /\b(?:must(?: not)?|should(?: not)?|always|never|do not|don't|avoid|prefer|only|required?|forbidden|need to|needs to|ensure|make sure|follow|keep|use|return|mark|state|separate|distinguish|report|validate|run|ship|read|trust|check|scan|toggle|support)\b/i;
const EXPLICIT_RULE_CN_PATTERN = /(必须|务必|禁止|不要|不得|应当|优先|避免|仅|只能|需要|确保|保持|遵循|标记|区分|报告|验证|返回|读取|检查|扫描|切换|规则|要求)/;
const INSTRUCTION_HEADING_PATTERN =
  /\b(?:rule|rules|instruction|instructions|guideline|guidelines|constraint|constraints|policy|policies|procedure|procedures|workflow|checklist|guardrail|convention|conventions|maintenance|validation|rollout|required output|output format|read this first|non-negotiable)\b/i;
const INSTRUCTION_HEADING_CN_PATTERN = /(规则|指令|要求|约束|流程|步骤|规范|维护|验证|输出|必读|注意)/;

export class RuleScanner {
  private static readonly MAX_FILE_BYTES = 512 * 1024;

  async scan(rootPath: string): Promise<RulesScanResult> {
    const normalizedRoot = path.resolve(rootPath);
    const stack: string[] = [normalizedRoot];
    const files: RulesFile[] = [];
    let scannedFileCount = 0;
    let candidateFileCount = 0;

    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) {
        continue;
      }

      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        scannedFileCount += 1;

        const relativePath = this.normalizeRelativePath(path.relative(normalizedRoot, fullPath));
        const labels = this.detectLabels(relativePath);
        if (labels.length === 0) {
          continue;
        }

        candidateFileCount += 1;
        const content = await this.readTextFile(fullPath);
        if (!content) {
          continue;
        }

        const rules = this.extractRules(content);
        if (rules.length === 0) {
          continue;
        }

        files.push({
          relativePath,
          labels,
          rules,
        });
      }
    }

    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const totalRules = files.reduce((sum, file) => sum + file.rules.length, 0);

    return {
      rootPath: normalizedRoot,
      scannedFileCount,
      candidateFileCount,
      matchedFileCount: files.length,
      totalRules,
      files,
    };
  }

  private detectLabels(relativePath: string): string[] {
    const normalized = relativePath.toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] ?? '';
    const directorySegments = segments.slice(0, -1);
    const labels = new Set<string>();

    if (RULE_FILE_NAMES.has(fileName)) {
      labels.add('rule-file');
    }
    if (fileName === 'agents.md') {
      labels.add('agents');
    }
    if (fileName === 'claude.md' || directorySegments.includes('.claude')) {
      labels.add('claude');
    }
    if (fileName === '.cursorrules' || directorySegments.includes('.cursor')) {
      labels.add('cursor');
    }
    if (fileName === '.windsurfrules' || directorySegments.includes('.windsurf')) {
      labels.add('windsurf');
    }
    if (fileName === '.clinerules') {
      labels.add('cline');
    }
    if (normalized === '.github/copilot-instructions.md' || fileName === 'copilot-instructions.md') {
      labels.add('copilot');
    }
    if (directorySegments.includes('rules')) {
      labels.add('rules-dir');
    }
    if (fileName.endsWith('.prompt')) {
      labels.add('prompt');
    }
    if (
      fileName.endsWith('.mdc') &&
      (directorySegments.includes('.cursor') || directorySegments.includes('.windsurf') || directorySegments.includes('rules'))
    ) {
      labels.add('mdc');
    }
    if (directorySegments.some((segment) => SYSTEM_PROMPT_NAME.test(segment)) || SYSTEM_PROMPT_NAME.test(fileName)) {
      labels.add('system-prompt');
    }
    if (normalized.startsWith('.odradek/system-prompts/')) {
      labels.add('odradek');
      labels.add('system-prompt');
    }

    return Array.from(labels).sort((left, right) => left.localeCompare(right));
  }

  private async readTextFile(fullPath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > RuleScanner.MAX_FILE_BYTES) {
        return null;
      }
    } catch {
      return null;
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      if (!content || content.includes('\u0000')) {
        return null;
      }
      return content;
    } catch {
      return null;
    }
  }

  private extractRules(content: string): ExtractedRule[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const rules: ExtractedRule[] = [];
    const seen = new Set<string>();
    const headings: string[] = [];
    let inCodeFence = false;
    let inFrontMatter = lines[0]?.trim() === '---';

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const trimmed = rawLine.trim();

      if (inFrontMatter) {
        if (index > 0 && trimmed === '---') {
          inFrontMatter = false;
        }
        continue;
      }

      if (CODE_FENCE_PATTERN.test(trimmed)) {
        inCodeFence = !inCodeFence;
        continue;
      }

      if (inCodeFence || !trimmed || TABLE_SEPARATOR_PATTERN.test(trimmed) || trimmed.startsWith('<!--')) {
        continue;
      }

      const headingMatch = trimmed.match(HEADING_PATTERN);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = this.normalizeRuleText(headingMatch[2]);
        headings.splice(level - 1);
        headings[level - 1] = headingText;
        continue;
      }

      const lineNumber = index + 1;
      const bulletMatch = rawLine.match(BULLET_PATTERN);
      const inInstructionSection = this.isInstructionSection(headings);

      if (bulletMatch) {
        let text = this.normalizeRuleText(bulletMatch[1]);
        if (!text) {
          continue;
        }

        const continuation = this.collectIndentedContinuation(lines, index + 1);
        if (continuation.text) {
          text = `${text} ${continuation.text}`.trim();
          index = continuation.nextIndex - 1;
        }

        const signal = this.looksLikeExplicitRule(text) ? 'explicit' : inInstructionSection ? 'section' : null;
        if (!signal || this.shouldIgnoreExtractedRule(text)) {
          continue;
        }

        this.insertRule(rules, seen, text, lineNumber, continuation.lineEnd ?? lineNumber, headings, signal);
        continue;
      }

      const text = this.normalizeRuleText(trimmed);
      if (!text || !this.looksLikeExplicitRule(text) || this.shouldIgnoreExtractedRule(text)) {
        continue;
      }

      this.insertRule(rules, seen, text, lineNumber, lineNumber, headings, 'explicit');
    }

    return rules;
  }

  private insertRule(
    target: ExtractedRule[],
    seen: Set<string>,
    text: string,
    lineStart: number,
    lineEnd: number,
    headings: string[],
    signal: 'explicit' | 'section'
  ): void {
    const normalizedText = text.toLowerCase();
    const dedupeKey = `${lineStart}:${normalizedText}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    target.push({
      text,
      lineStart,
      lineEnd,
      headingPath: headings.filter(Boolean).slice(-3),
      signal,
    });
  }

  private collectIndentedContinuation(lines: string[], startIndex: number): {
    text: string;
    nextIndex: number;
    lineEnd?: number;
  } {
    const parts: string[] = [];
    let cursor = startIndex;
    let lineEnd: number | undefined;

    while (cursor < lines.length) {
      const rawLine = lines[cursor];
      const trimmed = rawLine.trim();
      if (!trimmed) {
        break;
      }
      if (
        CODE_FENCE_PATTERN.test(trimmed) ||
        HEADING_PATTERN.test(trimmed) ||
        BULLET_PATTERN.test(rawLine) ||
        TABLE_SEPARATOR_PATTERN.test(trimmed)
      ) {
        break;
      }
      if (!INDENTED_CONTINUATION_PATTERN.test(rawLine)) {
        break;
      }

      const normalized = this.normalizeRuleText(trimmed);
      if (normalized) {
        parts.push(normalized);
        lineEnd = cursor + 1;
      }
      cursor += 1;
    }

    return {
      text: parts.join(' ').trim(),
      nextIndex: cursor,
      lineEnd,
    };
  }

  private isInstructionSection(headings: string[]): boolean {
    return headings.some(
      (heading) => INSTRUCTION_HEADING_PATTERN.test(heading) || INSTRUCTION_HEADING_CN_PATTERN.test(heading)
    );
  }

  private looksLikeExplicitRule(text: string): boolean {
    return EXPLICIT_RULE_PATTERN.test(text) || EXPLICIT_RULE_CN_PATTERN.test(text);
  }

  private shouldIgnoreExtractedRule(text: string): boolean {
    const normalized = text.trim();
    if (normalized.length < 4 || normalized.length > 320) {
      return true;
    }
    if (/^(?:example|examples|good|bad|note|notes)\s*:/i.test(normalized)) {
      return true;
    }
    if (/^(?:示例|例子|说明|备注)\s*[:：]/.test(normalized)) {
      return true;
    }
    if (/^you are\b/i.test(normalized)) {
      return true;
    }
    const stripped = normalized.replace(/[`'"]/g, '');
    if (/^(?:\.{0,2}[\\/]|[a-z]:[\\/]|[%~$a-z0-9_.-]+\/)[^\s]+$/i.test(stripped)) {
      return true;
    }
    if (/^https?:\/\//i.test(normalized)) {
      return true;
    }
    return false;
  }

  private normalizeRuleText(value: string): string {
    return value
      .replace(/^>\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.split(path.sep).join('/');
  }
}
