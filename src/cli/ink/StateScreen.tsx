import path from 'path';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

type Tone = 'white' | 'gray' | 'green' | 'yellow' | 'red' | 'cyan' | 'blue';

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: string;
};

type DetailRow = {
  label: string;
  value: string;
  note?: string;
  tone?: string;
  wrapMode?: 'wrap' | 'truncate-end';
};

type StateScreenProps = {
  scopeLabel: string;
  workspacePath: string;
  configPath: string;
  trusted: boolean;
  runtimeStatus: 'ready' | 'needs setup';
  providerDisplayName: string;
  providerSourceLabel: string;
  runtimeSourceLabel: string;
  projectContextEnabled: boolean;
  projectContextSourceLabel: string;
  apiKeyConfigured: boolean;
  apiKeySourceLabel: string;
  modelValue: string;
  modelSourceLabel: string;
  endpointValue: string;
  endpointSourceLabel: string;
  envFilesLabel: string;
  envFilesLoaded: boolean;
  sessionOverrides: string[];
  git: {
    available: boolean;
    repoRoot: string;
    branch: string;
    clean: boolean;
    changedFiles: number;
    stagedFiles: number;
    unstagedFiles: number;
    untrackedFiles: number;
    ahead: number;
    behind: number;
  };
  project: {
    packageLabel: string;
    packageManager: string;
    scriptCount: number;
    hasBuildScript: boolean;
    hasTestScript: boolean;
    hasLintScript: boolean;
    hasTypecheckScript: boolean;
    hasReadme: boolean;
    hasSrcDir: boolean;
    hasTestsDir: boolean;
    hasTsConfig: boolean;
    hasEnvExample: boolean;
    hasWorkspaceClaude: boolean;
    hasWorkspaceCodex: boolean;
    hasAgentsFile: boolean;
    hasClaudeFile: boolean;
    hasOdradekDir: boolean;
    promptAssetCount: number;
    promptFileCount: number;
    systemPromptCount: number;
    projectConfigCount: number;
    docsAssetCount: number;
    ruleFileCount: number;
    totalRules: number;
    skillCount: number;
    skillResourceFiles: number;
  };
};

const ACCENT_COLOR = '#D6F54A';

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  const head = Math.ceil((maxLength - 3) / 2);
  const tail = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

