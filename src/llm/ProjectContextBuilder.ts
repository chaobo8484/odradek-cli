import { promises as fs } from 'fs';
import path from 'path';
import { estimateTokenCount } from '../cli/tokenEstimate.js';
import {
  IndexedProjectFile,
  PersistentProjectIndex,
  ProjectIndexRuntime,
  SymbolReference,
} from './PersistentProjectIndex.js';

type CandidateSeed = {
  file: IndexedProjectFile;
  baseScore: number;
  reasons: Set<string>;
  matchedSymbols: Set<string>;
};

type CandidateContext = {
  file: IndexedProjectFile;
  score: number;
  reasons: string[];
  matchedSymbols: string[];
  snippet: string;
};

type MatchedSymbol = SymbolReference & {
  matchType: 'exact' | 'partial';
  score: number;
  matchedBy: string;
};

type ExplicitFileResolution = {
  files: IndexedProjectFile[];
  unresolved: string[];
};

export interface ProjectContextEvidence {
  indexedFiles: number;
  reusedFiles: number;
  refreshedFiles: number;
  skippedFiles: number;
  entrypoints: string[];
  readFiles: Array<{
    path: string;
    reasons: string[];
    matchedSymbols: string[];
  }>;
  matchedSymbols: string[];
  omissions: string[];
}

export interface ProjectContextBuildResult {
  prompt: string;
  scannedFiles: number;
  selectedFiles: number;
  tokenCount: number;
  evidence: ProjectContextEvidence;
  evidenceFooter: string;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'for',
  'of',
  'in',
  'on',
  'with',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'how',
  'what',
  'why',
  'when',
  'where',
  'can',
  'should',
  'would',
  'project',
  'code',
  'file',
  'files',
  'read',
  'reads',
  'agent',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '项目',
  '代码',
  '功能',
  '怎么',
  '如何',
  '一下',
]);

export class ProjectContextBuilder {
  private static readonly MAX_CANDIDATE_POOL = 40;
  private static readonly MAX_SELECTED_BLOCKS = 10;
  private static readonly MAX_FILES_PER_TOP_DIR = 4;
  private static readonly MAX_SNIPPET_CHARS = 1500;
  private static readonly MAX_SNIPPET_FOCUS_WINDOWS = 2;
  private static readonly MAX_CONTEXT_TOKENS = 2800;

  private readonly projectIndex = new PersistentProjectIndex();
  private readonly contentCache = new Map<string, { mtimeMs: number; content: string }>();

  async build(rootPath: string, userQuery: string): Promise<ProjectContextBuildResult | null> {
    const normalizedRoot = path.resolve(rootPath);
    const index = await this.projectIndex.load(normalizedRoot);
    if (index.files.length === 0) {
      return null;
    }

    const queryTerms = this.extractTerms(userQuery);
    const explicitFiles = await this.resolveExplicitFilesFromQuery(index, userQuery);
    const matchedSymbols = this.findMatchingSymbols(index, userQuery, queryTerms);
    const candidates = await this.selectCandidates(index, queryTerms, explicitFiles.files, matchedSymbols);

    const selected: CandidateContext[] = [];
    const dirUsage = new Map<string, number>();
    const overviewLines = this.buildOverviewLines(index, matchedSymbols);
    let prompt = [
      'READ-ONLY PROJECT ANALYSIS MODE:',
      '- Use only indexed project evidence and cite file paths.',
      '- If you infer beyond the evidence, say it is an inference.',
      '- Do not claim repository-wide certainty unless the supplied evidence supports it.',
      '- Do not append a separate evidence footer; the client renders it automatically.',
      '',
      `Project root: ${normalizedRoot}`,
      ...overviewLines,
      '',
      'Retrieved evidence:',
    ].join('\n');

    for (const candidate of candidates) {
      const dirKey = this.getTopDirectory(candidate.file.relativePath);
      const currentDirUse = dirUsage.get(dirKey) ?? 0;
      if (!candidate.reasons.includes('explicit-path') && currentDirUse >= ProjectContextBuilder.MAX_FILES_PER_TOP_DIR) {
        continue;
      }

      const symbolLabel =
        candidate.matchedSymbols.length > 0 ? ` | symbols=${candidate.matchedSymbols.slice(0, 4).join(', ')}` : '';
      const block = [
        '',
        `--- FILE: ${candidate.file.relativePath} | score=${candidate.score} | reason=${candidate.reasons.join(', ')}${symbolLabel} ---`,
        '```text',
        candidate.snippet,
        '```',
      ].join('\n');

      const nextPrompt = `${prompt}${block}`;
      if (estimateTokenCount(nextPrompt) > ProjectContextBuilder.MAX_CONTEXT_TOKENS) {
        continue;
      }

      prompt = nextPrompt;
      selected.push(candidate);
      dirUsage.set(dirKey, currentDirUse + 1);
      if (selected.length >= ProjectContextBuilder.MAX_SELECTED_BLOCKS) {
        break;
      }
    }

    const evidence = this.buildEvidence(index, matchedSymbols, explicitFiles, selected, candidates.length, queryTerms);
    if (selected.length === 0) {
      prompt = `${prompt}\n\n- No high-confidence file fit inside the token budget. Ask for a narrower file or symbol.`;
    }

    return {
      prompt,
      scannedFiles: index.files.length,
      selectedFiles: selected.length,
      tokenCount: estimateTokenCount(prompt),
      evidence,
      evidenceFooter: this.formatEvidenceFooter(evidence),
    };
  }

