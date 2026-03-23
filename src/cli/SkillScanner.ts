import { Dirent, promises as fs } from 'fs';
import path from 'path';
import { estimateTokenCount } from './tokenEstimate.js';

export type SkillResourceKind = 'agents' | 'scripts' | 'references' | 'assets' | 'examples' | 'templates' | 'other';

export interface SkillResourceSummary {
  kind: SkillResourceKind;
  label: string;
  relativePath: string;
  fileCount: number;
  samplePaths: string[];
}

export interface SkillSummary {
  name: string;
  title: string;
  description: string;
  shortDescription: string;
  purpose: string;
  whenToUse: string;
  relativeDir: string;
  skillFileRelativePath: string;
  headings: string[];
  resourceSummaries: SkillResourceSummary[];
  totalResourceFiles: number;
  instructionTokenEstimate: number;
}

export interface SkillScanResult {
  rootPath: string;
  scannedFileCount: number;
  skills: SkillSummary[];
  totalResourceFiles: number;
}

export interface SkillScanOptions {
  maxHeadings?: number;
  maxResourceSamples?: number;
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

const STANDARD_RESOURCE_DIRECTORIES: Array<{ name: string; kind: SkillResourceKind; label: string }> = [
  { name: 'agents', kind: 'agents', label: 'agents' },
  { name: 'scripts', kind: 'scripts', label: 'scripts' },
  { name: 'references', kind: 'references', label: 'references' },
  { name: 'assets', kind: 'assets', label: 'assets' },
  { name: 'examples', kind: 'examples', label: 'examples' },
  { name: 'templates', kind: 'templates', label: 'templates' },
];

const FRONTMATTER_BLOCK = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export class SkillScanner {
  async scan(rootPath: string, options?: SkillScanOptions): Promise<SkillScanResult> {
    const normalizedRoot = path.resolve(rootPath);
    const stack: string[] = [normalizedRoot];
    const skillFiles: string[] = [];
    let scannedFileCount = 0;

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
        if (entry.name.toLowerCase() === 'skill.md') {
          skillFiles.push(fullPath);
        }
      }
    }

    const skills = await Promise.all(
      skillFiles.map((skillFile) => this.readSkill(skillFile, normalizedRoot, options))
    );

    const sortedSkills = skills.sort(
      (a, b) =>
        a.relativeDir.localeCompare(b.relativeDir, 'en') ||
        a.name.localeCompare(b.name, 'en')
    );

