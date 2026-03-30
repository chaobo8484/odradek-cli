import { promises as fs } from 'fs';
import path from 'path';
import { ProviderName } from '../config/providerCatalog.js';

export interface PromptProfileLayer {
  label: string;
  filePath: string;
  content: string;
}

export interface PromptProfileResult {
  layers: PromptProfileLayer[];
  systemText: string;
}

type PromptProfileResolveOptions = {
  workspaceRoot: string;
  configRoot: string;
  provider: ProviderName;
  model: string;
};

export class PromptProfileResolver {
  async resolve(options: PromptProfileResolveOptions): Promise<PromptProfileResult | null> {
    const roots = this.buildPromptRoots(options.workspaceRoot, options.configRoot);
    const modelFileName = this.toModelFileName(options.model);
    const layers: PromptProfileLayer[] = [];

    for (const root of roots) {
      const candidateFiles = [
        { label: `${root.scope}:base`, filePath: path.join(root.dir, 'base.md') },
        { label: `${root.scope}:provider:${options.provider}`, filePath: path.join(root.dir, 'providers', `${options.provider}.md`) },
        { label: `${root.scope}:model:${options.model.trim() || 'unknown'}`, filePath: path.join(root.dir, 'models', `${modelFileName}.md`) },
      ];

      for (const candidate of candidateFiles) {
        const content = await this.readPromptFile(candidate.filePath);
        if (!content) {
          continue;
        }

        layers.push({
          label: candidate.label,
          filePath: candidate.filePath,
          content,
        });
      }
    }

    if (layers.length === 0) {
      return null;
    }

    const systemText = [
      'Global behavior instructions are active below.',
      'Follow more specific layers when they narrow or refine broader layers.',
      '',
      ...layers.flatMap((layer) => [
        `--- ${layer.label} ---`,
        layer.content,
        '',
      ]),
    ]
      .join('\n')
      .trim();

    return {
      layers,
      systemText,
    };
  }

  private buildPromptRoots(workspaceRoot: string, configRoot: string): Array<{ scope: 'app' | 'workspace'; dir: string }> {
    return [
      { scope: 'app', dir: path.join(path.resolve(configRoot), 'system-prompts') },
      { scope: 'workspace', dir: path.join(path.resolve(workspaceRoot), '.odradek', 'system-prompts') },
    ];
  }

  private async readPromptFile(filePath: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const normalized = raw.replace(/\r\n/g, '\n').trim();
      return normalized ? normalized : null;
    } catch {
      return null;
    }
  }

  private toModelFileName(model: string): string {
    const normalized = model.trim().toLowerCase();
    if (!normalized) {
      return 'unknown';
    }

    return normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  }
}
