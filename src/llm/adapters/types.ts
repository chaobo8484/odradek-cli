import { ProviderConfig, ProviderName } from '../../cli/ConfigStore.js';
import { Message } from '../../cli/ConversationManager.js';

export interface AdapterRuntimeConfig extends ProviderConfig {
  apiKey: string;
  model: string;
}

export interface LLMAdapter {
  readonly provider: ProviderName;
  readonly displayName: string;
  readonly defaultBaseUrl: string;
  generateReply(messages: Message[], config: AdapterRuntimeConfig): Promise<string>;
}
