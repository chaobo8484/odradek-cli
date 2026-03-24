import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getLoadedEnvironmentFiles } from '../config/loadEnv.js';

export type ProviderName = 'claude';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface AppConfig {
  activeProvider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  trustedPaths: string[];
  projectContextEnabled: boolean;
}

export type ConfigValueSource = 'session' | 'env' | 'local' | 'default' | 'unset';

export interface ProviderConfigSources {
  apiKey: ConfigValueSource;
  baseUrl: ConfigValueSource;
  model: ConfigValueSource;
}

export interface ConfigDiagnostics {
  loadedEnvFiles: string[];
  providerSources: Record<ProviderName, ProviderConfigSources>;
  projectContextEnabledSource: Exclude<ConfigValueSource, 'unset'>;
}

const DEFAULT_CONFIG: AppConfig = {
  activeProvider: 'claude',
  providers: {
    claude: {},
  },
  trustedPaths: [],
  projectContextEnabled: true,
};

export class ConfigStore {
  private readonly configPath: string;
  private readonly appName = 'aeris-cli';
  private readonly sessionProviderOverrides: Partial<Record<ProviderName, ProviderConfig>> = {};

  constructor() {
    this.configPath = this.resolveConfigPath();
  }

  async getConfig(): Promise<AppConfig> {
    const stored = await this.getStoredConfig();
    const withEnvironment = this.applyEnvironmentOverrides(stored);
    return this.applySessionOverrides(withEnvironment);
  }

  async getStoredConfig(): Promise<AppConfig> {
    await this.ensureConfigDir();
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as AppConfig;
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        activeProvider: 'claude',
        providers: {
          ...DEFAULT_CONFIG.providers,
          ...(parsed.providers ?? {}),
        },
        trustedPaths: Array.isArray(parsed.trustedPaths) ? parsed.trustedPaths : [],
        projectContextEnabled:
          typeof parsed.projectContextEnabled === 'boolean'
            ? parsed.projectContextEnabled
            : DEFAULT_CONFIG.projectContextEnabled,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    const stored = await this.getStoredConfig();
    const sessionProvider = this.getSessionProviderConfig('claude');
    const envProvider = this.getEnvironmentProviderConfig();
    const envProjectContextEnabled = this.readBooleanEnv(['AERIS_PROJECT_CONTEXT_ENABLED']);
    const storedProvider = stored.providers.claude ?? {};

    return {
      loadedEnvFiles: getLoadedEnvironmentFiles(),
      providerSources: {
        claude: {
          apiKey: sessionProvider.apiKey
            ? 'session'
            : envProvider.apiKey
              ? 'env'
              : storedProvider.apiKey?.trim()
                ? 'local'
                : 'unset',
          baseUrl: sessionProvider.baseUrl
            ? 'session'
            : envProvider.baseUrl
              ? 'env'
              : storedProvider.baseUrl?.trim()
                ? 'local'
                : 'default',
          model: sessionProvider.model
            ? 'session'
            : envProvider.model
              ? 'env'
              : storedProvider.model?.trim()
                ? 'local'
                : 'default',
        },
      },
      projectContextEnabledSource:
        typeof envProjectContextEnabled === 'boolean'
          ? 'env'
          : stored.projectContextEnabled !== DEFAULT_CONFIG.projectContextEnabled
            ? 'local'
            : 'default',
    };
  }

  async setProviderConfig(provider: ProviderName, config: ProviderConfig): Promise<void> {
    const current = await this.getStoredConfig();
    const next: AppConfig = {
      ...current,
      providers: {
        ...current.providers,
        [provider]: {
          ...current.providers[provider],
          ...config,
        },
      },
    };
    await this.writeConfig(next);
  }

  async setActiveProvider(provider: ProviderName): Promise<void> {
    const current = await this.getStoredConfig();
    await this.writeConfig({
      ...current,
      activeProvider: provider,
    });
  }

  async setProjectContextEnabled(enabled: boolean): Promise<void> {
    const current = await this.getStoredConfig();
    await this.writeConfig({
      ...current,
      projectContextEnabled: enabled,
    });
  }

