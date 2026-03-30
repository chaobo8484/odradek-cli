import path from 'path';
import { Box, Text } from 'ink';
import type { PromptAssetCategory, PromptAssetFile } from '../PromptAssetScanner.js';

type ScanPromptScreenProps = {
  scopeLabel: string;
  rootPath: string;
  tokenizerModeLabel: string;
  tokenizerWarning?: string;
  scannedFileCount: number;
  files: PromptAssetFile[];
  anatomyLines: string[];
  anatomySummary: string[];
  recommendations: string[];
};

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: string;
};

type LegendItem = {
  short: string;
  label: string;
  tone: string;
};

const ACCENT_COLOR = '#D6F54A';
const CATEGORY_ORDER: PromptAssetCategory[] = ['project-config', 'prompt-file', 'rules', 'system-prompt', 'docs'];
const CATEGORY_LABELS: Record<PromptAssetCategory, string> = {
  'project-config': 'config',
  'prompt-file': 'prompt',
  rules: 'rules',
  'system-prompt': 'system',
  docs: 'docs',
};
const BUDGET_LEGEND: LegendItem[] = [
  { short: 'S', label: 'core instructions', tone: 'blue' },
  { short: 'P', label: 'rules and prompts', tone: 'magenta' },
  { short: 'D', label: 'reference docs', tone: 'green' },
  { short: 'H', label: 'chat history', tone: 'yellow' },
  { short: 'U', label: 'active request', tone: 'white' },
  { short: '.', label: 'free headroom', tone: 'gray' },
];

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

function measureMetricCell(cell: MetricCell): number {
  return `${cell.label} ${cell.value} ${cell.note}`.trim().length;
}

function resolveMetricColumns(cells: MetricCell[], contentWidth: number, preferredColumns: number): number {
  const maxColumns = Math.max(1, Math.min(preferredColumns, cells.length));
  const longestCell = Math.max(...cells.map((cell) => measureMetricCell(cell)), 0);

  for (let columns = maxColumns; columns >= 1; columns -= 1) {
    const cellWidth = Math.floor((contentWidth - (columns - 1) * 2) / columns);
    if (cellWidth >= longestCell) {
      return columns;
    }
  }

  return 1;
}

function categoryTone(category: PromptAssetCategory): string {
  if (category === 'docs') return 'green';
  if (category === 'prompt-file' || category === 'rules') return 'magenta';
  return 'cyan';
}

function summarizeCategories(categories: PromptAssetCategory[]): string {
  return categories.map((category) => CATEGORY_LABELS[category]).join(' | ');
}

function parseAnatomySummary(items: string[]): Map<string, string> {
  const summary = new Map<string, string>();
  items.forEach((item) => {
    const separatorIndex = item.indexOf(':');
    if (separatorIndex <= 0) {
      return;
    }

    const key = item.slice(0, separatorIndex).trim();
    const value = item.slice(separatorIndex + 1).trim();
    if (key && value) {
      summary.set(key, value);
    }
  });
  return summary;
}

function CompactMetricCellView({ cell, width }: { cell: MetricCell; width: number }) {
  return (
    <Box width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color="gray">{cell.label} </Text>
        <Text color={cell.tone ?? 'white'}>{cell.value}</Text>
        <Text color="gray"> {cell.note}</Text>
      </Text>
    </Box>
  );
}

function LegendItemView({ item, width }: { item: LegendItem; width: number }) {
  return (
    <Box width={width}>
      <Text color={item.tone}>{item.short}</Text>
      <Text color="gray"> = {item.label}</Text>
    </Box>
  );
}

