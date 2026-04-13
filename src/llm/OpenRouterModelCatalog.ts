import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderName } from '../config/providerCatalog.js';

const CACHE_DIR = path.join(os.homedir(), '.claude-estimator');
const CACHE_FILE = path.join(CACHE_DIR, 'model-prices.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type PriceCache = {
  fetchedAt: number;
  entries: OpenRouterModelCatalogEntry[];
};

type HttpResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type OpenRouterPricingPayload = {
  prompt?: string | number | null;
  completion?: string | number | null;
  request?: string | number | null;
  image?: string | number | null;
  web_search?: string | number | null;
  internal_reasoning?: string | number | null;
  input_cache_read?: string | number | null;
  input_cache_write?: string | number | null;
};

type OpenRouterModelPayload = {
  id?: string | null;
  name?: string | null;
  canonical_slug?: string | null;
  context_length?: number | string | null;
  top_provider?: {
    max_completion_tokens?: number | string | null;
  } | null;
  pricing?: OpenRouterPricingPayload | null;
};

type OpenRouterModelsPayload = {
  data?: OpenRouterModelPayload[];
};

export type OpenRouterModelPricing = {
  prompt: number | null;
  completion: number | null;
  request: number | null;
  image: number | null;
  webSearch: number | null;
  internalReasoning: number | null;
  inputCacheRead: number | null;
  inputCacheWrite: number | null;
};

export type OpenRouterModelCatalogEntry = {
  id: string;
  name: string;
  canonicalSlug: string | null;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  pricing: OpenRouterModelPricing;
};

export type OpenRouterModelMatch = {
  entry: OpenRouterModelCatalogEntry;
  strategy:
    | 'exact-id'
    | 'exact-canonical'
    | 'provider-prefixed'
    | 'suffix-id'
    | 'suffix-canonical'
    | 'basename';
  score: number;
};

export class OpenRouterModelCatalog {
  private readonly defaultBaseUrl = 'https://openrouter.ai/api/v1';

  async fetchModels(baseUrl?: string, apiKey?: string): Promise<OpenRouterModelCatalogEntry[]> {
    // Only use cache when hitting the default public endpoint (no custom baseUrl/apiKey)
    const isDefaultEndpoint = !baseUrl?.trim() && !apiKey?.trim();
    if (isDefaultEndpoint) {
      const cached = await this.readCache();
      if (cached) {
        return cached;
      }
    }

    const url = `${this.resolveBaseUrl(baseUrl)}/models`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-title': 'Odradek CLI',
    };
    if (apiKey?.trim()) {
      headers.authorization = `Bearer ${apiKey.trim()}`;
    }

