import { TiktokenTokenizer } from '../llm/TiktokenTokenizer.js';

const tiktokenTokenizer = new TiktokenTokenizer();

export async function countTokensBySource(text: string, source: 'claude' | 'codex' | 'cursor'): Promise<number> {
  return tiktokenTokenizer.countTextTokens(text);
}