import { ConfigStore } from '../cli/ConfigStore.js';
import { ClaudeTokenizer } from './ClaudeTokenizer.js';
import { TiktokenTokenizer } from './TiktokenTokenizer.js';

export type TranscriptSource = 'claude' | 'codex' | 'cursor';

export class ModelTokenizer {
  private readonly claudeTokenizer: ClaudeTokenizer;
  private readonly tiktokenTokenizer: TiktokenTokenizer;

  constructor(configStore: ConfigStore) {
    this.claudeTokenizer = new ClaudeTokenizer(configStore);
    this.tiktokenTokenizer = new TiktokenTokenizer();
  }

  async countTextTokens(text: string, source: TranscriptSource = 'claude'): Promise<number> {
    if (source === 'claude') {
      return this.claudeTokenizer.countTextTokens(text);
    }
    return this.tiktokenTokenizer.countTextTokens(text);
  }

  async countTextTokensBatch(texts: string[], source: TranscriptSource = 'claude'): Promise<number[]> {
    if (source === 'claude') {
      const results: number[] = [];
      for (const text of texts) {
        results.push(await this.claudeTokenizer.countTextTokens(text));
      }
      return results;
    }
    const results: number[] = [];
    for (const text of texts) {
      results.push(await this.tiktokenTokenizer.countTextTokens(text));
    }
    return results;
  }

  async getActiveMode(): Promise<string> {
    return this.claudeTokenizer.getActiveMode();
  }

  clearCache(source?: TranscriptSource): void {
    if (!source || source === 'claude') {
    }
    if (!source || source === 'codex' || source === 'cursor') {
      this.tiktokenTokenizer.clearCache();
    }
  }
}