import http from 'node:http';
import https from 'node:https';
import { Message } from '../../cli/ConversationManager.js';
import { AdapterDiscoveryConfig, AdapterRuntimeConfig, LLMAdapter } from './types.js';

type QwenResponse = {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
      reasoning_content?: string;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  };
};

type QwenMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>
  | undefined;

type QwenModelsPayload = {
  data?: Array<{ id?: string }>;
};

type HttpResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T>(): Promise<T>;
};

export class QwenAdapter implements LLMAdapter {
  private static readonly DEFAULT_MAX_OUTPUT_TOKENS = 1024;
  readonly provider = 'qwen' as const;
  readonly displayName = 'Qwen';
  readonly defaultBaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  async generateReply(messages: Message[], config: AdapterRuntimeConfig): Promise<string> {
    const url = `${this.resolveBaseUrl(config.baseUrl)}/chat/completions`;
    const payload = {
      model: config.model.trim(),
      max_tokens: QwenAdapter.DEFAULT_MAX_OUTPUT_TOKENS,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };

    const response = await this.postJson(url, payload, this.buildHeaders(config.apiKey));
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(this.formatQwenError(response.status, errorText, config.model.trim()));
    }

    const data = await response.json<QwenResponse>();
    const content = data.choices?.[0]?.message?.content;
    const text = this.extractTextContent(content);

    if (!text) {
      throw new Error('Qwen returned an empty response.');
    }

    return text;
  }

  async listModels(config: AdapterDiscoveryConfig): Promise<string[]> {
    const url = `${this.resolveBaseUrl(config.baseUrl)}/models`;
    const response = await this.getJson(url, this.buildHeaders(config.apiKey));
    const raw = await response.text();

    if (!response.ok) {
      const preview = raw.slice(0, 300);
      throw new Error(`Failed to fetch Qwen models (${response.status}) from ${url}: ${preview}`);
    }

    const payload = raw ? (JSON.parse(raw) as QwenModelsPayload) : {};
    const models = (payload.data ?? [])
      .map((item) => item.id?.trim())
      .filter((item): item is string => Boolean(item));
    const filteredModels = this.filterPreferredModels(models);

    if (filteredModels.length === 0) {
      throw new Error('Qwen model list response did not contain any text/code model IDs.');
    }

    return filteredModels;
  }

  private resolveBaseUrl(customBaseUrl?: string): string {
    return (customBaseUrl?.trim() || this.defaultBaseUrl).replace(/\/+$/, '');
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
  }

  private extractTextContent(content: QwenMessageContent): string {
    if (typeof content === 'string') {
      return content.trim();
    }

    if (Array.isArray(content)) {
      return content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
        .trim();
    }

    return '';
  }

  private formatQwenError(status: number, errorText: string, model: string): string {
    const normalized = errorText.toLowerCase();

    if (status === 401 || status === 403) {
      return `Qwen authentication failed (${status}). Please check your DashScope API key and permissions.`;
    }

    if (
      status === 404 ||
      normalized.includes('model_not_found') ||
      normalized.includes('no available channel') ||
      normalized.includes('invalid model') ||
      (normalized.includes('model') && normalized.includes('not found'))
    ) {
      return `Model unavailable: ${model}. Please verify the model name for Qwen. Raw error: ${errorText}`;
    }

    if (status === 429) {
      return `Qwen rate limit exceeded (${status}). Please retry later. Raw error: ${errorText}`;
    }

    if (status >= 500) {
      return `Qwen service is temporarily unavailable (${status}). Please retry later. Raw error: ${errorText}`;
    }

    return `Qwen API request failed (${status}): ${errorText}`;
  }

  private filterPreferredModels(models: string[]): string[] {
    const unique = Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
    return unique
      .filter((model) => this.isTextOrCodeModel(model))
      .sort((left, right) => {
        const priorityDiff = this.getModelPriority(left) - this.getModelPriority(right);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return left.localeCompare(right);
      });
  }

  private isTextOrCodeModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const excludedSignals = [
      'tts',
      'image',
      'audio',
      'speech',
      'voice',
      'asr',
      'transcribe',
      'transcription',
      'embedding',
      'embed',
      'rerank',
      'video',
      'vl',
      'vision',
      'omni',
      'realtime',
      'wanx',
      'qvq',
    ];

    return !excludedSignals.some((signal) => normalized.includes(signal));
  }

  private getModelPriority(model: string): number {
    const normalized = model.trim().toLowerCase();

    if (normalized.includes('coder-next')) {
      return 0;
    }
    if (normalized.includes('coder-plus')) {
      return 1;
    }
    if (normalized.includes('coder-flash')) {
      return 2;
    }
    if (normalized.includes('coder')) {
      return 3;
    }
    if (normalized.startsWith('qwen3.5-plus')) {
      return 10;
    }
    if (normalized.startsWith('qwen3-max') || normalized.startsWith('qwen-max')) {
      return 20;
    }
    if (normalized.startsWith('qwen-plus')) {
      return 30;
    }
    if (normalized.startsWith('qwen-long')) {
      return 40;
    }
    if (normalized.startsWith('qwen3.5-flash') || normalized.startsWith('qwen-flash')) {
      return 50;
    }
    if (normalized.startsWith('qwen-turbo')) {
      return 60;
    }
    if (normalized.startsWith('qwq')) {
      return 70;
    }

    return 100;
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<HttpResponseLike> {
    return this.requestJson('GET', url, undefined, headers);
  }

  private async postJson(url: string, payload: unknown, headers: Record<string, string>): Promise<HttpResponseLike> {
    return this.requestJson('POST', url, payload, headers);
  }

  private async requestJson(
    method: 'GET' | 'POST',
    url: string,
    payload: unknown,
    headers: Record<string, string>
  ): Promise<HttpResponseLike> {
    if (typeof fetch === 'function') {
      const response = await fetch(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });

      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        json: <T>() => response.json() as Promise<T>,
      };
    }

    return this.requestJsonWithNodeHttp(method, url, payload, headers);
  }

  private async requestJsonWithNodeHttp(
    method: 'GET' | 'POST',
    url: string,
    payload: unknown,
    headers: Record<string, string>
  ): Promise<HttpResponseLike> {
    const target = new URL(url);
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method,
          headers: {
            ...headers,
            ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(body).toString() }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      req.on('error', reject);
      if (payload !== undefined) {
        req.write(body);
      }
      req.end();
    });

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
      json: async <T>() => JSON.parse(result.body) as T,
    };
  }
}
