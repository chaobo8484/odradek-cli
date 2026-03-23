import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ENV_FILES = ['.env', '.env.local'];
const loadedEnvFiles = new Set<string>();

export function loadEnvironmentFiles(cwd: string = process.cwd()): string[] {
  for (const fileName of DEFAULT_ENV_FILES) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = parseEnvFile(raw);

    for (const [key, value] of entries) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    loadedEnvFiles.add(filePath);
  }

  return Array.from(loadedEnvFiles);
}

export function getLoadedEnvironmentFiles(): string[] {
  return Array.from(loadedEnvFiles);
}

function parseEnvFile(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = normalized.slice(separatorIndex + 1).trim();
    result.set(key, normalizeEnvValue(rawValue));
  }

  return result;
}

function normalizeEnvValue(value: string): string {
  if (!value) {
    return '';
  }

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (quote === '"') {
      return inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    }
    return inner;
  }

  return value.replace(/\s+#.*$/, '').trim();
}
