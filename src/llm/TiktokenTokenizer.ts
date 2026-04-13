import tiktoken from 'tiktoken';

const CL100K_BASE = 'cl100k_base';
const MAX_TOKEN_CACHE_SIZE = 500;

export class TiktokenTokenizer {
  private encoding: tiktoken.Tiktoken | null = null;
  private readonly tokenCache = new Map<string, number>();

  async countTextTokens(text: string): Promise<number> {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return 0;
    }

    const cached = this.tokenCache.get(normalized);
    if (typeof cached === 'number') {
      return cached;
    }

    const encoding = await this.getEncoding();
    const tokens = encoding.encode(normalized);
    const count = tokens.length;

    if (this.tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
      const oldest = this.tokenCache.keys().next().value;
      if (oldest !== undefined) {
        this.tokenCache.delete(oldest);
      }
    }
    this.tokenCache.set(normalized, count);
    return count;
  }

  private async getEncoding(): Promise<tiktoken.Tiktoken> {
    if (!this.encoding) {
      this.encoding = await tiktoken.get_encoding(CL100K_BASE);
    }
    return this.encoding;
  }

  clearCache(): void {
    this.tokenCache.clear();
  }
}