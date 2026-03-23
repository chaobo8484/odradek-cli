import { ConfigStore } from '../cli/ConfigStore.js';
import { Message } from '../cli/ConversationManager.js';
import { estimateTokenCount } from '../cli/tokenEstimate.js';
import { createDefaultAdapters } from './adapters/createDefaultAdapters.js';
import { AdapterRuntimeConfig, LLMAdapter } from './adapters/types.js';
import { ProjectContextBuilder } from './ProjectContextBuilder.js';

export interface GeneratedReply {
  content: string;
  appendix?: string;
}

export class LLMClient {
  private readonly configStore: ConfigStore;
  private readonly adapter: LLMAdapter;
  private readonly projectContextBuilder: ProjectContextBuilder;
  private readonly commandDataContextProvider?: () => string;

  constructor(
    configStore: ConfigStore,
    adapters: LLMAdapter[] = createDefaultAdapters(),
    commandDataContextProvider?: () => string
  ) {
    this.configStore = configStore;
    const claudeAdapter = adapters.find((item) => item.provider === 'claude');
    if (!claudeAdapter) {
      throw new Error('Claude adapter not found.');
    }
    this.adapter = claudeAdapter;
    this.projectContextBuilder = new ProjectContextBuilder();
    this.commandDataContextProvider = commandDataContextProvider;
  }

  async generateReply(messages: Message[]): Promise<GeneratedReply> {
    const config = await this.configStore.getConfig();
    const providerConfig = config.providers.claude;
    const apiKey = providerConfig?.apiKey?.trim();
    const model = providerConfig?.model?.trim();

    if (!apiKey) {
      throw new Error('Claude API key is not configured. Set AERIS_CLAUDE_API_KEY or run /modelconfig first.');
    }

    if (!model) {
      throw new Error('Claude model is not configured. Run /modelconfig or /model <model-name> first.');
    }

    const runtimeConfig: AdapterRuntimeConfig = {
      apiKey,
      baseUrl: providerConfig?.baseUrl,
      model,
    };
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const latestUserQuery = latestUserMessage?.content?.trim() ?? '';
    const projectContext = await this.withProjectContext(messages, config.projectContextEnabled, latestUserQuery);
    const requestMessages = this.withCommandDataContext(projectContext.messages, latestUserQuery);
    const content = await this.adapter.generateReply(requestMessages, runtimeConfig);
    return {
      content,
      appendix: projectContext.appendix,
    };
  }

  private async withProjectContext(
    messages: Message[],
    enabled: boolean,
    query: string
  ): Promise<{ messages: Message[]; appendix?: string }> {
    if (!enabled) {
      return { messages };
    }

    try {
      const context = await this.projectContextBuilder.build(process.cwd(), query);
      if (!context) {
        return { messages };
      }

      const contextMessage: Message = {
        id: `system_project_context_${Date.now()}`,
        role: 'system',
        content: `${context.prompt}\n\n- Machine-generated context evidence will be rendered separately after the assistant reply.`,
        timestamp: new Date(),
        collapsed: false,
      };

      return {
        messages: [contextMessage, ...messages],
        appendix: context.evidenceFooter,
      };
    } catch {
      return { messages };
    }
  }

  private withCommandDataContext(messages: Message[], latestUserQuery: string): Message[] {
    if (!this.shouldIncludeCommandData(latestUserQuery)) {
      return messages;
    }

    const historyText = this.commandDataContextProvider?.().trim();
    if (!historyText) {
      return messages;
    }

    const compactHistory = this.compactCommandHistory(historyText);

    const contextMessage: Message = {
      id: `system_command_data_context_${Date.now()}`,
      role: 'system',
      content: [
        'CLI command-generated data history is available below.',
        'Use this as factual context for analysis.',
        'If history does not contain required evidence, say it is missing.',
        '',
        compactHistory,
      ].join('\n'),
      timestamp: new Date(),
      collapsed: false,
    };

    return [contextMessage, ...messages];
  }

  private shouldIncludeCommandData(query: string): boolean {
    const normalized = query.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return (
      normalized.includes('scan_prompt') ||
      normalized.includes('context anatomy') ||
      normalized.includes('token') ||
      normalized.includes('命令') ||
      normalized.includes('扫描') ||
      normalized.includes('历史') ||
      normalized.includes('数据')
    );
  }

  private compactCommandHistory(historyText: string): string {
    const maxTokens = 850;
    if (estimateTokenCount(historyText) <= maxTokens) {
      return historyText;
    }

    const maxChars = 5200;
    const sliced = historyText.slice(Math.max(0, historyText.length - maxChars));
    return `...(truncated for token efficiency)\n${sliced}`;
  }
}
