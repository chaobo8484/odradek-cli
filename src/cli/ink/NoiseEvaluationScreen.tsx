import path from 'path';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type {
  GitDiffFile,
  NoiseCoverageRow,
  NoiseDimensionReport,
  NoiseEvaluationReport,
  NoiseMetric,
  NoiseMetricStatus,
} from '../NoiseEvaluator.js';

type NoiseEvaluationScreenProps = {
  scopeLabel: string;
  sourceLabel: string;
  selectedSource: 'claude' | 'codex';
  report: NoiseEvaluationReport;
};

type SummaryStat = {
  key: string;
  label: string;
  value: string;
  accentColor: string;
  note?: string;
};

type HighlightItem = {
  id: string;
  tag: string;
  severity: Extract<NoiseMetricStatus, 'watch' | 'high'>;
  message: string;
};

type Tone = 'white' | 'gray' | 'green' | 'yellow' | 'red' | 'cyan' | 'blue';

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function statusColor(status: NoiseMetricStatus): string {
  if (status === 'ok') return 'green';
  if (status === 'watch') return 'yellow';
  if (status === 'high') return 'red';
  return 'gray';
}

function statusLabel(status: NoiseMetricStatus): string {
  if (status === 'ok') return 'OK';
  if (status === 'watch') return 'WATCH';
  if (status === 'high') return 'HIGH';
  return 'N/A';
}

function statusGlyph(status: NoiseMetricStatus): string {
  if (status === 'ok') return '+';
  if (status === 'watch') return '!';
  if (status === 'high') return '!';
  return '-';
}

