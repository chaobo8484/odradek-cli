import path from 'path';
import { Box, Text } from 'ink';
import type { SkillResourceKind, SkillScanResult, SkillSummary } from '../SkillScanner.js';

type SkillsOverviewScreenProps = {
  scopeLabel: string;
  result: SkillScanResult;
};

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: string;
};

type ResourceCell = {
  kind: SkillResourceKind;
  label: string;
  value: string;
  note: string;
  tone: string;
};

const ACCENT_COLOR = '#D6F54A';
const RESOURCE_ORDER: SkillResourceKind[] = ['agents', 'scripts', 'references', 'assets', 'examples', 'templates', 'other'];
const RESOURCE_LABELS: Record<SkillResourceKind, string> = {
  agents: 'agents',
  scripts: 'scripts',
  references: 'refs',
  assets: 'assets',
  examples: 'examples',
  templates: 'templates',
  other: 'extras',
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

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

function resourceTone(kind: SkillResourceKind): string {
  if (kind === 'agents') return 'cyan';
  if (kind === 'scripts') return 'magenta';
  if (kind === 'references') return 'green';
  if (kind === 'assets') return 'yellow';
  if (kind === 'examples') return ACCENT_COLOR;
  if (kind === 'templates') return 'blue';
  return 'gray';
}

function summarizeResources(skill: SkillSummary): string {
  if (skill.resourceSummaries.length === 0) {
    return 'SKILL.md only';
  }

  return skill.resourceSummaries.map((resource) => `${resource.label} ${resource.fileCount}`).join(', ');
}

function summarizeSections(skill: SkillSummary): string {
  if (skill.headings.length === 0) {
    return 'none';
  }

  return skill.headings.slice(0, 3).join(' | ');
}

function normalizeOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildResourceCells(skills: SkillSummary[]): ResourceCell[] {
  return RESOURCE_ORDER.map((kind) => {
    const matchedSkills = skills.filter((skill) =>
      skill.resourceSummaries.some((resource) => resource.kind === kind && resource.fileCount > 0)
    ).length;

    return {
      kind,
      label: RESOURCE_LABELS[kind],
      value: String(matchedSkills),
      note: matchedSkills === 1 ? 'skill' : 'skills',
      tone: resourceTone(kind),
    };
  }).filter((cell) => Number.parseInt(cell.value, 10) > 0);
}

function CompactMetricCellView({ cell, width }: { cell: MetricCell; width: number }) {
  return (
    <Box width={width}>
      <Text color="gray">{cell.label} </Text>
      <Text color={cell.tone ?? 'white'}>{cell.value}</Text>
      <Text color="gray"> {cell.note}</Text>
    </Box>
  );
}

function SkillRowView({ skill, index, contentWidth }: { skill: SkillSummary; index: number; contentWidth: number }) {
  const detailWidth = Math.max(20, contentWidth - 36);
  const useLine = normalizeOneLine(skill.whenToUse || skill.description || skill.purpose);
  const resourceLine = summarizeResources(skill);
  const sectionLine = summarizeSections(skill);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={4}>
          <Text color={ACCENT_COLOR}>{String(index + 1).padStart(2, '0')}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color="white" wrap="truncate-end">
            {skill.title}
          </Text>
          <Text color="gray">  {truncateMiddle(skill.relativeDir, 30)}</Text>
        </Box>
        <Box width={26} justifyContent="flex-end">
          <Text color="white">{formatNumber(skill.instructionTokenEstimate)}</Text>
          <Text color="gray"> tok  </Text>
          <Text color="white">{formatNumber(skill.totalResourceFiles)}</Text>
          <Text color="gray"> files</Text>
        </Box>
      </Box>
      <Box marginLeft={4}>
        <Text color="gray" wrap="truncate-end">
          purpose {truncateMiddle(normalizeOneLine(skill.purpose), detailWidth)}
        </Text>
      </Box>
      <Box marginLeft={4}>
        <Text color="gray" wrap="truncate-end">
          use {truncateMiddle(useLine, detailWidth)}
        </Text>
      </Box>
      <Box marginLeft={4}>
        <Text color="gray" wrap="truncate-end">
          resources {truncateMiddle(resourceLine, detailWidth)}
        </Text>
        <Text color="gray">  |  sections {truncateMiddle(sectionLine, 32)}</Text>
      </Box>
    </Box>
  );
}

