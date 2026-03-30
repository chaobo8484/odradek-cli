import path from 'path';
import { Box, Text } from 'ink';
import type { ExtractedRule, RulesFile, RulesScanResult } from '../RuleScanner.js';

type RulesScanScreenProps = {
  scopeLabel: string;
  result: RulesScanResult;
};

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: string;
};

const ACCENT_COLOR = '#D6F54A';

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

function normalizeOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function CompactMetricCellView({ cell, width }: { cell: MetricCell; width: number }) {
  return (
    <Box width={width}>
      <Text color="gray">{cell.label} </Text>
      <Text color={cell.tone ?? 'white'}>{cell.value}</Text>
      <Text color="gray"> {cell.note}</Text>
    </Box>
  );
}

function signalColor(signal: ExtractedRule['signal']): string {
  return signal === 'explicit' ? 'green' : 'yellow';
}

function summarizeLabels(file: RulesFile): string {
  return file.labels.length > 0 ? file.labels.join(' | ') : 'unlabeled';
}

function summarizeHeadings(file: RulesFile): string {
  const headings = Array.from(
    new Set(
      file.rules
        .map((rule) => normalizeOneLine(rule.headingPath.join(' > ')))
        .filter((item) => item.length > 0)
    )
  );

  if (headings.length === 0) {
    return 'none';
  }

  return headings.slice(0, 3).join(' | ');
}

function buildSignalSummary(result: RulesScanResult): MetricCell[] {
  const explicitCount = result.files.reduce(
    (sum, file) => sum + file.rules.filter((rule) => rule.signal === 'explicit').length,
    0
  );
  const sectionCount = result.totalRules - explicitCount;

  return [
    {
      label: 'explicit',
      value: formatNumber(explicitCount),
      note: 'rule lines',
      tone: 'green',
    },
    {
      label: 'section',
      value: formatNumber(sectionCount),
      note: 'section hits',
      tone: 'yellow',
    },
  ].filter((cell) => Number.parseInt(cell.value.replace(/,/g, ''), 10) > 0);
}

function RuleRowView({ rule, width }: { rule: ExtractedRule; width: number }) {
  const lineLabel = rule.lineStart === rule.lineEnd ? `L${rule.lineStart}` : `L${rule.lineStart}-${rule.lineEnd}`;
  const heading = rule.headingPath.length > 0 ? rule.headingPath.join(' > ') : '';
  const prefix = `[${lineLabel} ${rule.signal}]`;

  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      <Text wrap="wrap">
        <Text color={signalColor(rule.signal)}>{prefix}</Text>
        <Text color="gray"> </Text>
        <Text color="white">{rule.text}</Text>
      </Text>
      {heading ? (
        <Box marginLeft={2}>
          <Text color="gray" wrap="truncate-end">
            {truncateMiddle(heading, Math.max(28, width - 10))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function FileSectionView({ file, index, contentWidth }: { file: RulesFile; index: number; contentWidth: number }) {
  const pathWidth = Math.max(30, contentWidth - 20);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={4}>
          <Text color={ACCENT_COLOR}>{String(index + 1).padStart(2, '0')}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color="cyan" wrap="truncate-end">
            {truncateMiddle(file.relativePath, pathWidth)}
          </Text>
        </Box>
        <Box width={14} justifyContent="flex-end">
          <Text color="white">{formatNumber(file.rules.length)}</Text>
          <Text color="gray"> rules</Text>
        </Box>
      </Box>
      <Box marginLeft={4}>
        <Text color="gray" wrap="truncate-end">
          labels {truncateMiddle(summarizeLabels(file), contentWidth - 12)}
        </Text>
      </Box>
      <Box marginLeft={4} marginBottom={file.rules.length > 0 ? 0 : 1}>
        <Text color="gray" wrap="truncate-end">
          headings {truncateMiddle(summarizeHeadings(file), contentWidth - 14)}
        </Text>
      </Box>
      {file.rules.map((rule, ruleIndex) => (
        <RuleRowView key={`${file.relativePath}-${rule.lineStart}-${ruleIndex}`} rule={rule} width={contentWidth} />
      ))}
    </Box>
  );
}

export function RulesScanScreen({ scopeLabel, result }: RulesScanScreenProps) {
  const terminalWidth = process.stdout.columns ?? 110;
  const contentWidth = Math.max(76, terminalWidth - 4);
  const rule = '-'.repeat(contentWidth);
  const workspaceLabel = path.basename(result.rootPath) || result.rootPath;
  const largestFile = result.files
    .slice()
    .sort((left, right) => right.rules.length - left.rules.length || left.relativePath.localeCompare(right.relativePath))[0];

  const metricCells: MetricCell[] = [
    {
      label: 'files',
      value: formatNumber(result.matchedFileCount),
      note: 'matched',
      tone: ACCENT_COLOR,
    },
    {
      label: 'rules',
      value: formatNumber(result.totalRules),
      note: 'extracted',
      tone: 'white',
    },
    {
      label: 'candidates',
      value: formatNumber(result.candidateFileCount),
      note: 'rule sources',
      tone: 'white',
    },
    {
      label: 'scanned',
      value: formatNumber(result.scannedFileCount),
      note: 'files',
      tone: 'white',
    },
  ];

  const signalCells = buildSignalSummary(result);
  const metricColumns = terminalWidth >= 120 ? 4 : terminalWidth >= 92 ? 2 : 2;
  const signalColumns = terminalWidth >= 120 ? 2 : 1;
  const metricCellWidth = Math.max(18, Math.floor((contentWidth - (metricColumns - 1) * 2) / metricColumns));
  const signalCellWidth = Math.max(20, Math.floor((contentWidth - (signalColumns - 1) * 2) / signalColumns));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="white">/rules  {formatScope(scopeLabel)}</Text>
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
        {largestFile ? `  |  densest ${truncateMiddle(largestFile.relativePath, 30)} (${formatNumber(largestFile.rules.length)} rules)` : ''}
      </Text>
      <Text color="gray">rule extraction is deterministic and line-based; output shows observed instruction lines, not semantic summaries</Text>

      {signalCells.length > 0 ? (
        <>
          <Text color="gray">{rule}</Text>
          <Text color="gray">SIGNALS</Text>
          {chunk(signalCells, signalColumns).map((row, rowIndex) => (
            <Box key={`signals-${rowIndex}`}>
              {row.map((cell, index) => (
                <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
                  <CompactMetricCellView cell={cell} width={signalCellWidth} />
                </Box>
              ))}
            </Box>
          ))}
        </>
      ) : null}

      <Text color="gray">{rule}</Text>
      <Text color="gray">RULE FILES</Text>
      {result.files.length === 0 ? (
        <>
          <Text color="yellow">No explicit rule lines were detected in the target workspace.</Text>
          <Text color="gray">Tip: place instructions in AGENTS.md, CLAUDE.md, .cursor/.claude, rules/, or system-prompt files.</Text>
        </>
      ) : (
        result.files.map((file, index) => (
          <FileSectionView key={`${file.relativePath}-${index}`} file={file} index={index} contentWidth={contentWidth} />
        ))
      )}
    </Box>
  );
}
