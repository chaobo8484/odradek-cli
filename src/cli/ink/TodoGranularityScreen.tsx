import { Box, Text } from 'ink';
import type { TodoGranularityAnalysis, TodoGranularityBucket, TodoGranularitySuggestion } from '../TodoGranularityAnalyzer.js';

type TodoGranularityScreenProps = {
  scopeLabel: string;
  sourceLabel: string;
  analysis: TodoGranularityAnalysis;
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

function correlationTone(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'gray';
  }
  if (value >= 0.2) {
    return 'yellow';
  }
  if (value <= -0.2) {
    return 'green';
  }
  return 'gray';
}

function correlationBorder(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'gray';
  }
  if (value >= 0.2) {
    return 'yellow';
  }
  if (value <= -0.2) {
    return 'green';
  }
  return 'gray';
}

function formatPearson(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(2);
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.round(value * 100)}%`;
}

function renderBar(share: number, width = 18): string {
  const normalized = Math.max(0, Math.min(1, share));
  const filled = normalized > 0 ? Math.max(1, Math.round(normalized * width)) : 0;
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(Math.max(0, width - filled))}`;
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

function SummaryHero({ analysis }: { analysis: TodoGranularityAnalysis }) {
  const tone = correlationTone(analysis.pearsonR);
  const borderColor = correlationBorder(analysis.pearsonR);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text color="gray">SUMMARY</Text>
        <Text color="gray">{analysis.correlationLabel}</Text>
      </Box>
      <Box>
        <Text color={tone}>R {formatPearson(analysis.pearsonR)}</Text>
        <Text color="gray"> pearson correlation</Text>
      </Box>
      <Box>
        <Text color={analysis.suggestions.length > 0 ? 'yellow' : 'green'}>
          split candidates {analysis.suggestions.length}
        </Text>
        <Text color="gray">
          {' '}
          {analysis.suggestions.length > 0 ? 'review coarse todos first' : 'no obvious split pressure'}
        </Text>
      </Box>
    </Box>
  );
}

function BucketRowView({ bucket }: { bucket: TodoGranularityBucket }) {
  return (
    <Box>
      <Box width={8}>
        <Text color="gray">score {bucket.score}</Text>
      </Box>
      <Box width={18}>
        <Text color="cyan">{renderBar(bucket.share)}</Text>
      </Box>
      <Box width={6} justifyContent="flex-end">
        <Text color="white">{bucket.count}</Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text color="gray">{Math.round(bucket.share * 100)}%</Text>
      </Box>
      <Box width={11}>
        <Text color="gray">done {formatRate(bucket.completionRate)}</Text>
      </Box>
      <Box width={12}>
        <Text color="gray">stuck {formatRate(bucket.stuckRate)}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="gray">trunc {formatRate(bucket.truncationRate)}</Text>
      </Box>
    </Box>
  );
}

function SuggestionRowView({ suggestion, index, width }: { suggestion: TodoGranularitySuggestion; index: number; width: number }) {
  const tokenLabel =
    suggestion.contextTokens === null ? 'context n/a' : `${formatNumber(suggestion.contextTokens)} tok`;
  const explanation = `reason ${suggestion.reason} | split ${suggestion.splitHint}`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={4}>
          <Text color={ACCENT_COLOR}>{index + 1}.</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color="white" wrap="truncate-end">
            {truncateMiddle(suggestion.content, Math.max(24, width - 26))}
          </Text>
        </Box>
        <Box width={22} justifyContent="flex-end">
          <Text color="gray">score </Text>
          <Text color="white">{suggestion.granularityScore}</Text>
          <Text color="gray">  {tokenLabel}</Text>
        </Box>
      </Box>
      <Box marginLeft={4}>
        <Text color="gray" wrap="wrap">
          {explanation}
        </Text>
      </Box>
    </Box>
  );
}

export function TodoGranularityScreen({ scopeLabel, sourceLabel, analysis }: TodoGranularityScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 4);
  const rule = '-'.repeat(contentWidth);
  const summaryCells: MetricCell[] = [
    {
      label: 'sessions',
      value: `${analysis.sessionsWithTodos}/${analysis.sessionsScanned}`,
      note: 'with todos',
      tone: ACCENT_COLOR,
    },
    {
      label: 'todo files',
      value: formatNumber(analysis.todoFilesFound),
      note: `${analysis.sessionsUsingSnapshotFallback} fallback`,
      tone: 'white',
    },
    {
      label: 'todos',
      value: formatNumber(analysis.items.length),
      note: 'analyzed',
      tone: 'white',
    },
    {
      label: 'context',
      value: formatNumber(analysis.todosWithContext),
      note: 'attributed',
      tone: analysis.todosWithContext > 0 ? 'green' : 'yellow',
    },
    {
      label: 'suggestions',
      value: formatNumber(analysis.suggestions.length),
      note: 'split candidates',
      tone: analysis.suggestions.length > 0 ? 'yellow' : 'green',
    },
    {
      label: 'correlation',
      value: formatPearson(analysis.pearsonR),
      note: analysis.correlationLabel,
      tone: correlationTone(analysis.pearsonR),
    },
  ];

  const summaryColumns = terminalWidth >= 120 ? 3 : terminalWidth >= 92 ? 2 : 1;
  const summaryCellWidth = Math.max(20, Math.floor((contentWidth - (summaryColumns - 1) * 2) / summaryColumns));
  const suggestionWidth = Math.max(36, contentWidth);
  const sourceLine = `scope ${scopeLabel} | source ${truncateMiddle(sourceLabel, 42)}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="white">/todo_granularity</Text>
        <Text color="gray">odradek - todo granularity</Text>
      </Box>
      <Text color="gray">{sourceLine}</Text>
      <SummaryHero analysis={analysis} />
      {chunk(summaryCells, summaryColumns).map((row, rowIndex) => (
        <Box key={`summary-${rowIndex}`}>
          {row.map((cell, index) => (
            <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
              <CompactMetricCellView cell={cell} width={summaryCellWidth} />
            </Box>
          ))}
        </Box>
      ))}

      <Text color="gray">{rule}</Text>
      <Text color="gray">DISTRIBUTION</Text>
      {analysis.items.length === 0 ? (
        <Text color="gray">(no todo items found)</Text>
      ) : (
        analysis.buckets.map((bucket) => <BucketRowView key={`bucket-${bucket.score}`} bucket={bucket} />)
      )}

      <Text color="gray">{rule}</Text>
      <Text color="gray">SPLIT SUGGESTIONS</Text>
      {analysis.suggestions.length === 0 ? (
        <Text color="gray">No todo currently stands out as an obvious split candidate.</Text>
      ) : (
        analysis.suggestions.slice(0, 5).map((suggestion, index) => (
          <SuggestionRowView
            key={`${suggestion.sessionId}-${suggestion.todoId}`}
            suggestion={suggestion}
            index={index}
            width={suggestionWidth}
          />
        ))
      )}
      {analysis.suggestions.length > 5 ? (
        <Text color="gray">+{analysis.suggestions.length - 5} more suggestions not shown</Text>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <>
          <Text color="gray">{rule}</Text>
          <Text color="gray">NOTES</Text>
          {analysis.warnings.map((warning, index) => (
            <Text key={`warning-${index}`} color="yellow" wrap="wrap">
              - {warning}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  );
}
