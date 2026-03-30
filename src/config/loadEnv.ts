import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ENV_FILES = ['.env', '.env.local'];
const APP_NAME = 'odradek-cli';
const loadedEnvFiles = new Set<string>();

export function loadEnvironmentFiles(cwd: string = process.cwd()): string[] {
  const protectedKeys = new Set(Object.keys(process.env));
  const keysLoadedByFiles = new Set<string>();

  for (const dirPath of collectEnvSearchDirs(cwd)) {
    for (const fileName of DEFAULT_ENV_FILES) {
      const filePath = path.join(dirPath, fileName);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const raw = fs.readFileSync(filePath, 'utf8');
      const entries = parseEnvFile(raw);

      for (const [key, value] of entries) {
        if (protectedKeys.has(key) && !keysLoadedByFiles.has(key)) {
          continue;
        }
        process.env[key] = value;
        keysLoadedByFiles.add(key);
      }

      loadedEnvFiles.add(filePath);
    }
  }

  return Array.from(loadedEnvFiles);
}

export function getLoadedEnvironmentFiles(): string[] {
  return Array.from(loadedEnvFiles);
}

function collectEnvSearchDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const addDir = (dirPath: string) => {
    const resolved = path.resolve(dirPath);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    dirs.push(resolved);
  };

  addDir(resolveAppConfigDir());

  const cwdDirs: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    cwdDirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  cwdDirs.reverse().forEach(addDir);
  return dirs;
}

function resolveAppConfigDir(): string {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      return path.join(appData, APP_NAME);
    }
    return path.join(home, 'AppData', 'Roaming', APP_NAME);
  }

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }

  return path.join(home, '.config', APP_NAME);
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
