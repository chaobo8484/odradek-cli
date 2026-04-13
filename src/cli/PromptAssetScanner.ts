import { Dirent, promises as fs } from 'fs';
import path from 'path';
import { estimateTokenCount } from './tokenEstimate.js';

export type PromptAssetCategory =
  | 'project-config'
  | 'prompt-file'
  | 'rules'
  | 'system-prompt'
  | 'docs';

export interface PromptAssetFile {
  relativePath: string;
  categories: PromptAssetCategory[];
  tokenCount: number;
}

export interface PromptScanResult {
  rootPath: string;
  scannedFileCount: number;
  files: PromptAssetFile[];
}

export interface PromptScanOptions {
  tokenCounter?: (text: string, filePath: string) => Promise<number>;
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

const SYSTEM_PROMPT_NAME = /system[-_\s]?prompts?/i;

export class PromptAssetScanner {
  async scan(rootPath: string, options?: PromptScanOptions): Promise<PromptScanResult> {
    const normalizedRoot = path.resolve(rootPath);
    const stack: string[] = [normalizedRoot];
    const files = new Map<string, Set<PromptAssetCategory>>();
    const tokenCountByFile = new Map<string, number>();
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

        const relativePath = this.normalizeRelativePath(path.relative(normalizedRoot, fullPath));
        const categories = this.detectCategories(relativePath);
        if (categories.length === 0) {
          continue;
        }

        if (!files.has(relativePath)) {
          files.set(relativePath, new Set<PromptAssetCategory>());
        }

        const categorySet = files.get(relativePath);
        if (!categorySet) {
          continue;
        }

        categories.forEach((category) => categorySet.add(category));
        if (!tokenCountByFile.has(relativePath)) {
          tokenCountByFile.set(relativePath, await this.readTokenCount(fullPath, options?.tokenCounter));
        }
      }
    }

    const matchedFiles: PromptAssetFile[] = Array.from(files.entries())
      .map(([relativePath, categories]) => ({
        relativePath,
        categories: Array.from(categories).sort((a, b) => a.localeCompare(b)),
        tokenCount: tokenCountByFile.get(relativePath) ?? 0,
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return {
      rootPath: normalizedRoot,
      scannedFileCount,
      files: matchedFiles,
    };
  }

  private detectCategories(relativePath: string): PromptAssetCategory[] {
    const categories: PromptAssetCategory[] = [];
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] ?? '';
    const fileNameLower = fileName.toLowerCase();
    const directorySegments = segments.slice(0, -1);
    const isRootFile = segments.length === 1;

    if (isRootFile) {
      if (fileNameLower === 'claude.md' || fileNameLower === 'agents.md' || fileNameLower.startsWith('readme')) {
        categories.push('project-config');
      }
    }

    // Recognize files inside .claude/ and .cursor/ directories as project-config.
    if (directorySegments.some((segment) => segment.toLowerCase() === '.claude' || segment.toLowerCase() === '.cursor')) {
      categories.push('project-config');
    }

    if (fileNameLower.endsWith('.prompt')) {
      categories.push('prompt-file');
    }

    if (
      directorySegments.some((segment) => segment.toLowerCase() === 'rules') ||
      fileNameLower === '.cursorrules' ||
      (fileNameLower.endsWith('.mdc') && directorySegments.some((segment) => segment.toLowerCase() === '.cursor'))
    ) {
      categories.push('rules');
    }

    const hasSystemPromptDirectory = directorySegments.some((segment) => SYSTEM_PROMPT_NAME.test(segment));
    const hasSystemPromptFileName = SYSTEM_PROMPT_NAME.test(fileNameLower);
    if (hasSystemPromptDirectory || hasSystemPromptFileName) {
      categories.push('system-prompt');
    }

    if (directorySegments.some((segment) => segment.toLowerCase() === 'docs')) {
      categories.push('docs');
    }

    return categories;
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.split(path.sep).join('/');
  }

  private async readTokenCount(
    fullPath: string,
    tokenCounter?: (text: string, filePath: string) => Promise<number>
  ): Promise<number> {
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      return 0;
    }

    if (tokenCounter) {
      return tokenCounter(content, fullPath);
    }

    return estimateTokenCount(content);
  }
}