    return {
      rootPath: normalizedRoot,
      scannedFileCount,
      skills: sortedSkills,
      totalResourceFiles: sortedSkills.reduce((sum, skill) => sum + skill.totalResourceFiles, 0),
    };
  }

  private async readSkill(skillFilePath: string, normalizedRoot: string, options?: SkillScanOptions): Promise<SkillSummary> {
    const raw = await fs.readFile(skillFilePath, 'utf8');
    const frontmatterMatch = raw.match(FRONTMATTER_BLOCK);
    const frontmatter = frontmatterMatch?.[1] ?? '';
    const body = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;
    const skillDir = path.dirname(skillFilePath);
    const relativeDirRaw = this.normalizeRelativePath(path.relative(normalizedRoot, skillDir));
    const relativeDir = relativeDirRaw || '.';

    const name = this.readFrontmatterValue(frontmatter, 'name') || path.basename(skillDir);
    const description = this.readFrontmatterValue(frontmatter, 'description');
    const shortDescription = this.readFrontmatterValue(frontmatter, 'short-description');
    const title = this.extractTitle(body) || this.toDisplayTitle(name);
    const purpose =
      this.extractPurpose(shortDescription, description) ||
      this.extractFirstParagraph(body) ||
      `Provide guidance for ${this.toDisplayTitle(name).toLowerCase()}.`;
    const whenToUse = this.extractWhenToUse(description) || this.extractWhenToUseFromBody(body);
    const headings = this.extractHeadings(body, options?.maxHeadings ?? 4);
    const resourceSummaries = await this.collectResourceSummaries(
      skillDir,
      normalizedRoot,
      options?.maxResourceSamples ?? 3
    );
    const totalResourceFiles = resourceSummaries.reduce((sum, resource) => sum + resource.fileCount, 0);

    return {
      name,
      title,
      description,
      shortDescription,
      purpose,
      whenToUse,
      relativeDir,
      skillFileRelativePath: this.normalizeRelativePath(path.relative(normalizedRoot, skillFilePath)),
      headings,
      resourceSummaries,
      totalResourceFiles,
      instructionTokenEstimate: estimateTokenCount(raw),
    };
  }

  private async collectResourceSummaries(
    skillDir: string,
    normalizedRoot: string,
    maxSamples: number
  ): Promise<SkillResourceSummary[]> {
    const resourceSummaries: SkillResourceSummary[] = [];

    for (const resource of STANDARD_RESOURCE_DIRECTORIES) {
      const fullPath = path.join(skillDir, resource.name);
      const stat = await this.tryStat(fullPath);
      if (!stat || !stat.isDirectory()) {
        continue;
      }

      const stats = await this.collectDirectoryStats(fullPath, normalizedRoot, maxSamples);
      resourceSummaries.push({
        kind: resource.kind,
        label: resource.label,
        relativePath: this.normalizeRelativePath(path.relative(normalizedRoot, fullPath)),
        fileCount: stats.fileCount,
        samplePaths: stats.samplePaths,
      });
    }

    const otherSummary = await this.collectOtherResourceSummary(skillDir, normalizedRoot, maxSamples);
    if (otherSummary) {
      resourceSummaries.push(otherSummary);
    }

    return resourceSummaries.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  }

  private async collectOtherResourceSummary(
    skillDir: string,
    normalizedRoot: string,
    maxSamples: number
  ): Promise<SkillResourceSummary | null> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(skillDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const reservedNames = new Set(['skill.md', ...STANDARD_RESOURCE_DIRECTORIES.map((resource) => resource.name.toLowerCase())]);
    let fileCount = 0;
    const samplePaths: string[] = [];

    for (const entry of entries) {
      const entryNameLower = entry.name.toLowerCase();
      if (reservedNames.has(entryNameLower)) {
        continue;
      }

      const fullPath = path.join(skillDir, entry.name);
      if (entry.isFile()) {
        fileCount += 1;
        if (samplePaths.length < maxSamples) {
          samplePaths.push(this.normalizeRelativePath(path.relative(normalizedRoot, fullPath)));
        }
        continue;
      }

      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entryNameLower)) {
        continue;
      }

      const stats = await this.collectDirectoryStats(fullPath, normalizedRoot, Math.max(0, maxSamples - samplePaths.length));
      fileCount += stats.fileCount;
      samplePaths.push(...stats.samplePaths);
    }

    if (fileCount === 0) {
      return null;
    }

    return {
      kind: 'other',
      label: 'extras',
      relativePath: this.normalizeRelativePath(path.relative(normalizedRoot, skillDir)),
      fileCount,
      samplePaths: samplePaths.slice(0, maxSamples),
    };
  }

  private async collectDirectoryStats(
    directoryPath: string,
    normalizedRoot: string,
    maxSamples: number
  ): Promise<{ fileCount: number; samplePaths: string[] }> {
    const stack: string[] = [directoryPath];
    let fileCount = 0;
    const samplePaths: string[] = [];

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

        fileCount += 1;
        if (samplePaths.length < maxSamples) {
          samplePaths.push(this.normalizeRelativePath(path.relative(normalizedRoot, fullPath)));
        }
      }
    }

    return { fileCount, samplePaths };
  }

  private extractTitle(body: string): string {
    const match = body.match(/^\s*#\s+(.+?)\s*$/m);
    return match ? this.normalizeText(match[1]) : '';
  }

  private extractPurpose(shortDescription: string, description: string): string {
    const short = this.normalizeText(shortDescription);
    if (short) {
      return short;
    }

    const normalizedDescription = this.normalizeText(description);
    if (!normalizedDescription) {
      return '';
    }

    const whenMatch = normalizedDescription.match(/\b(?:use this skill when|this skill should be used when|use when)\b/i);
    if (!whenMatch || whenMatch.index === undefined) {
      return normalizedDescription;
    }

    return normalizedDescription
      .slice(0, whenMatch.index)
      .trim()
      .replace(/[;,:-]+$/g, '')
      .trim();
  }

  private extractWhenToUse(description: string): string {
    const normalizedDescription = this.normalizeText(description);
    if (!normalizedDescription) {
      return '';
    }

    const whenMatch = normalizedDescription.match(/\b(?:use this skill when|this skill should be used when|use when)\b[\s,:-]*(.+)$/i);
    return whenMatch ? this.normalizeText(whenMatch[1]) : '';
  }

  private extractWhenToUseFromBody(body: string): string {
    const lines = body.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^##+\s+.*when to use/i.test(lines[index].trim())) {
        continue;
      }

      const paragraph: string[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor].trim();
        if (!line) {
          if (paragraph.length > 0) {
            break;
          }
          continue;
        }
        if (/^##+\s+/.test(line)) {
          break;
        }
        if (/^[-*+]|\d+\./.test(line)) {
          if (paragraph.length > 0) {
            break;
          }
          continue;
        }
        paragraph.push(line);
      }
      if (paragraph.length > 0) {
        return this.normalizeText(paragraph.join(' '));
      }
    }
    return '';
  }

  private extractFirstParagraph(body: string): string {
    const lines = body.split(/\r?\n/);
    const paragraph: string[] = [];
    let insideCodeFence = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('```')) {
        insideCodeFence = !insideCodeFence;
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }

      if (insideCodeFence) {
        continue;
      }

      if (!line) {
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }

      if (
        /^#/.test(line) ||
        /^>/.test(line) ||
        /^[-*+]\s+/.test(line) ||
        /^\d+\.\s+/.test(line) ||
        /^\|/.test(line)
      ) {
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }

      paragraph.push(line);
    }

    return this.normalizeText(paragraph.join(' '));
  }

  private extractHeadings(body: string, limit: number): string[] {
    const headings: string[] = [];
    const seen = new Set<string>();
    const lines = body.split(/\r?\n/);

    for (const rawLine of lines) {
      const match = rawLine.match(/^\s*##+\s+(.+?)\s*$/);
      if (!match) {
        continue;
      }

      const heading = this.normalizeText(match[1].replace(/`/g, ''));
      if (!heading || seen.has(heading)) {
        continue;
      }

      seen.add(heading);
      headings.push(heading);

      if (headings.length >= limit) {
        break;
      }
    }

    return headings;
  }

  private readFrontmatterValue(frontmatter: string, key: string): string {
    const lines = frontmatter.split(/\r?\n/);
    const keyPattern = new RegExp(`^\\s*${this.escapeRegExp(key)}:\\s*(.*)$`);

    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(keyPattern);
      if (!match) {
        continue;
      }

      const rawValue = match[1].trim();
      if (rawValue === '|' || rawValue === '>') {
        const block: string[] = [];
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const nextLine = lines[cursor];
          if (!/^\s+/.test(nextLine)) {
            break;
          }
          block.push(nextLine.trim());
          index = cursor;
        }
        const separator = rawValue === '>' ? ' ' : '\n';
        return this.normalizeText(block.join(separator));
      }

      return this.stripWrappingQuotes(rawValue);
    }

    return '';
  }

  private stripWrappingQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
        return trimmed.slice(1, -1).trim();
      }
    }
    return trimmed;
  }

  private toDisplayTitle(value: string): string {
    return value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((segment) => segment[0].toUpperCase() + segment.slice(1))
      .join(' ');
  }

  private normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.split(path.sep).join('/');
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async tryStat(targetPath: string): Promise<import('fs').Stats | null> {
    try {
      return await fs.stat(targetPath);
    } catch {
      return null;
    }
  }
}
