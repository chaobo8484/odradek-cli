import path from 'path';
import { ConfigStore } from '../cli/ConfigStore.js';
import { Message } from '../cli/ConversationManager.js';
import { estimateTokenCount } from '../cli/tokenEstimate.js';
import { createDefaultAdapters } from './adapters/createDefaultAdapters.js';
import { AdapterRuntimeConfig, LLMAdapter } from './adapters/types.js';
import { ProjectContextBuilder } from './ProjectContextBuilder.js';
import { PromptProfileResolver } from './PromptProfileResolver.js';
import { getProviderMeta } from '../config/providerCatalog.js';

export interface GeneratedReply {
  content: string;
  appendix?: string;
}

type CommandHistorySelection = {
  header: string;
  historyText: string;
};

type CommandHistoryEntry = {
  timestamp: string;
  command: string;
  data: string;
  raw: string;
};

export class LLMClient {
  private readonly configStore: ConfigStore;
  private readonly adapters: Map<LLMAdapter['provider'], LLMAdapter>;
  private readonly projectContextBuilder: ProjectContextBuilder;
  private readonly promptProfileResolver: PromptProfileResolver;
  private readonly commandDataContextProvider?: () => string;

  constructor(
    configStore: ConfigStore,
    adapters: LLMAdapter[] = createDefaultAdapters(),
    commandDataContextProvider?: () => string
  ) {
    this.configStore = configStore;
    this.adapters = new Map(adapters.map((item) => [item.provider, item]));
    this.projectContextBuilder = new ProjectContextBuilder();
    this.promptProfileResolver = new PromptProfileResolver();
    this.commandDataContextProvider = commandDataContextProvider;
  }

  async generateReply(messages: Message[]): Promise<GeneratedReply> {
    const config = await this.configStore.getConfig();
    const provider = config.activeProvider;
    const providerMeta = getProviderMeta(provider);
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`${providerMeta.displayName} adapter not found.`);
    }

    const providerConfig = config.providers[provider];
    const apiKey = providerConfig?.apiKey?.trim();
    const model = providerConfig?.model?.trim();

    if (!apiKey) {
      throw new Error(
        `${providerMeta.displayName} API key is not configured. Set ${providerMeta.envKeys.apiKey.join(' / ')} in .env and restart the CLI.`
      );
    }

    if (!model) {
      throw new Error(`${providerMeta.displayName} model is not configured. Set it in .env or use /model <model-name>.`);
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
    const promptMessages = await this.withConfiguredPromptContext(requestMessages, provider, model);
    const content = await adapter.generateReply(promptMessages, runtimeConfig);
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
    const historyText = this.commandDataContextProvider?.().trim();
    if (!historyText) {
      return messages;
    }

    const selection = this.selectCommandDataContext(latestUserQuery, historyText);
    if (!selection) {
      return messages;
    }

    const compactHistory = this.compactCommandHistory(selection.historyText);

    const contextMessage: Message = {
      id: `system_command_data_context_${Date.now()}`,
      role: 'system',
      content: [
        selection.header,
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

  private async withConfiguredPromptContext(
    messages: Message[],
    provider: LLMAdapter['provider'],
    model: string
  ): Promise<Message[]> {
    const promptProfile = await this.promptProfileResolver.resolve({
      workspaceRoot: process.cwd(),
      configRoot: path.dirname(this.configStore.getConfigPath()),
      provider,
      model,
    });

    if (!promptProfile) {
      return messages;
    }

    const contextMessage: Message = {
      id: `system_prompt_profile_${Date.now()}`,
      role: 'system',
      content: promptProfile.systemText,
      timestamp: new Date(),
      collapsed: false,
    };

    return [contextMessage, ...messages];
  }

  private selectCommandDataContext(query: string, historyText: string): CommandHistorySelection | null {
    const entries = this.parseCommandHistory(historyText);
    const latestNoiseEval = [...entries]
      .reverse()
      .find((entry) => entry.command === 'noise_eval' && entry.data !== '');

    if (latestNoiseEval && this.shouldIncludeNoiseEvaluation(query)) {
      return {
        header: 'Most recent /noise_eval summary is available below.',
        historyText: latestNoiseEval.raw,
      };
    }

    if (!this.shouldIncludeGenericCommandData(query)) {
      return null;
    }

    return {
      header: 'CLI command-generated data history is available below.',
      historyText,
    };
  }

  private shouldIncludeGenericCommandData(query: string): boolean {
    const normalized = query.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return (
      normalized.includes('scan_prompt') ||
      normalized.includes('/rules') ||
      normalized.includes('rules') ||
      normalized.includes('rule') ||
      normalized.includes('instruction') ||
      normalized.includes('guideline') ||
      normalized.includes('context anatomy') ||
      normalized.includes('token') ||
      normalized.includes('command') ||
      normalized.includes('scan') ||
      normalized.includes('history') ||
      normalized.includes('data') ||
      normalized.includes('规则') ||
      normalized.includes('指令') ||
      normalized.includes('约束') ||
      normalized.includes('命令') ||
      normalized.includes('扫描') ||
      normalized.includes('历史') ||
      normalized.includes('命令历史') ||
      normalized.includes('数据')
    );
  }

  private shouldIncludeNoiseEvaluation(query: string): boolean {
    const normalized = query.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const directNoiseKeywords = [
      'noise_eval',
      'context_noise',
      'noise evaluation',
      'noise report',
      'noise analysis',
      'coverage grade',
      'outcome noise',
      'process noise',
      'validation noise',
      'context noise',
      '噪声',
      '评估',
      '报告',
      '结论',
      '覆盖率',
    ];
    if (directNoiseKeywords.some((keyword) => normalized.includes(keyword))) {
      return true;
    }

    const followUpKeywords = [
      'analyze',
      'analysis',
      'improve',
      'improvement',
      'optimize',
      'optimization',
      'recommend',
      'recommendation',
      'suggest',
      'suggestion',
      'summary',
      'summarize',
      'explain',
      'interpret',
      'next action',
      'next step',
      'what should',
      '怎么看',
      '分析',
      '改进',
      '优化',
      '建议',
      '总结',
      '解释',
      '怎么做',
      '下一步',
      '刚才',
      '上面',
      '这个结果',
      '上述结果',
      '根据结果',
    ];

    return followUpKeywords.some((keyword) => normalized.includes(keyword));
  }

  private parseCommandHistory(historyText: string): CommandHistoryEntry[] {
    const lines = historyText.replace(/\r\n/g, '\n').split('\n');
    const entries: CommandHistoryEntry[] = [];
    const headerPattern = /^\[(.+?)\]\s+\/([a-z0-9_]+)\s*$/i;
    let current: Omit<CommandHistoryEntry, 'raw'> | null = null;

    const flushCurrent = () => {
      if (!current) {
        return;
      }

      const data = current.data.trim();
      entries.push({
        ...current,
        data,
        raw: [`[${current.timestamp}] /${current.command}`, data].filter(Boolean).join('\n').trim(),
      });
      current = null;
    };

    for (const line of lines) {
      if (line.trim() === 'Command data history:') {
        continue;
      }

      const headerMatch = line.match(headerPattern);
      if (headerMatch) {
        flushCurrent();
        current = {
          timestamp: headerMatch[1],
          command: headerMatch[2].toLowerCase(),
          data: '',
        };
        continue;
      }

      if (!current) {
        continue;
      }

      current.data = current.data ? `${current.data}\n${line}` : line;
    }

    flushCurrent();
    return entries;
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