function normalizeDimensionLabel(dimension: NoiseCoverageRow['dimension']): string {
  if (dimension === 'context') return 'prompt/context';
  return dimension;
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

function joinEvidence(items: string[], maxLength = 116): string {
  if (items.length === 0) {
    return 'none';
  }

  const summary = items.join('; ');
  if (summary.length <= maxLength) {
    return summary;
  }

  let current = '';
  let used = 0;
  for (const item of items) {
    const candidate = current ? `${current}; ${item}` : item;
    if (candidate.length > maxLength) {
      break;
    }
    current = candidate;
    used += 1;
  }

  if (!current) {
    return `${items[0].slice(0, Math.max(0, maxLength - 8))}...`;
  }

  const remaining = items.length - used;
  return remaining > 0 ? `${current}; +${remaining} more` : current;
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

function buildMetricHeadline(metric: NoiseMetric): string {
  if (metric.value === 'N/A') {
    return metric.label;
  }

  if (metric.value === 'missing' || metric.value === 'present') {
    return `${metric.label}: ${metric.value}`;
  }

  return `${metric.value} ${metric.label.toLowerCase()}`;
}

function collectHighlights(report: NoiseEvaluationReport): HighlightItem[] {
  const items: Array<HighlightItem & { weight: number }> = [];

  for (const dimension of report.dimensions) {
    for (const metric of dimension.metrics) {
      if (metric.status !== 'watch' && metric.status !== 'high') {
        continue;
      }

      items.push({
        id: `${dimension.key}-${metric.key}`,
        tag: dimension.key,
        severity: metric.status,
        message: `${buildMetricHeadline(metric)} - ${metric.summary}`,
        weight: metric.status === 'high' ? 0 : 1,
      });
    }
  }

  report.warnings.forEach((warning, index) => {
    items.push({
      id: `warning-${index}`,
      tag: 'warning',
      severity: 'watch',
      message: warning,
      weight: 2,
    });
  });

  return items
    .sort((left, right) => left.weight - right.weight || left.message.localeCompare(right.message))
    .slice(0, 4)
    .map(({ weight: _weight, ...item }) => item);
}

function buildSummaryStats(scopeLabel: string, report: NoiseEvaluationReport): SummaryStat[] {
  const projectLabel = report.workspaceRoot ? path.basename(report.workspaceRoot) : scopeLabel;
  const changedLines = report.git ? report.git.totalAddedLines + report.git.totalDeletedLines : 0;
  const flaggedDimensions = report.dimensions.filter((dimension) => dimension.status === 'watch' || dimension.status === 'high').length;

  return [
    {
      key: 'grade',
      label: 'Coverage Grade',
      value: report.coverageGrade,
      accentColor:
        report.coverageGrade === 'A'
          ? 'green'
          : report.coverageGrade === 'B'
          ? 'yellow'
          : report.coverageGrade === 'C'
          ? 'yellow'
          : 'red',
      note: projectLabel || 'workspace n/a',
    },
    {
      key: 'sessions',
      label: 'Sessions',
      value: `${report.sessionsAnalyzed}/${report.sessionsScanned}`,
      accentColor: 'green',
      note:
        report.sessionsAnalyzed === report.sessionsScanned
          ? 'all analyzed'
          : `${report.sessionsScanned - report.sessionsAnalyzed} skipped`,
    },
    {
      key: 'diff',
      label: 'Changed Files',
      value: report.git ? String(report.git.totalChangedFiles) : 'N/A',
      accentColor: report.git && report.git.totalChangedFiles > 0 ? 'white' : 'gray',
      note: report.git ? `${formatNumber(changedLines)} lines` : 'git unavailable',
    },
    {
      key: 'signals',
      label: 'Noise Signals',
      value: String(flaggedDimensions),
      accentColor: flaggedDimensions > 0 ? 'yellow' : 'green',
      note: flaggedDimensions > 0 ? 'need review' : 'no active watch',
    },
    {
      key: 'tokens',
      label: 'Estimated Tokens',
      value: formatNumber(report.totalEstimatedTokens),
      accentColor: 'white',
      note: 'tok',
    },
    {
      key: 'tools',
      label: 'Tool Calls',
      value: formatNumber(report.totalToolCalls),
      accentColor: 'white',
    },
  ];
}

function DiffRow({ file, pathWidth }: { file: GitDiffFile; pathWidth: number }) {
  const pathColor =
    file.attributed === false || file.generatedLike ? 'yellow' : file.attributed === true ? 'white' : 'gray';
  const deltaLabel =
    file.addedLines === null && file.deletedLines === null ? 'n/a' : `+${file.addedLines ?? 0} / -${file.deletedLines ?? 0}`;

  return (
    <Box>
      <Box width={11}>
        <Text color="gray">{file.status}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={pathColor} wrap="truncate-end">
          {truncateMiddle(file.path, pathWidth)}
        </Text>
      </Box>
      <Box width={18} justifyContent="flex-end">
        {deltaLabel === 'n/a' ? (
          <Text color="gray">{deltaLabel}</Text>
        ) : (
          <Text>
            <Text color="green">+{file.addedLines ?? 0}</Text>
            <Text color="gray"> / </Text>
            <Text color="red">-{file.deletedLines ?? 0}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

function CoverageRowView({ row }: { row: NoiseCoverageRow }) {
  const availabilityColor = row.available ? 'green' : 'red';
  const reliabilityColor =
    row.reliability === 'high' ? 'green' : row.reliability === 'medium' ? 'yellow' : 'red';
  const summaryText = row.notes ? `${row.sources.length > 0 ? `${row.sources.join(', ')} | ` : ''}${row.notes}` : row.sources.join(', ') || 'n/a';

  return (
    <Box>
      <Box width={16}>
        <Text color="white">{normalizeDimensionLabel(row.dimension)}</Text>
      </Box>
      <Box width={6}>
        <Text color={availabilityColor}>{row.available ? 'yes' : 'no'}</Text>
      </Box>
      <Box width={8}>
        <Text color={reliabilityColor}>{row.reliability}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="gray" wrap="truncate-end">
          {summaryText || 'n/a'}
        </Text>
      </Box>
    </Box>
  );
}

function MetricRow({ metric }: { metric: NoiseMetric }) {
  return (
    <Box justifyContent="space-between">
      <Box flexGrow={1} marginRight={1}>
        <Text color={statusColor(metric.status)}>
          {statusGlyph(metric.status)}{' '}
          <Text color="gray" wrap="truncate-end">
            {metric.label}
          </Text>
        </Text>
      </Box>
      <Text color={metric.status === 'na' ? 'gray' : statusColor(metric.status)}>{metric.value}</Text>
    </Box>
  );
}

function SummaryGridCell({ stat, width }: { stat: SummaryStat; width: number }) {
  return (
    <Box width={width} flexDirection="column" marginBottom={1}>
      <Text color="gray">{stat.label.toUpperCase()}</Text>
      <Text color={stat.accentColor}>{stat.value}</Text>
      <Text color="gray" wrap="truncate-end">
        {stat.note ?? ''}
      </Text>
    </Box>
  );
}

function SummaryHero({ grade, signals, width }: { grade: SummaryStat; signals: SummaryStat; width: number }) {
  return (
    <SectionBlock title="Summary" width={width} note={grade.note ?? 'workspace n/a'} tone={grade.accentColor as Tone}>
      <Box>
        <Text color={grade.accentColor}>GRADE {grade.value}</Text>
        <Text color="gray"> coverage grade</Text>
      </Box>
      <Box>
        <Text color={signals.accentColor}>signals {signals.value}</Text>
        <Text color="gray"> {signals.note ?? 'no active watch'}</Text>
      </Box>
    </SectionBlock>
  );
}

function DimensionCard({ dimension, width }: { dimension: NoiseDimensionReport; width: number }) {
  const focusSignal = dimension.signals[0];
  const evidenceParts = [
    `obs ${joinEvidence(dimension.observedFacts, 44)}`,
    `drv ${joinEvidence(dimension.derivedFeatures, 44)}`,
  ];
  if (dimension.semanticJudgments.length > 0) {
    evidenceParts.push(`sem ${joinEvidence(dimension.semanticJudgments, 32)}`);
  }

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text color="gray">{dimension.label.replace(/\s+Noise$/, '').toUpperCase()}</Text>
        <Text>
          <Text color={statusColor(dimension.status)}>{statusLabel(dimension.status)}</Text>
          <Text color="gray"> conf:{dimension.confidence}</Text>
        </Text>
      </Box>

      <Text color="gray" wrap="wrap">
        {dimension.summary}
      </Text>
      {dimension.metrics.map((metric) => (
        <MetricRow key={`${dimension.key}-${metric.key}`} metric={metric} />
      ))}
      <Text color="gray" wrap="wrap">
        Evidence: {evidenceParts.join(' | ')}
      </Text>
      {focusSignal ? (
        <Text color="gray" wrap="wrap">
          Focus: {focusSignal.label.toLowerCase()} - {truncateMiddle(focusSignal.target || '(unknown)', 60)}
        </Text>
      ) : null}
    </Box>
  );
}

export function NoiseEvaluationScreen({ scopeLabel, sourceLabel, selectedSource, report }: NoiseEvaluationScreenProps) {
  const terminalWidth = process.stdout.columns ?? 120;
  const contentWidth = Math.max(64, terminalWidth - 2);
  const dimensionColumns = terminalWidth >= 120 ? 2 : 1;
  const dimensionCardWidth = Math.max(28, Math.floor((contentWidth - (dimensionColumns - 1)) / dimensionColumns));
  const highlightItems = collectHighlights(report);
  const summaryStats = buildSummaryStats(scopeLabel, report);
  const gradeStat = summaryStats.find((stat) => stat.key === 'grade') ?? summaryStats[0];
  const signalsStat = summaryStats.find((stat) => stat.key === 'signals') ?? summaryStats[0];
  const secondaryStats = summaryStats.filter((stat) => stat.key !== 'grade');
  const attributedDiffFiles = report.git?.files.filter((file) => file.attributed === true) ?? [];
  const diffFiles = attributedDiffFiles.slice(0, 8);
  const hiddenDiffFileCount = Math.max(0, (report.git?.files.length ?? 0) - attributedDiffFiles.length);
  const diffPathWidth = Math.max(26, contentWidth - 34);
  const scopeLine = `scope ${scopeLabel} | source ${truncateMiddle(sourceLabel, 40)}`;
  const summaryColumns = terminalWidth >= 120 ? 3 : terminalWidth >= 92 ? 2 : 1;
  const summaryCellWidth = Math.max(18, Math.floor((contentWidth - (summaryColumns - 1) * 2) / summaryColumns));
  const commandLine = `/noise_eval ${selectedSource}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="white">{commandLine}</Text>
        <Text color="gray">odradek - noise eval</Text>
      </Box>
      <Text color="gray">{scopeLine}</Text>
      <SummaryHero grade={gradeStat} signals={signalsStat} width={contentWidth} />
      {chunk(secondaryStats, summaryColumns).map((row, rowIndex) => (
        <Box key={`summary-grid-${rowIndex}`}>
          {row.map((stat, index) => (
            <Box key={stat.key} marginRight={index < row.length - 1 ? 2 : 0}>
              <SummaryGridCell stat={stat} width={summaryCellWidth} />
            </Box>
          ))}
        </Box>
      ))}

      {highlightItems.length > 0 ? (
        <SectionBlock title="Watch" width={contentWidth} note={`${highlightItems.length} item(s)`} tone="yellow">
          {highlightItems.map((item) => (
            <Text key={item.id} color={item.severity === 'high' ? 'red' : 'yellow'} wrap="wrap">
              [{item.tag}] {item.message}
            </Text>
          ))}
        </SectionBlock>
      ) : null}

      {report.nextActions.length > 0 ? (
        <SectionBlock title="Next Actions" width={contentWidth} tone="green">
          {report.nextActions.slice(0, 4).map((action, index) => (
            <Text key={`action-${index}`} color="white" wrap="wrap">
              {index + 1}. {action}
            </Text>
          ))}
        </SectionBlock>
      ) : null}

      <SectionBlock title="Evidence Coverage" width={contentWidth}>
        {report.coverage.map((row) => (
          <CoverageRowView key={row.dimension} row={row} />
        ))}
        <Box marginTop={1} marginBottom={0}>
          <Text color="gray">Feasible Scope</Text>
        </Box>
        {report.feasibleScope.map((item, index) => (
          <Text key={`scope-${index}`} color="gray" wrap="wrap">
            {index + 1}. {item}
          </Text>
        ))}
      </SectionBlock>

      <SectionBlock title="Dimension Metrics" width={contentWidth} marginBottom={0}>
        {chunk(report.dimensions, dimensionColumns).map((row, rowIndex) => (
          <Box key={`dimensions-${rowIndex}`}>
            {row.map((dimension, cardIndex) => (
              <Box key={dimension.key} marginRight={cardIndex < row.length - 1 ? 1 : 0}>
                <DimensionCard dimension={dimension} width={dimensionCardWidth} />
              </Box>
            ))}
          </Box>
        ))}
      </SectionBlock>

      {report.git && report.git.files.length > 0 ? (
        <SectionBlock
          title="Current Diff from Agent"
          width={contentWidth}
          note={
            hiddenDiffFileCount > 0
              ? `${diffFiles.length} agent file(s) shown · ${hiddenDiffFileCount} hidden`
              : `${diffFiles.length} agent file(s)`
          }
          marginBottom={report.warnings.length > 0 ? 1 : 0}
        >
          {diffFiles.length > 0 ? (
            <>
            <Box marginBottom={1}>
              <Box width={11}>
                <Text color="gray">STATUS</Text>
              </Box>
              <Box flexGrow={1}>
                <Text color="gray">FILE</Text>
              </Box>
              <Box width={18} justifyContent="flex-end">
                <Text color="gray">+lines / -lines</Text>
              </Box>
            </Box>
            {diffFiles.map((file) => (
              <DiffRow key={`${file.status}-${file.path}`} file={file} pathWidth={diffPathWidth} />
            ))}
            </>
          ) : (
            <Text color="gray" wrap="wrap">
              No agent-attributed diff files were found in the current working tree.
            </Text>
          )}
        </SectionBlock>
      ) : null}

      {report.warnings.length > 0 ? (
        <SectionBlock title="Warnings" width={contentWidth} tone="yellow" marginBottom={0}>
          {report.warnings.map((warning, index) => (
            <Text key={`warning-${index}`} color="gray" wrap="wrap">
              - {warning}
            </Text>
          ))}
        </SectionBlock>
      ) : null}
    </Box>
  );
}
