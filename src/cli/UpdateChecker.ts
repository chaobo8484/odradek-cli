import { ConfigStore } from './ConfigStore.js';

export interface UpdateNotice {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  installCommand: string;
}

type RegistryResponse = {
  'dist-tags'?: {
    latest?: string;
  };
};

export class UpdateChecker {
  private static readonly CHECK_INTERVAL_MS = 1000 * 60 * 60 * 12;
  private static readonly REQUEST_TIMEOUT_MS = 2500;
  private readonly registryUrl: string;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly packageName: string,
    private readonly currentVersion: string
  ) {
    this.registryUrl = `https://registry.npmjs.org/${this.encodePackageName(packageName)}`;
  }

  async getCachedNotice(): Promise<UpdateNotice | null> {
    const state = await this.configStore.getUpdateCheckState();
    return this.toNotice(state.latestVersion);
  }

  async checkForUpdates(force = false): Promise<UpdateNotice | null> {
    const state = await this.configStore.getUpdateCheckState();
    if (!force && !this.shouldRefresh(state.lastCheckedAt)) {
      return this.toNotice(state.latestVersion);
    }

    try {
      const latestVersion = await this.fetchLatestVersion();
      await this.configStore.setUpdateCheckState({
        lastCheckedAt: new Date().toISOString(),
        latestVersion: latestVersion ?? state.latestVersion,
      });
      return this.toNotice(latestVersion ?? state.latestVersion);
    } catch {
      return this.toNotice(state.latestVersion);
    }
  }

  private shouldRefresh(lastCheckedAt: string | undefined): boolean {
    if (!lastCheckedAt) {
      return true;
    }

    const checkedAtMs = Date.parse(lastCheckedAt);
    if (!Number.isFinite(checkedAtMs)) {
      return true;
    }

    return Date.now() - checkedAtMs >= UpdateChecker.CHECK_INTERVAL_MS;
  }

  private async fetchLatestVersion(): Promise<string | null> {
    if (typeof fetch !== 'function') {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UpdateChecker.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.registryUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as RegistryResponse;
      const latestVersion = payload['dist-tags']?.latest?.trim();
      return latestVersion || null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toNotice(latestVersion: string | undefined): UpdateNotice | null {
    const normalizedLatest = latestVersion?.trim();
    if (!normalizedLatest || !this.isNewerVersion(normalizedLatest, this.currentVersion)) {
      return null;
    }

    return {
      packageName: this.packageName,
      currentVersion: this.currentVersion,
      latestVersion: normalizedLatest,
      installCommand: `npm install -g ${this.packageName}@latest`,
    };
  }

  private encodePackageName(packageName: string): string {
    return packageName
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('%2F');
  }

  private isNewerVersion(left: string, right: string): boolean {
    const comparison = this.compareSemver(left, right);
    return comparison > 0;
  }

  private compareSemver(left: string, right: string): number {
    const leftVersion = this.parseSemver(left);
    const rightVersion = this.parseSemver(right);
    if (!leftVersion || !rightVersion) {
      return left.localeCompare(right);
    }

    const maxLength = Math.max(leftVersion.core.length, rightVersion.core.length);
    for (let index = 0; index < maxLength; index += 1) {
      const leftPart = leftVersion.core[index] ?? 0;
      const rightPart = rightVersion.core[index] ?? 0;
      if (leftPart !== rightPart) {
        return leftPart > rightPart ? 1 : -1;
      }
    }

    if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
      return 0;
    }
    if (leftVersion.prerelease.length === 0) {
      return 1;
    }
    if (rightVersion.prerelease.length === 0) {
      return -1;
    }

    const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    for (let index = 0; index < prereleaseLength; index += 1) {
      const leftPart = leftVersion.prerelease[index];
      const rightPart = rightVersion.prerelease[index];
      if (leftPart === undefined) {
        return -1;
      }
      if (rightPart === undefined) {
        return 1;
      }
      if (leftPart === rightPart) {
        continue;
      }

      const leftIsNumber = /^\d+$/.test(leftPart);
      const rightIsNumber = /^\d+$/.test(rightPart);
      if (leftIsNumber && rightIsNumber) {
        return Number(leftPart) > Number(rightPart) ? 1 : -1;
      }
      if (leftIsNumber) {
        return -1;
      }
      if (rightIsNumber) {
        return 1;
      }
      return leftPart.localeCompare(rightPart);
    }

    return 0;
  }

  private parseSemver(value: string): { core: number[]; prerelease: string[] } | null {
    const normalized = value.trim();
    const match = normalized.match(/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) {
      return null;
    }

    return {
      core: match[1].split('.').map((part) => Number(part)),
      prerelease: match[2] ? match[2].split('.') : [],
    };
  }
}