function FileRowView({ file, pathWidth }: { file: PromptAssetFile; pathWidth: number }) {
  const primaryCategory = file.categories[0] ?? 'docs';
  return (
    <Box>
      <Box width={9} justifyContent="flex-end">
        <Text color="white">{formatNumber(file.tokenCount)}</Text>
      </Box>
      <Box width={5}>
        <Text color="gray"> tok</Text>
      </Box>
      <Box width={pathWidth}>
        <Text color={categoryTone(primaryCategory)} wrap="truncate-end">
          {truncateMiddle(file.relativePath, pathWidth)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="gray" wrap="truncate-end">
          {summarizeCategories(file.categories)}
        </Text>
      </Box>
    </Box>
  );
}

export function ScanPromptScreen({
  scopeLabel,
  rootPath,
  tokenizerModeLabel,
  tokenizerWarning,
  scannedFileCount,
  files,
  anatomyLines,
  anatomySummary,
  recommendations,
}: ScanPromptScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(40, terminalWidth - 4);
  const rule = '-'.repeat(contentWidth);
  const totalPromptTokens = files.reduce((sum, file) => sum + file.tokenCount, 0);
  const largestFile = files
    .slice()
    .sort((left, right) => right.tokenCount - left.tokenCount || left.relativePath.localeCompare(right.relativePath))[0];
  const topFiles = files
    .slice()
    .sort((left, right) => right.tokenCount - left.tokenCount || left.relativePath.localeCompare(right.relativePath))
    .slice(0, 8);
  const extraFileCount = Math.max(0, files.length - topFiles.length);
  const categoryCounts = new Map<PromptAssetCategory, number>();
  CATEGORY_ORDER.forEach((category) => {
    categoryCounts.set(category, files.filter((file) => file.categories.includes(category)).length);
  });
  const summary = parseAnatomySummary(anatomySummary);
  const preservedBarLines = anatomyLines.filter(
    (line) => line.startsWith('Window load') || line.startsWith('Payload mix')
  );

  const topCells: MetricCell[] = [
    {
      label: 'assets',
      value: formatNumber(files.length),
      note: 'matched',
      tone: ACCENT_COLOR,
    },
    {
      label: 'tokens',
      value: formatNumber(totalPromptTokens),
      note: 'tok',
      tone: ACCENT_COLOR,
    },
    {
      label: 'scanned',
      value: formatNumber(scannedFileCount),
      note: 'files',
      tone: ACCENT_COLOR,
    },
    {
      label: 'tokenizer',
      value: tokenizerModeLabel,
      note: 'mode',
      tone: ACCENT_COLOR,
    },
  ];

  const categoryCells: MetricCell[] = CATEGORY_ORDER.map((category) => ({
    label: CATEGORY_LABELS[category],
    value: String(categoryCounts.get(category) ?? 0),
    note: 'files',
    tone: categoryTone(category),
  }));

  const fitLines: Array<{ label: string; value: string; tone?: string }> = [
    {
      label: 'budget',
      value: summary.get('budget') ?? 'n/a',
      tone: 'white',
    },
    {
      label: 'headroom',
      value: summary.get('headroom') ?? 'n/a',
      tone: 'white',
    },
    {
      label: 'dominant',
      value: summary.get('dominant') ?? 'n/a',
      tone: ACCENT_COLOR,
    },
    {
      label: 'mix',
      value: summary.get('liveAsk') ?? 'n/a',
      tone: 'white',
    },
  ];

  const metricColumns = resolveMetricColumns(topCells, contentWidth, terminalWidth >= 120 ? 4 : 2);
  const categoryColumns = terminalWidth >= 120 ? 5 : terminalWidth >= 90 ? 3 : 2;
  const legendColumns = terminalWidth >= 120 ? 3 : terminalWidth >= 90 ? 2 : 1;
  const metricCellWidth = Math.max(18, Math.floor((contentWidth - (metricColumns - 1) * 2) / metricColumns));
  const categoryCellWidth = Math.max(16, Math.floor((contentWidth - (categoryColumns - 1) * 2) / categoryColumns));
  const legendCellWidth = Math.max(22, Math.floor((contentWidth - (legendColumns - 1) * 2) / legendColumns));
  const pathWidth = Math.max(26, Math.min(52, contentWidth - 32));
  const workspaceLabel = path.basename(rootPath) || rootPath;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="white">/scan_prompt  {formatScope(scopeLabel)}</Text>
      </Box>
      <Text color="gray">{truncateMiddle(rootPath, Math.max(28, contentWidth))}</Text>
      <Text color="gray">{rule}</Text>

      {chunk(topCells, metricColumns).map((row, rowIndex) => (
        <Box key={`summary-${rowIndex}`}>
          {row.map((cell, index) => (
            <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
              <CompactMetricCellView cell={cell} width={metricCellWidth} />
            </Box>
          ))}
        </Box>
      ))}

      <Text color="gray">
        workspace {truncateMiddle(workspaceLabel, 24)}
        {largestFile ? `  |  largest ${truncateMiddle(largestFile.relativePath, 28)} (${formatNumber(largestFile.tokenCount)} tok)` : ''}
      </Text>
      {tokenizerWarning ? <Text color="yellow">! {truncateMiddle(tokenizerWarning, contentWidth)}</Text> : null}
      <Text color="gray">{rule}</Text>

      <Text color="gray">CATEGORIES</Text>
      {chunk(categoryCells, categoryColumns).map((row, rowIndex) => (
        <Box key={`categories-${rowIndex}`}>
          {row.map((cell, index) => (
            <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
              <CompactMetricCellView cell={cell} width={categoryCellWidth} />
            </Box>
          ))}
        </Box>
      ))}

      <Text color="gray">{rule}</Text>
      <Text color="gray">TOP FILES</Text>
      {topFiles.map((file) => (
        <FileRowView key={file.relativePath} file={file} pathWidth={pathWidth} />
      ))}
      {extraFileCount > 0 ? <Text color="gray">+{extraFileCount} more files not shown</Text> : null}

      {preservedBarLines.length > 0 ? (
        <>
          <Text color="gray">{rule}</Text>
          <Text color="gray">BUDGET BARS</Text>
          {preservedBarLines.map((line, index) => (
            <Text key={`bar-${index}`} wrap="wrap">
              {line}
            </Text>
          ))}
          {chunk(BUDGET_LEGEND, legendColumns).map((row, rowIndex) => (
            <Box key={`legend-${rowIndex}`}>
              {row.map((item, index) => (
                <Box key={item.short} marginRight={index < row.length - 1 ? 2 : 0}>
                  <LegendItemView item={item} width={legendCellWidth} />
                </Box>
              ))}
            </Box>
          ))}
        </>
      ) : null}

      <Text color="gray">{rule}</Text>
      <Text color="gray">CONTEXT FIT</Text>
      {fitLines.map((line) => (
        <Text key={line.label}>
          <Text color="gray">{line.label} </Text>
          <Text color={line.tone ?? 'white'}>{line.value}</Text>
        </Text>
      ))}
      {recommendations.slice(0, 3).map((item, index) => (
        <Text key={`rec-${index}`} color={index === 0 ? 'yellow' : 'gray'} wrap="wrap">
          {index === 0 ? 'tune ' : 'next '} {item}
        </Text>
      ))}
      {recommendations.length > 3 ? <Text color="gray">+{recommendations.length - 3} more actions</Text> : null}
    </Box>
  );
}