function formatScope(scopeLabel: string): string {
  return scopeLabel.trim().replace(/\s+/g, '_').toLowerCase();
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function buildSectionBorder(
  title: string,
  width: number,
  note?: string
): {
  titleText: string;
  noteText: string;
  fill: string;
  bottom: string;
} {
  const titleText = title.toUpperCase();
  const noteText = note ? truncateMiddle(note, Math.max(12, Math.floor(width * 0.26))) : '';
  const reservedWidth = 4 + titleText.length + (noteText ? noteText.length + 1 : 0);
  const fill = '─'.repeat(Math.max(1, width - reservedWidth));
  return {
    titleText,
    noteText,
    fill,
    bottom: `└${'─'.repeat(Math.max(1, width - 1))}`,
  };
}

function SectionBlock({
  title,
  width,
  note,
  tone = 'gray',
  children,
  marginBottom = 1,
}: {
  title: string;
  width: number;
  note?: string;
  tone?: Tone;
  children: ReactNode;
  marginBottom?: number;
}) {
  const border = buildSectionBorder(title, width, note);

  return (
    <Box flexDirection="column" marginBottom={marginBottom}>
      <Box>
        <Text color="gray">┌─ </Text>
        <Text color={tone}>{border.titleText}</Text>
        <Text color="gray"> {border.fill}</Text>
        {border.noteText ? <Text color="gray"> {border.noteText}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={1}>
        {children}
      </Box>
      <Text color="gray">{border.bottom}</Text>
    </Box>
  );
}

function CompactMetricCellView({ cell, width }: { cell: MetricCell; width: number }) {
  return (
    <Box width={width} flexDirection="column" marginBottom={1}>
      <Text color="gray">{cell.label.toUpperCase()}</Text>
      <Text color={cell.tone ?? 'white'}>{cell.value}</Text>
      <Text color="gray" wrap="truncate-end">
        {cell.note}
      </Text>
    </Box>
  );
}

function DetailRowView({ row, labelWidth, valueWidth }: { row: DetailRow; labelWidth: number; valueWidth: number }) {
  return (
    <Box>
      <Box width={labelWidth}>
        <Text color="gray">{row.label}</Text>
      </Box>
      <Box width={valueWidth}>
        <Text color={row.tone ?? 'white'} wrap={row.wrapMode ?? 'truncate-end'}>
          {row.value}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="gray" wrap="truncate-end">
          {row.note ?? ''}
        </Text>
      </Box>
    </Box>
  );
}

function yesNoDetail(label: string, active: boolean, note?: string): DetailRow {
  return {
    label,
    value: active ? 'yes' : 'no',
    note,
    tone: active ? 'green' : 'gray',
  };
}

function buildScriptCoverageLabel(props: StateScreenProps['project']): string {
  const enabled = [
    props.hasBuildScript ? 'build' : null,
    props.hasTestScript ? 'test' : null,
    props.hasLintScript ? 'lint' : null,
    props.hasTypecheckScript ? 'typecheck' : null,
  ].filter(Boolean);

  return enabled.length > 0 ? enabled.join(' / ') : 'none';
}

export function StateScreen(props: StateScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 2);
  const workspaceLabel = path.basename(props.workspacePath) || props.workspacePath;
  const columns = terminalWidth >= 132 ? 4 : terminalWidth >= 100 ? 3 : 2;
  const cellWidth = Math.max(18, Math.floor((contentWidth - (columns - 1) * 2) / columns));
  const labelWidth = 14;
  const valueWidth = Math.max(24, Math.min(46, Math.floor(contentWidth * 0.36)));

  const gitStatusValue = props.git.available ? (props.git.clean ? 'clean' : 'dirty') : 'not a repo';
  const gitStatusNote = props.git.available ? `${props.git.branch} · ${props.git.changedFiles} changed` : 'git unavailable';

  const summaryCells: MetricCell[] = [
    {
      label: 'runtime',
      value: props.runtimeStatus,
      note: props.runtimeStatus === 'ready' ? 'chat ready' : 'needs config',
      tone: props.runtimeStatus === 'ready' ? 'green' : 'yellow',
    },
    {
      label: 'provider',
      value: props.providerDisplayName,
      note: props.providerSourceLabel,
      tone: ACCENT_COLOR,
    },
    {
      label: 'trust',
      value: props.trusted ? 'trusted' : 'not trusted',
      note: props.trusted ? 'workspace allowed' : 'run /trustpath',
      tone: props.trusted ? 'green' : 'yellow',
    },
    {
      label: 'git',
      value: gitStatusValue,
      note: gitStatusNote,
      tone: !props.git.available ? 'gray' : props.git.clean ? 'green' : 'yellow',
    },
    {
      label: 'project ctx',
      value: props.projectContextEnabled ? 'enabled' : 'disabled',
      note: props.projectContextSourceLabel,
      tone: props.projectContextEnabled ? 'green' : 'yellow',
    },
    {
      label: 'prompts',
      value: String(props.project.promptAssetCount),
      note: `${props.project.systemPromptCount} system · ${props.project.projectConfigCount} config`,
      tone: props.project.promptAssetCount > 0 ? ACCENT_COLOR : 'gray',
    },
    {
      label: 'rules',
      value: `${props.project.ruleFileCount}/${props.project.totalRules}`,
      note: 'files / rules',
      tone: props.project.totalRules > 0 ? 'green' : 'gray',
    },
    {
      label: 'skills',
      value: String(props.project.skillCount),
      note: `${props.project.skillResourceFiles} resource files`,
      tone: props.project.skillCount > 0 ? ACCENT_COLOR : 'gray',
    },
  ];

  const notices: Array<{ tone: Tone; text: string }> = [];
  if (!props.trusted) {
    notices.push({ tone: 'yellow', text: 'Workspace is not trusted yet, so project-aware features may stay limited.' });
  }
  if (props.runtimeStatus !== 'ready') {
    notices.push({ tone: 'yellow', text: 'Runtime still needs setup before normal chat requests can succeed.' });
  }
  if (!props.git.available) {
    notices.push({ tone: 'gray', text: 'Git repository metadata is unavailable in the current workspace.' });
  }
  if (
    props.project.promptAssetCount === 0 &&
    props.project.totalRules === 0 &&
    !props.project.hasAgentsFile &&
    !props.project.hasClaudeFile
  ) {
    notices.push({ tone: 'yellow', text: 'No obvious workspace instructions were found yet; confirm AGENTS.md, CLAUDE.md, rules/, or system prompts if expected.' });
  }

  const runtimeRows: DetailRow[] = [
    {
      label: 'provider',
      value: props.providerDisplayName,
      note: props.providerSourceLabel,
      tone: ACCENT_COLOR,
    },
    {
      label: 'api key',
      value: props.apiKeyConfigured ? 'configured' : 'missing',
      note: props.apiKeySourceLabel,
      tone: props.apiKeyConfigured ? 'green' : 'yellow',
    },
    {
      label: 'model',
      value: props.modelValue,
      note: props.modelSourceLabel,
      tone: props.modelValue === 'Not set' ? 'yellow' : 'white',
    },
    {
      label: 'endpoint',
      value: truncateMiddle(props.endpointValue, 56),
      note: props.endpointSourceLabel,
      tone: 'white',
    },
    {
      label: 'project ctx',
      value: props.projectContextEnabled ? 'enabled' : 'disabled',
      note: props.projectContextSourceLabel,
      tone: props.projectContextEnabled ? 'green' : 'yellow',
    },
    {
      label: 'runtime src',
      value: props.runtimeSourceLabel,
      note: 'provider/api/model endpoint',
      tone: ACCENT_COLOR,
    },
    {
      label: 'env files',
      value: truncateMiddle(props.envFilesLabel, 56),
      note: props.envFilesLoaded ? 'loaded' : 'none loaded',
      tone: props.envFilesLoaded ? 'white' : 'gray',
      wrapMode: 'wrap',
    },
    {
      label: 'config',
      value: truncateMiddle(props.configPath, 56),
      note: 'active config file',
      tone: 'white',
      wrapMode: 'wrap',
    },
  ];

  if (props.sessionOverrides.length > 0) {
    runtimeRows.push({
      label: 'session',
      value: props.sessionOverrides.join(', '),
      note: 'temporary overrides',
      tone: 'green',
      wrapMode: 'wrap',
    });
  }

  const gitRows: DetailRow[] = props.git.available
    ? [
        {
          label: 'branch',
          value: props.git.branch,
          note:
            props.git.ahead > 0 || props.git.behind > 0
              ? `ahead ${props.git.ahead} · behind ${props.git.behind}`
              : 'remote in sync',
          tone: 'white',
        },
        {
          label: 'tree',
          value: props.git.clean ? 'clean' : 'dirty',
          note: `${props.git.changedFiles} changed files`,
          tone: props.git.clean ? 'green' : 'yellow',
        },
        {
          label: 'changes',
          value: `${props.git.stagedFiles} staged / ${props.git.unstagedFiles} unstaged`,
          note: `${props.git.untrackedFiles} untracked`,
          tone: props.git.changedFiles > 0 ? 'white' : 'gray',
        },
        {
          label: 'repo root',
          value: props.git.repoRoot,
          note: 'git top-level path',
          tone: 'white',
          wrapMode: 'wrap',
        },
      ]
    : [
        {
          label: 'git',
          value: 'unavailable',
          note: 'current workspace is not inside a detectable git repository',
          tone: 'gray',
          wrapMode: 'wrap',
        },
      ];

  const projectRows: DetailRow[] = [
    {
      label: 'package',
      value: props.project.packageLabel,
      note: props.project.packageManager === 'none' ? 'no lockfile/packageManager hint' : props.project.packageManager,
      tone: props.project.packageLabel === 'missing' ? 'yellow' : 'white',
      wrapMode: 'wrap',
    },
    {
      label: 'scripts',
      value: `${props.project.scriptCount}`,
      note: buildScriptCoverageLabel(props.project),
      tone: props.project.scriptCount > 0 ? 'white' : 'yellow',
    },
    yesNoDetail('README', props.project.hasReadme, 'root readme'),
    yesNoDetail('source dir', props.project.hasSrcDir, 'src / app / lib'),
    yesNoDetail('tests dir', props.project.hasTestsDir, 'tests / spec'),
    yesNoDetail('tsconfig', props.project.hasTsConfig, 'typescript config'),
    yesNoDetail('env example', props.project.hasEnvExample, '.env.example or sample'),
  ];

  const instructionRows: DetailRow[] = [
    yesNoDetail('AGENTS.md', props.project.hasAgentsFile, 'root instruction file'),
    yesNoDetail('CLAUDE.md', props.project.hasClaudeFile, 'root claude file'),
    yesNoDetail('workspace .claude', props.project.hasWorkspaceClaude, 'project-local claude directory'),
    yesNoDetail('workspace .codex', props.project.hasWorkspaceCodex, 'project-local codex directory'),
    yesNoDetail('.odradek', props.project.hasOdradekDir, 'workspace odradek directory'),
    {
      label: 'prompt assets',
      value: `${props.project.promptAssetCount}`,
      note: `${props.project.promptFileCount} prompt · ${props.project.docsAssetCount} docs`,
      tone: props.project.promptAssetCount > 0 ? ACCENT_COLOR : 'gray',
    },
    {
      label: 'system prompts',
      value: `${props.project.systemPromptCount}`,
      note: `${props.project.projectConfigCount} project config files`,
      tone: props.project.systemPromptCount > 0 ? 'green' : 'gray',
    },
    {
      label: 'rule files',
      value: `${props.project.ruleFileCount}`,
      note: `${props.project.totalRules} extracted rules`,
      tone: props.project.totalRules > 0 ? 'green' : 'gray',
    },
    {
      label: 'skills',
      value: `${props.project.skillCount}`,
      note: `${props.project.skillResourceFiles} resource files`,
      tone: props.project.skillCount > 0 ? ACCENT_COLOR : 'gray',
    },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="white">/state  {formatScope(props.scopeLabel)}</Text>
        <Text color="gray">odradek - project state</Text>
      </Box>
      <Text color="gray" wrap="wrap">
        {props.workspacePath}
      </Text>

      <SectionBlock title="Summary" width={contentWidth} note={workspaceLabel} tone={props.runtimeStatus === 'ready' ? 'green' : 'yellow'}>
        {chunk(summaryCells, columns).map((row, rowIndex) => (
          <Box key={`summary-${rowIndex}`}>
            {row.map((cell, index) => (
              <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
                <CompactMetricCellView cell={cell} width={cellWidth} />
              </Box>
            ))}
          </Box>
        ))}
        {notices.map((notice, index) => (
          <Text key={`notice-${index}`} color={notice.tone} wrap="wrap">
            ! {notice.text}
          </Text>
        ))}
      </SectionBlock>

      <SectionBlock title="Runtime" width={contentWidth}>
        {runtimeRows.map((row) => (
          <DetailRowView key={row.label} row={row} labelWidth={labelWidth} valueWidth={valueWidth} />
        ))}
      </SectionBlock>

      <SectionBlock title="Git" width={contentWidth} note={props.git.available ? props.git.branch : 'git unavailable'}>
        {gitRows.map((row) => (
          <DetailRowView key={row.label} row={row} labelWidth={labelWidth} valueWidth={valueWidth} />
        ))}
      </SectionBlock>

      <SectionBlock title="Project" width={contentWidth} note={props.project.packageLabel} tone={props.project.packageLabel === 'missing' ? 'yellow' : 'gray'}>
        {projectRows.map((row) => (
          <DetailRowView key={row.label} row={row} labelWidth={labelWidth} valueWidth={valueWidth} />
        ))}
      </SectionBlock>

      <SectionBlock title="Instructions & Tooling" width={contentWidth} marginBottom={0}>
        {instructionRows.map((row) => (
          <DetailRowView key={row.label} row={row} labelWidth={labelWidth} valueWidth={valueWidth} />
        ))}
      </SectionBlock>
    </Box>
  );
}