    const response = await this.getJson(url, headers);
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenRouter model pricing (${response.status}) from ${url}: ${raw.slice(0, 300)}`);
    }

    const payload = raw ? (JSON.parse(raw) as OpenRouterModelsPayload) : {};
    const entries = (payload.data ?? [])
      .map((item) => this.normalizeModel(item))
      .filter((item): item is OpenRouterModelCatalogEntry => item !== null);

    if (isDefaultEndpoint) {
      await this.writeCache(entries);
    }

    return entries;
  }

  private async readCache(): Promise<OpenRouterModelCatalogEntry[] | null> {
    try {
      const raw = await fs.readFile(CACHE_FILE, 'utf8');
      const cache = JSON.parse(raw) as PriceCache;
      if (Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        return cache.entries;
      }
    } catch {
      // Cache missing or corrupt — fall through to live fetch
    }
    return null;
  }

  private async writeCache(entries: OpenRouterModelCatalogEntry[]): Promise<void> {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      const cache: PriceCache = { fetchedAt: Date.now(), entries };
      await fs.writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
    } catch {
      // Cache write failure is non-fatal
    }
  }

  resolveModel(
    modelName: string,
    entries: OpenRouterModelCatalogEntry[],
    provider?: ProviderName
  ): OpenRouterModelMatch | null {
    const target = this.normalizeKey(modelName);
    if (!target) {
      return null;
    }

    const basename = this.extractBasename(target);
    const preferredPrefixes = this.getPreferredPrefixes(provider);
    const scored = entries
      .map((entry) => {
        const entryId = this.normalizeKey(entry.id);
        const canonical = this.normalizeKey(entry.canonicalSlug ?? '');
        const entryBasename = this.extractBasename(entryId);
        const canonicalBasename = this.extractBasename(canonical);
        const providerPreferred = preferredPrefixes.some((prefix) => entryId.startsWith(prefix));

        if (entryId === target) {
          return { entry, strategy: 'exact-id' as const, score: providerPreferred ? 120 : 115 };
        }
        if (canonical && canonical === target) {
          return { entry, strategy: 'exact-canonical' as const, score: providerPreferred ? 118 : 112 };
        }

        for (const prefix of preferredPrefixes) {
          if (`${prefix}${target}` === entryId) {
            return { entry, strategy: 'provider-prefixed' as const, score: 110 };
          }
        }

        if (entryId.endsWith(`/${target}`)) {
          return { entry, strategy: 'suffix-id' as const, score: providerPreferred ? 104 : 99 };
        }
        if (canonical && canonical.endsWith(`/${target}`)) {
          return { entry, strategy: 'suffix-canonical' as const, score: providerPreferred ? 102 : 97 };
        }
        if (basename && (entryBasename === basename || canonicalBasename === basename)) {
          return { entry, strategy: 'basename' as const, score: providerPreferred ? 92 : 88 };
        }
        return null;
      })
      .filter((item): item is OpenRouterModelMatch => item !== null)
      .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));

    return scored[0] ?? null;
  }

  private normalizeModel(payload: OpenRouterModelPayload): OpenRouterModelCatalogEntry | null {
    const id = payload.id?.trim();
    if (!id) {
      return null;
    }

    return {
      id,
      name: payload.name?.trim() || id,
      canonicalSlug: payload.canonical_slug?.trim() || null,
      contextLength: this.toNumber(payload.context_length),
      maxCompletionTokens: this.toNumber(payload.top_provider?.max_completion_tokens),
      pricing: {
        prompt: this.toNumber(payload.pricing?.prompt),
        completion: this.toNumber(payload.pricing?.completion),
        request: this.toNumber(payload.pricing?.request),
        image: this.toNumber(payload.pricing?.image),
        webSearch: this.toNumber(payload.pricing?.web_search),
        internalReasoning: this.toNumber(payload.pricing?.internal_reasoning),
        inputCacheRead: this.toNumber(payload.pricing?.input_cache_read),
        inputCacheWrite: this.toNumber(payload.pricing?.input_cache_write),
      },
    };
  }

  private getPreferredPrefixes(provider?: ProviderName): string[] {
    if (provider === 'claude') {
      return ['anthropic/'];
    }
    if (provider === 'qwen') {
      return ['qwen/', 'alibaba/'];
    }
    return [];
  }

  private resolveBaseUrl(customBaseUrl?: string): string {
    return (customBaseUrl?.trim() || this.defaultBaseUrl).replace(/\/+$/, '');
  }

  private normalizeKey(value: string): string {
    return value.trim().toLowerCase();
  }

  private extractBasename(value: string): string {
    if (!value) {
      return '';
    }
    const parts = value.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }

  private toNumber(value: string | number | null | undefined): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = Number(value.trim());
    return Number.isFinite(normalized) ? normalized : null;
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<HttpResponseLike> {
    return this.requestJson('GET', url, headers);
  }

  private async requestJson(
    method: 'GET',
    url: string,
    headers: Record<string, string>
  ): Promise<HttpResponseLike> {
    if (typeof fetch === 'function') {
      const response = await fetch(url, { method, headers });
      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
      };
    }

    return this.requestJsonWithNodeHttp(method, url, headers);
  }

  private async requestJsonWithNodeHttp(
    method: 'GET',
    url: string,
    headers: Record<string, string>
  ): Promise<HttpResponseLike> {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
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
      req.end();
    });

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
    };
  }
}