  private async selectCandidates(
    index: ProjectIndexRuntime,
    queryTerms: string[],
    explicitFiles: IndexedProjectFile[],
    matchedSymbols: MatchedSymbol[]
  ): Promise<CandidateContext[]> {
    const seeds = new Map<string, CandidateSeed>();
    const upsert = (file: IndexedProjectFile, score: number, reason: string, symbolName?: string): void => {
      const key = file.relativePath.toLowerCase();
      const existing = seeds.get(key);
      if (existing) {
        existing.baseScore = Math.max(existing.baseScore, score);
        existing.reasons.add(reason);
        if (symbolName) {
          existing.matchedSymbols.add(symbolName);
        }
        return;
      }

      seeds.set(key, {
        file,
        baseScore: score,
        reasons: new Set<string>([reason]),
        matchedSymbols: symbolName ? new Set<string>([symbolName]) : new Set<string>(),
      });
    };

    for (const entrypoint of index.entrypointFiles.slice(0, 8)) {
      upsert(entrypoint, 8, 'entrypoint');
    }

    for (const file of index.files) {
      const pathScore = this.scorePath(file, queryTerms);
      if (pathScore > 0) {
        upsert(file, pathScore, 'path-match');
      }
    }

    for (const file of explicitFiles) {
      upsert(file, 140, 'explicit-path');
    }

    for (const match of matchedSymbols) {
      upsert(match.file, match.score, match.matchType === 'exact' ? 'symbol-exact' : 'symbol-partial', match.symbol.name);
    }

    const expansionSeeds = Array.from(seeds.values())
      .sort((a, b) => b.baseScore - a.baseScore || a.file.relativePath.localeCompare(b.file.relativePath))
      .slice(0, 12);

    for (const seed of expansionSeeds) {
      const imports = index.resolvedImportsByFile.get(seed.file.relativePath) ?? [];
      for (const link of imports) {
        const target = index.byRelativePath.get(link.targetPath.toLowerCase());
        if (target) {
          upsert(target, 18, 'import-neighbor');
        }
      }

      const dependents = index.dependentsByFile.get(seed.file.relativePath) ?? new Set<string>();
      for (const dependentPath of dependents) {
        const dependent = index.byRelativePath.get(dependentPath.toLowerCase());
        if (dependent) {
          upsert(dependent, 14, 'dependent');
        }
      }

      const callRelated = index.callRelatedFilesByFile.get(seed.file.relativePath) ?? new Set<string>();
      const shouldExpandCallLinks = Array.from(seed.reasons).some((reason) =>
        reason === 'explicit-path' || reason === 'path-match' || reason.startsWith('symbol-')
      );
      if (shouldExpandCallLinks) {
        for (const relatedPath of callRelated) {
          const related = index.byRelativePath.get(relatedPath.toLowerCase());
          if (related) {
            upsert(related, 12, 'call-neighbor');
          }
        }
      }
    }

    const newestMtime = index.files.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
    const candidates: CandidateContext[] = [];
    for (const seed of Array.from(seeds.values())
      .sort((a, b) => b.baseScore - a.baseScore || a.file.relativePath.localeCompare(b.file.relativePath))
      .slice(0, ProjectContextBuilder.MAX_CANDIDATE_POOL)) {
      const content = await this.readFileCached(index.rootPath, seed.file);
      if (!content) {
        continue;
      }

      const focusTerms = this.buildFocusTerms(queryTerms, Array.from(seed.matchedSymbols));
      const score =
        seed.baseScore + this.scoreContent(content, focusTerms) + this.scoreRecency(seed.file, newestMtime);
      candidates.push({
        file: seed.file,
        score,
        reasons: Array.from(seed.reasons).sort((a, b) => a.localeCompare(b)),
        matchedSymbols: Array.from(seed.matchedSymbols).sort((a, b) => a.localeCompare(b)),
        snippet: this.buildSnippet(content, focusTerms, seed.file.relativePath),
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));
    return candidates;
  }

  private buildEvidence(
    index: ProjectIndexRuntime,
    matchedSymbols: MatchedSymbol[],
    explicitFiles: ExplicitFileResolution,
    selected: CandidateContext[],
    candidateCount: number,
    queryTerms: string[]
  ): ProjectContextEvidence {
    const symbolNames = Array.from(
      new Set(matchedSymbols.map((match) => match.symbol.name).filter(Boolean))
    ).slice(0, 10);

    return {
      indexedFiles: index.files.length,
      reusedFiles: index.stats.reusedFiles,
      refreshedFiles: index.stats.refreshedFiles,
      skippedFiles: index.stats.skippedFiles,
      entrypoints: index.entrypointFiles.slice(0, 6).map((file) => file.relativePath),
      readFiles: selected.map((candidate) => ({
        path: candidate.file.relativePath,
        reasons: candidate.reasons,
        matchedSymbols: candidate.matchedSymbols.slice(0, 4),
      })),
      matchedSymbols: symbolNames,
      omissions: this.buildOmissions(index, explicitFiles, matchedSymbols, selected.length, candidateCount, queryTerms),
    };
  }

  private buildOmissions(
    index: ProjectIndexRuntime,
    explicitFiles: ExplicitFileResolution,
    matchedSymbols: MatchedSymbol[],
    selectedCount: number,
    candidateCount: number,
    queryTerms: string[]
  ): string[] {
    const omissions: string[] = [];

    if (explicitFiles.unresolved.length > 0) {
      omissions.push(`Unresolved file hints: ${explicitFiles.unresolved.slice(0, 4).join(', ')}`);
    }

    if (queryTerms.length > 0 && matchedSymbols.length === 0) {
      omissions.push('No exact or partial symbol hit matched the current query terms');
    }

    if (index.stats.basicAnalysisFiles > 0) {
      omissions.push(`${index.stats.basicAnalysisFiles} files only have text-level symbol extraction`);
    }

    if (index.stats.unresolvedLocalImportCount > 0) {
      omissions.push(`${index.stats.unresolvedLocalImportCount} local import edges could not be resolved`);
    }

    if (index.skipped.length > 0) {
      omissions.push(`${index.skipped.length} files were skipped because they were too large or unreadable`);
    }

    if (candidateCount > selectedCount) {
      omissions.push(`Only the top ${selectedCount} files were attached to stay within the token budget`);
    }

    omissions.push('Call links are heuristic and do not cover dynamic dispatch or runtime-generated imports');
    return omissions.slice(0, 5);
  }

  private formatEvidenceFooter(evidence: ProjectContextEvidence): string {
    const lines = [
      'Context Evidence',
      `Index: ${evidence.indexedFiles} files (reused ${evidence.reusedFiles}, refreshed ${evidence.refreshedFiles}, skipped ${evidence.skippedFiles})`,
      `Entrypoints: ${evidence.entrypoints.length > 0 ? evidence.entrypoints.join(', ') : '(none)'}`,
      'Read files:',
    ];

    if (evidence.readFiles.length === 0) {
      lines.push('- (none)');
    } else {
      for (const file of evidence.readFiles.slice(0, 8)) {
        const symbolSuffix =
          file.matchedSymbols.length > 0 ? `; symbols=${file.matchedSymbols.join(', ')}` : '';
        lines.push(`- ${file.path} [${file.reasons.join(', ')}${symbolSuffix}]`);
      }
    }

    lines.push(`Matched symbols: ${evidence.matchedSymbols.length > 0 ? evidence.matchedSymbols.join(', ') : '(none)'}`);
    lines.push(`Gaps: ${evidence.omissions.join(' | ')}`);
    return lines.join('\n');
  }

  private buildOverviewLines(index: ProjectIndexRuntime, matchedSymbols: MatchedSymbol[]): string[] {
    const directoryCount = new Map<string, number>();
    const languageCount = new Map<string, number>();
    for (const file of index.files) {
      const head = this.getTopDirectory(file.relativePath);
      directoryCount.set(head, (directoryCount.get(head) ?? 0) + 1);
      languageCount.set(file.language, (languageCount.get(file.language) ?? 0) + 1);
    }

    const topDirectories = Array.from(directoryCount.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([name, count]) => `${name}(${count})`);

    const topLanguages = Array.from(languageCount.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([name, count]) => `${name}(${count})`);

    const topSymbolHits = Array.from(new Set(matchedSymbols.map((item) => item.symbol.name))).slice(0, 8);

    return [
      `- Indexed files: ${index.files.length}`,
      `- Index refresh: reused=${index.stats.reusedFiles}, refreshed=${index.stats.refreshedFiles}, skipped=${index.stats.skippedFiles}`,
      `- Top directories: ${topDirectories.length > 0 ? topDirectories.join(', ') : '(none)'}`,
      `- Languages: ${topLanguages.length > 0 ? topLanguages.join(', ') : '(none)'}`,
      `- Entrypoints: ${index.entrypointFiles.slice(0, 6).map((file) => file.relativePath).join(', ') || '(none)'}`,
      `- Symbol hits: ${topSymbolHits.length > 0 ? topSymbolHits.join(', ') : '(none)'}`,
      '- Retrieval strategy: path match + symbol table + import graph + heuristic call links',
    ];
  }

  private findMatchingSymbols(index: ProjectIndexRuntime, query: string, queryTerms: string[]): MatchedSymbol[] {
    const hints = this.extractSymbolHints(query, queryTerms);
    const matches = new Map<string, MatchedSymbol>();

    const maybeInsert = (reference: SymbolReference, matchType: 'exact' | 'partial', score: number, matchedBy: string): void => {
      const existing = matches.get(reference.symbol.id);
      if (existing && existing.score >= score) {
        return;
      }
      matches.set(reference.symbol.id, {
        ...reference,
        matchType,
        score,
        matchedBy,
      });
    };

    for (const hint of hints) {
      const exact = index.symbolLookup.get(hint.toLowerCase()) ?? [];
      if (exact.length > 0) {
        exact.slice(0, 8).forEach((reference) => maybeInsert(reference, 'exact', 56, hint));
        continue;
      }

      if (hint.length < 3) {
        continue;
      }

      const partialKeys = Array.from(index.symbolLookup.keys())
        .filter((key) => key.includes(hint.toLowerCase()))
        .slice(0, 8);
      for (const key of partialKeys) {
        const references = index.symbolLookup.get(key) ?? [];
        references.slice(0, 4).forEach((reference) => maybeInsert(reference, 'partial', 20, hint));
      }
    }

    return Array.from(matches.values()).sort((a, b) => {
      return (
        b.score - a.score ||
        a.file.relativePath.localeCompare(b.file.relativePath) ||
        a.symbol.line - b.symbol.line
      );
    });
  }

  private extractSymbolHints(query: string, queryTerms: string[]): string[] {
    const rawHints = query.match(/[A-Za-z_][A-Za-z0-9_.#]*/g) ?? [];
    const deduped = new Set<string>();
    for (const hint of [...rawHints, ...queryTerms]) {
      const normalized = hint.trim();
      if (!normalized || STOP_WORDS.has(normalized.toLowerCase())) {
        continue;
      }
      deduped.add(normalized);
    }
    return Array.from(deduped).slice(0, 20);
  }

  private async resolveExplicitFilesFromQuery(index: ProjectIndexRuntime, query: string): Promise<ExplicitFileResolution> {
    const rawTokens =
      query.match(/(?:[A-Za-z]:)?[\\/][^\s"'`]+|(?:\.\.?[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [];
    const normalizedTokens = rawTokens.map((token) => token.trim().replace(/\\/g, '/'));
    const resultByPath = new Map<string, IndexedProjectFile>();
    const unresolved = new Set<string>();

    for (const token of new Set(normalizedTokens)) {
      const absolutePath = this.resolveTokenPath(index.rootPath, token);
      if (!absolutePath || !this.isInsideRoot(index.rootPath, absolutePath)) {
        continue;
      }

      const relativePath = this.normalizePath(path.relative(index.rootPath, absolutePath));
      const indexedFile = index.byRelativePath.get(relativePath.toLowerCase());
      if (indexedFile) {
        resultByPath.set(indexedFile.relativePath.toLowerCase(), indexedFile);
      } else {
        unresolved.add(relativePath);
      }
    }

    const hintedFileNames = query.match(/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g)?.map((part) => part.toLowerCase()) ?? [];
    for (const hint of hintedFileNames.slice(0, 12)) {
      const matches = index.byFileName.get(hint) ?? [];
      for (const file of matches) {
        resultByPath.set(file.relativePath.toLowerCase(), file);
      }
    }

    return {
      files: Array.from(resultByPath.values()),
      unresolved: Array.from(unresolved.values()).slice(0, 6),
    };
  }

  private buildFocusTerms(queryTerms: string[], matchedSymbols: string[]): string[] {
    const result = new Set<string>();
    for (const term of queryTerms) {
      result.add(term.toLowerCase());
    }

    for (const symbol of matchedSymbols) {
      const lower = symbol.toLowerCase();
      result.add(lower);
      lower
        .split(/[^a-z0-9\u4e00-\u9fff]+/i)
        .filter((part) => part.length > 1)
        .forEach((part) => result.add(part));
    }

    return Array.from(result).slice(0, 24);
  }

  private scorePath(file: IndexedProjectFile, queryTerms: string[]): number {
    const lowerPath = file.relativePath.toLowerCase();
    let score = this.isPriorityFile(file) ? 6 : 0;
    for (const term of queryTerms) {
      if (lowerPath.includes(term)) {
        score += 8;
      }
      if (file.fileNameLower.includes(term)) {
        score += 5;
      }
    }
    return score;
  }

  private scoreContent(content: string, queryTerms: string[]): number {
    if (queryTerms.length === 0) {
      return 0;
    }

    const lower = content.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (term.length <= 1) {
        continue;
      }
      const hits = this.countOccurrences(lower, term.toLowerCase());
      if (hits > 0) {
        score += Math.min(10, hits + 2);
      }
    }
    return score;
  }

  private scoreRecency(file: IndexedProjectFile, newestMtime: number): number {
    if (!newestMtime || !file.mtimeMs || newestMtime <= file.mtimeMs) {
      return 2;
    }

    const ageMs = newestMtime - file.mtimeMs;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (ageMs <= oneDayMs) {
      return 2;
    }
    if (ageMs <= oneDayMs * 7) {
      return 1;
    }
    return 0;
  }

  private buildSnippet(content: string, focusTerms: string[], relativePath: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.length === 0) {
      return `(empty) ${relativePath}`;
    }

    const focusLines = this.findFocusLines(lines, focusTerms);
    const ranges = this.buildSnippetRanges(lines.length, focusLines, focusTerms.length > 0 ? 7 : 12);
    const sections = ranges.slice(0, ProjectContextBuilder.MAX_SNIPPET_FOCUS_WINDOWS).map((range) => {
      const title = `> lines ${range.start + 1}-${range.end}`;
      const picked = lines.slice(range.start, range.end).map((line, offset) => {
        const lineNo = `${range.start + offset + 1}`.padStart(4, ' ');
        return `${lineNo} | ${line}`;
      });
      return [title, ...picked].join('\n');
    });

    let snippet = sections.join('\n...\n');
    if (snippet.length > ProjectContextBuilder.MAX_SNIPPET_CHARS) {
      snippet = `${snippet.slice(0, ProjectContextBuilder.MAX_SNIPPET_CHARS)}\n...`;
    }
    return snippet;
  }

  private findFocusLines(lines: string[], focusTerms: string[]): number[] {
    if (lines.length === 0) {
      return [0];
    }

    const scored: Array<{ line: number; score: number }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase();
      let score = 0;
      for (const term of focusTerms) {
        if (lower.includes(term.toLowerCase())) {
          score += 4;
        }
      }
      if (lower.includes('class ') || lower.includes('function ') || lower.includes('export ')) {
        score += 2;
      }
      scored.push({ line: index, score });
    }

    scored.sort((a, b) => b.score - a.score || a.line - b.line);
    const picked = scored
      .slice(0, ProjectContextBuilder.MAX_SNIPPET_FOCUS_WINDOWS)
      .map((item) => item.line);
    return picked.length > 0 ? picked : [0];
  }

  private buildSnippetRanges(totalLines: number, focusLines: number[], radius: number): Array<{ start: number; end: number }> {
    const ranges = focusLines.map((line) => ({
      start: Math.max(0, line - radius),
      end: Math.min(totalLines, line + radius + 1),
    }));
    ranges.sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end + 1) {
        merged.push(range);
        continue;
      }
      last.end = Math.max(last.end, range.end);
    }

    return merged.length > 0 ? merged : [{ start: 0, end: Math.min(totalLines, radius * 2 + 1) }];
  }

