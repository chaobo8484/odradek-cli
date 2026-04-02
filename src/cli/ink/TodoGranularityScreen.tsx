import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { TodoGranularityAnalysis, TodoGranularityBucket, TodoGranularitySuggestion } from '../TodoGranularityAnalyzer.js';

type TodoGranularityScreenProps = {
  scopeLabel: string;
  sourceLabel: string;
  selectedSource: 'claude' | 'codex';
  analysis: TodoGranularityAnalysis;
};

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: string;
};

type Tone = 'white' | 'gray' | 'green' | 'yellow' | 'red' | 'cyan' | 'blue';

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

function correlationTone(value: number | null): Tone {
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

function SummarySection({
  analysis,
  summaryCells,
  summaryColumns,
  summaryCellWidth,
  width,
}: {
  analysis: TodoGranularityAnalysis;
  summaryCells: MetricCell[];
  summaryColumns: number;
  summaryCellWidth: number;
  width: number;
}) {
  const tone = correlationTone(analysis.pearsonR);

  return (
    <SectionBlock title="Summary" width={width} note={analysis.correlationLabel} tone={tone}>
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
      {chunk(summaryCells, summaryColumns).map((row, rowIndex) => (
        <Box key={`summary-${rowIndex}`}>
          {row.map((cell, index) => (
            <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
              <CompactMetricCellView cell={cell} width={summaryCellWidth} />
            </Box>
          ))}
        </Box>
      ))}
    </SectionBlock>
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

export function TodoGranularityScreen({
  scopeLabel,
  sourceLabel,
  selectedSource,
  analysis,
}: TodoGranularityScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 2);
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
      note: 'structured sources',
      tone: 'white',
    },
    {
      label: 'fallback',
      value: formatNumber(analysis.sessionsUsingSnapshotFallback),
      note: 'snapshot fallback',
      tone: analysis.sessionsUsingSnapshotFallback > 0 ? 'yellow' : 'gray',
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
  ];

  const summaryColumns = terminalWidth >= 120 ? 3 : terminalWidth >= 92 ? 2 : 1;
  const summaryCellWidth = Math.max(20, Math.floor((contentWidth - (summaryColumns - 1) * 2) / summaryColumns));
  const suggestionWidth = Math.max(36, contentWidth);
  const sourceLine = `scope ${scopeLabel} | source ${truncateMiddle(sourceLabel, 42)}`;
  const commandLine = `/todo_granularity ${selectedSource}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="white">{commandLine}</Text>
        <Text color="gray">odradek - todo granularity</Text>
      </Box>
      <Text color="gray">{sourceLine}</Text>

      <SummarySection
        analysis={analysis}
        summaryCells={summaryCells}
        summaryColumns={summaryColumns}
        summaryCellWidth={summaryCellWidth}
        width={contentWidth}
      />

      <SectionBlock
        title="Distribution"
        width={contentWidth}
        note={analysis.items.length === 0 ? 'no todo items' : `${analysis.items.length} analyzed`}
      >
        {analysis.items.length === 0 ? (
          <Text color="gray">(no todo items found)</Text>
        ) : (
          analysis.buckets.map((bucket) => <BucketRowView key={`bucket-${bucket.score}`} bucket={bucket} />)
        )}
      </SectionBlock>

      <SectionBlock
        title="Split Suggestions"
        width={contentWidth}
        note={analysis.suggestions.length > 0 ? `${analysis.suggestions.length} candidate(s)` : 'none'}
        tone={analysis.suggestions.length > 0 ? 'yellow' : 'green'}
      >
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
      </SectionBlock>

      {analysis.warnings.length > 0 ? (
        <SectionBlock title="Notes" width={contentWidth} tone="yellow" marginBottom={0}>
          {analysis.warnings.map((warning, index) => (
            <Text key={`warning-${index}`} color="yellow" wrap="wrap">
              - {warning}
            </Text>
          ))}
        </SectionBlock>
      ) : null}
    </Box>
  );
}