export function SkillsOverviewScreen({ scopeLabel, result }: SkillsOverviewScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 4);
  const rule = '-'.repeat(contentWidth);
  const totalInstructionTokens = result.skills.reduce((sum, skill) => sum + skill.instructionTokenEstimate, 0);
  const skillFolders = new Set(result.skills.map((skill) => skill.relativeDir)).size;
  const largestSkill = result.skills
    .slice()
    .sort((left, right) => right.instructionTokenEstimate - left.instructionTokenEstimate || left.title.localeCompare(right.title))[0];
  const resourceCells = buildResourceCells(result.skills);
  const metricCells: MetricCell[] = [
    {
      label: 'skills',
      value: formatNumber(result.skills.length),
      note: 'found',
      tone: ACCENT_COLOR,
    },
    {
      label: 'tokens',
      value: formatNumber(totalInstructionTokens),
      note: 'tok',
      tone: 'white',
    },
    {
      label: 'support',
      value: formatNumber(result.totalResourceFiles),
      note: 'files',
      tone: 'white',
    },
    {
      label: 'folders',
      value: formatNumber(skillFolders),
      note: 'dirs',
      tone: 'white',
    },
    {
      label: 'scanned',
      value: formatNumber(result.scannedFileCount),
      note: 'files',
      tone: 'white',
    },
  ];

  const metricColumns = terminalWidth >= 120 ? 5 : terminalWidth >= 92 ? 3 : 2;
  const resourceColumns = terminalWidth >= 120 ? 4 : terminalWidth >= 92 ? 3 : 2;
  const metricCellWidth = Math.max(18, Math.floor((contentWidth - (metricColumns - 1) * 2) / metricColumns));
  const resourceCellWidth = Math.max(18, Math.floor((contentWidth - (resourceColumns - 1) * 2) / resourceColumns));
  const workspaceLabel = path.basename(result.rootPath) || result.rootPath;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="white">/skills  {formatScope(scopeLabel)}</Text>
      </Box>
      <Text color="gray">{truncateMiddle(result.rootPath, Math.max(28, contentWidth))}</Text>
      <Text color="gray">{rule}</Text>

      {chunk(metricCells, metricColumns).map((row, rowIndex) => (
        <Box key={`metrics-${rowIndex}`}>
          {row.map((cell, index) => (
            <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
              <CompactMetricCellView cell={cell} width={metricCellWidth} />
            </Box>
          ))}
        </Box>
      ))}

      <Text color="gray">
        workspace {truncateMiddle(workspaceLabel, 24)}
        {largestSkill
          ? `  |  largest ${truncateMiddle(largestSkill.title, 28)} (${formatNumber(largestSkill.instructionTokenEstimate)} tok)`
          : ''}
      </Text>

      <Text color="gray">{rule}</Text>
      <Text color="gray">RESOURCES</Text>
      {resourceCells.length === 0 ? (
        <Text color="gray">SKILL.md only</Text>
      ) : (
        chunk(resourceCells, resourceColumns).map((row, rowIndex) => (
          <Box key={`resources-${rowIndex}`}>
            {row.map((cell, index) => (
              <Box key={cell.kind} marginRight={index < row.length - 1 ? 2 : 0}>
                <CompactMetricCellView cell={cell} width={resourceCellWidth} />
              </Box>
            ))}
          </Box>
        ))
      )}

      <Text color="gray">{rule}</Text>
      <Text color="gray">SKILLS</Text>
      {result.skills.length === 0 ? (
        <>
          <Text color="yellow">No SKILL.md files found in this directory tree.</Text>
          <Text color="gray">Tip: add a skill folder that contains a SKILL.md file, then run /skills again.</Text>
        </>
      ) : (
        result.skills.map((skill, index) => (
          <SkillRowView key={`${skill.relativeDir}-${skill.name}`} skill={skill} index={index} contentWidth={contentWidth} />
        ))
      )}
    </Box>
  );
}