  async trustPath(targetPath: string): Promise<void> {
    const current = await this.getStoredConfig();
    const resolvedTarget = path.resolve(targetPath);
    const normalizedTarget = this.normalizePath(resolvedTarget);
    const exists = current.trustedPaths.some((item) => this.normalizePath(item) === normalizedTarget);

    if (exists) {
      return;
    }

    await this.writeConfig({
      ...current,
      trustedPaths: [...current.trustedPaths, resolvedTarget],
    });
  }

  async isPathTrusted(targetPath: string): Promise<boolean> {
    const current = await this.getStoredConfig();
    const normalizedTarget = this.normalizePath(path.resolve(targetPath));
    return current.trustedPaths.some((item) => this.normalizePath(item) === normalizedTarget);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  setSessionProviderConfig(provider: ProviderName, config: ProviderConfig): void {
    const current = this.sessionProviderOverrides[provider] ?? {};
    const next: ProviderConfig = {
      ...current,
      ...config,
    };

    if (!next.apiKey && !next.baseUrl && !next.model) {
      delete this.sessionProviderOverrides[provider];
      return;
    }

    this.sessionProviderOverrides[provider] = next;
  }

  clearSessionProviderConfig(provider: ProviderName, keys?: Array<keyof ProviderConfig>): void {
    if (!this.sessionProviderOverrides[provider]) {
      return;
    }

    if (!keys || keys.length === 0) {
      delete this.sessionProviderOverrides[provider];
      return;
    }

    const next: ProviderConfig = { ...(this.sessionProviderOverrides[provider] ?? {}) };
    for (const key of keys) {
      delete next[key];
    }

    if (!next.apiKey && !next.baseUrl && !next.model) {
      delete this.sessionProviderOverrides[provider];
      return;
    }

    this.sessionProviderOverrides[provider] = next;
  }

  private async ensureConfigDir(): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
  }

  private async writeConfig(config: AppConfig): Promise<void> {
    await this.ensureConfigDir();
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private applyEnvironmentOverrides(config: AppConfig): AppConfig {
    const envProvider = this.getEnvironmentProviderConfig();
    const envProjectContextEnabled = this.readBooleanEnv(['AERIS_PROJECT_CONTEXT_ENABLED']);

    return {
      ...config,
      providers: {
        ...config.providers,
        claude: {
          ...config.providers.claude,
          ...(envProvider.apiKey ? { apiKey: envProvider.apiKey } : {}),
          ...(envProvider.baseUrl ? { baseUrl: envProvider.baseUrl } : {}),
          ...(envProvider.model ? { model: envProvider.model } : {}),
        },
      },
      projectContextEnabled:
        typeof envProjectContextEnabled === 'boolean' ? envProjectContextEnabled : config.projectContextEnabled,
    };
  }

  private applySessionOverrides(config: AppConfig): AppConfig {
    const sessionProvider = this.getSessionProviderConfig('claude');

    return {
      ...config,
      providers: {
        ...config.providers,
        claude: {
          ...config.providers.claude,
          ...(sessionProvider.apiKey ? { apiKey: sessionProvider.apiKey } : {}),
          ...(sessionProvider.baseUrl ? { baseUrl: sessionProvider.baseUrl } : {}),
          ...(sessionProvider.model ? { model: sessionProvider.model } : {}),
        },
      },
    };
  }

  private getEnvironmentProviderConfig(): ProviderConfig {
    return {
      apiKey: this.readStringEnv(['AERIS_CLAUDE_API_KEY', 'ANTHROPIC_API_KEY']),
      baseUrl: this.readStringEnv(['AERIS_CLAUDE_BASE_URL', 'ANTHROPIC_BASE_URL']),
      model: this.readStringEnv(['AERIS_CLAUDE_MODEL']),
    };
  }

  private getSessionProviderConfig(provider: ProviderName): ProviderConfig {
    return this.sessionProviderOverrides[provider] ?? {};
  }

  private readStringEnv(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = process.env[key]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private readBooleanEnv(keys: string[]): boolean | undefined {
    for (const key of keys) {
      const normalized = process.env[key]?.trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }

      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }

    return undefined;
  }

  private resolveConfigPath(): string {
    const home = os.homedir();
    const platform = process.platform;

    if (platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        return path.join(appData, this.appName, 'config.json');
      }
      return path.join(home, 'AppData', 'Roaming', this.appName, 'config.json');
    }

    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', this.appName, 'config.json');
    }

    return path.join(home, '.config', this.appName, 'config.json');
  }

  private normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}