  private extractTerms(query: string): string[] {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const splitCase = normalized.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const rawParts = splitCase.match(/[a-z0-9_]+|[\u4e00-\u9fff]{2,}/g) ?? [];
    const deduped = new Set<string>();
    const englishParts = splitCase.match(/[a-z][a-z0-9_]*/g) ?? [];
    for (const part of rawParts) {
      if (part.length <= 1 || STOP_WORDS.has(part)) {
        continue;
      }
      deduped.add(part);
      if (part.endsWith('s') && part.length > 4) {
        deduped.add(part.slice(0, -1));
      }
    }

    for (let index = 0; index < englishParts.length - 1; index += 1) {
      const left = englishParts[index];
      const right = englishParts[index + 1];
      if (STOP_WORDS.has(left) || STOP_WORDS.has(right)) {
        continue;
      }
      const combined = `${left}${right}`;
      if (combined.length > 3) {
        deduped.add(combined);
      }
    }

    return Array.from(deduped).slice(0, 24);
  }

  private isPriorityFile(file: IndexedProjectFile): boolean {
    const lower = file.relativePath.toLowerCase();
    return lower === 'package.json' || lower.endsWith('/readme.md') || lower.endsWith('/src/index.ts');
  }

  private async readFileCached(rootPath: string, file: IndexedProjectFile): Promise<string | null> {
    const fullPath = path.join(rootPath, file.relativePath);
    const cached = this.contentCache.get(fullPath);
    if (cached && cached.mtimeMs === file.mtimeMs) {
      return cached.content;
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      if (!content || content.includes('\u0000')) {
        return null;
      }
      this.contentCache.set(fullPath, { mtimeMs: file.mtimeMs, content });
      return content;
    } catch {
      return null;
    }
  }

  private getTopDirectory(relativePath: string): string {
    const [head] = relativePath.split('/');
    return head && head.trim() ? head : '.';
  }

  private resolveTokenPath(rootPath: string, token: string): string | null {
    const cleaned = token.replace(/^['"`]+|['"`]+$/g, '');
    if (!cleaned) {
      return null;
    }
    const maybeAbsolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(rootPath, cleaned);
    return path.resolve(maybeAbsolute);
  }

  private isInsideRoot(rootPath: string, candidatePath: string): boolean {
    const rel = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private normalizePath(inputPath: string): string {
    return inputPath.split(path.sep).join('/');
  }

  private countOccurrences(text: string, term: string): number {
    let count = 0;
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const found = text.indexOf(term, fromIndex);
      if (found === -1) {
        break;
      }
      count += 1;
      fromIndex = found + term.length;
    }
    return count;
  }
}
