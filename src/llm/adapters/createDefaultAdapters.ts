import { LLMAdapter } from './types.js';
import { ClaudeAdapter } from './ClaudeAdapter.js';

export function createDefaultAdapters(): LLMAdapter[] {
  return [new ClaudeAdapter()];
}
