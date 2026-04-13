import { Box, Text } from 'ink';

type TokenUsageWindowSummary = {
  label: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  records: number;
  activeDays: number;
};

type TokenUsageModelDayValue = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

type TokenUsageDayAggregate = {
  day: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  records: number;
  models: TokenUsageModelDayValue[];
};

type TokenUsageModelAggregate = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  records: number;
  activeDays: number;
};

type TokenUsageSummary = {
  totalFiles: number;
  totalRecords: number;
  totalDays: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  latestTimestampMs: number;
  models: TokenUsageModelAggregate[];
  days: TokenUsageDayAggregate[];
  chartDays: TokenUsageDayAggregate[];
  windows: TokenUsageWindowSummary[];
};

type TokenUsageScreenProps = {
  scopeLabel: string;
  sourceLabel: string;
  projectDirCount: number;
  summary: TokenUsageSummary;
};

type ChartCell = {
  char: string;
  color?: string;
};

type ChartSegment = {
  text: string;
  color?: string;
};

type ModelSeries = {
  raw: string;
  label: string;
  color: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
};

const ACCENT = '#D7F54A';
const MODEL_COLORS = ['#A5B4FC', '#4ADE80', '#FACC15', '#38BDF8', '#F472B6'];
const CHART_HEIGHT = 9;

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

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}m`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)}k`;
  }
  return `${Math.round(value)}`;
}

function normalizeModelLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return 'Unknown';
  }
  if (normalized.includes('sonnet') && normalized.includes('4.6')) {
    return 'Sonnet 4.6';
  }
  if (normalized.includes('sonnet') && normalized.includes('4.5')) {
    return 'Sonnet 4.5';
  }
  if (normalized.includes('haiku') && normalized.includes('4.5')) {
    return 'Haiku 4.5';
  }
  if (normalized.includes('haiku')) {
    return 'Haiku';
  }
  if (normalized.includes('sonnet')) {
    return 'Sonnet';
  }
  return truncateMiddle(raw, 18);
}

function modelTokensForDay(day: TokenUsageDayAggregate, model: string): number {
  return day.models.find((entry) => entry.model === model)?.totalTokens ?? 0;
}

function buildModelSeries(summary: TokenUsageSummary): ModelSeries[] {
  return summary.models.slice(0, 3).map((model, index) => ({
    raw: model.model,
    label: normalizeModelLabel(model.model),
    color: MODEL_COLORS[index % MODEL_COLORS.length],
    totalTokens: model.totalTokens,
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
  }));
}

function createCanvas(height: number, width: number): ChartCell[][] {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      char: ' ',
      color: undefined,
    }))
  );
}

function mergeChar(existing: string, next: string): string {
  if (existing === ' ') {
    return next;
  }
  if (existing === next) {
    return existing;
  }
  if ((existing === '─' && next === '│') || (existing === '│' && next === '─')) {
    return '┼';
  }
  if (existing === '•' || next === '•') {
    return '•';
  }
  return '┼';
}

function writeCell(canvas: ChartCell[][], x: number, y: number, char: string, color: string): void {
  if (y < 0 || y >= canvas.length || x < 0 || x >= canvas[0].length) {
    return;
  }
  const current = canvas[y][x];
  const nextChar = mergeChar(current.char, char);
  const nextColor = current.char !== ' ' && current.color !== color ? 'white' : color;
  canvas[y][x] = { char: nextChar, color: nextColor };
}

function valueToRow(value: number, maxValue: number): number {
  if (maxValue <= 0 || value <= 0) {
    return CHART_HEIGHT - 1;
  }
  const ratio = Math.max(0, Math.min(1, value / maxValue));
  return CHART_HEIGHT - 1 - Math.round(ratio * (CHART_HEIGHT - 1));
}

function buildChart(summary: TokenUsageSummary, models: ModelSeries[], chartWidth: number): ChartSegment[][] {
  const days = summary.chartDays.length > 0 ? summary.chartDays : summary.days.slice(-30);
  const canvas = createCanvas(CHART_HEIGHT, chartWidth);
  const maxValue = Math.max(1, ...days.map((day) => day.totalTokens));

  models.forEach((model) => {
    let prevX = -1;
    let prevY = CHART_HEIGHT - 1;
    days.forEach((day, index) => {
      const x =
        days.length <= 1 ? 0 : Math.round((index / Math.max(1, days.length - 1)) * Math.max(0, chartWidth - 1));
      const y = valueToRow(modelTokensForDay(day, model.raw), maxValue);

      if (prevX >= 0) {
        const startX = Math.min(prevX, x);
        const endX = Math.max(prevX, x);
        for (let cursor = startX; cursor <= endX; cursor += 1) {
          writeCell(canvas, cursor, prevY, '─', model.color);
        }

        if (prevY !== y) {
          const startY = Math.min(prevY, y);
          const endY = Math.max(prevY, y);
          for (let cursor = startY; cursor <= endY; cursor += 1) {
            writeCell(canvas, x, cursor, '│', model.color);
          }
        }
      }

      writeCell(canvas, x, y, '•', model.color);
      prevX = x;
      prevY = y;
    });
  });

  return canvas.map((row) => {
    const segments: ChartSegment[] = [];
    row.forEach((cell) => {
      const last = segments[segments.length - 1];
      if (last && last.color === cell.color) {
        last.text += cell.char;
        return;
      }
      segments.push({ text: cell.char, color: cell.color });
    });
    return segments;
  });
}

function buildYAxisLabels(summary: TokenUsageSummary): string[] {
  const maxValue = Math.max(1, ...summary.chartDays.map((day) => day.totalTokens));
  return Array.from({ length: CHART_HEIGHT }, (_, rowIndex) => {
    const ratio = (CHART_HEIGHT - 1 - rowIndex) / Math.max(1, CHART_HEIGHT - 1);
    return formatCompactNumber(maxValue * ratio).padStart(6, ' ');
  });
}

function formatDayTick(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dayKey.slice(5);
  }
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  return `${month} ${day}`;
}

function buildXAxisLabels(days: TokenUsageDayAggregate[], chartWidth: number): string {
  const result = Array.from({ length: chartWidth }, () => ' ');
  const indices = [0, Math.floor((days.length - 1) / 3), Math.floor(((days.length - 1) * 2) / 3), Math.max(0, days.length - 1)];
  const used = new Set<number>();

  indices.forEach((index) => {
    if (days.length === 0) {
      return;
    }
    const safeIndex = Math.max(0, Math.min(days.length - 1, index));
    if (used.has(safeIndex)) {
      return;
    }
    used.add(safeIndex);
    const x =
      days.length <= 1 ? 0 : Math.round((safeIndex / Math.max(1, days.length - 1)) * Math.max(0, chartWidth - 1));
    const tick = formatDayTick(days[safeIndex].day);
    for (let cursor = 0; cursor < tick.length && x + cursor < result.length; cursor += 1) {
      result[x + cursor] = tick[cursor];
    }
  });

  return result.join('');
}

function ChartView({
  summary,
  models,
  chartWidth,
}: {
  summary: TokenUsageSummary;
  models: ModelSeries[];
  chartWidth: number;
}) {
  const days = summary.chartDays.length > 0 ? summary.chartDays : summary.days.slice(-30);
  const yLabels = buildYAxisLabels(summary);
  const rows = buildChart(summary, models, chartWidth);
  const xLine = buildXAxisLabels(days, chartWidth);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="white">Tokens per Day</Text>
      {rows.map((row, rowIndex) => (
        <Box key={`row-${rowIndex}`}>
          <Text color="gray">{yLabels[rowIndex]} </Text>
          <Text color="gray">│</Text>
          {row.map((segment, segmentIndex) => (
            <Text key={`seg-${rowIndex}-${segmentIndex}`} color={segment.color ?? 'gray'}>
              {segment.text}
            </Text>
          ))}
        </Box>
      ))}
      <Box>
        <Text color="gray">{' '.repeat(7)}└{'─'.repeat(chartWidth)}</Text>
      </Box>
      <Box>
        <Text color="gray">{' '.repeat(8)}{xLine}</Text>
      </Box>
    </Box>
  );
}

function Legend({
  models,
}: {
  models: ModelSeries[];
}) {
  if (models.length === 0) {
    return <Text color="gray">(no model usage)</Text>;
  }

  return (
    <Box marginBottom={1}>
      {models.map((model, index) => (
        <Box key={model.raw} marginRight={index < models.length - 1 ? 2 : 0}>
          <Text color={model.color}>● </Text>
          <Text color="gray">{model.label}</Text>
          {index < models.length - 1 ? <Text color="gray"> · </Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function ModelStats({
  models,
  totalTokens,
}: {
  models: ModelSeries[];
  totalTokens: number;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {models.map((model) => {
        const share = totalTokens > 0 ? ((model.totalTokens / totalTokens) * 100).toFixed(1) : '0.0';
        return (
          <Box key={`stats-${model.raw}`} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="white">• </Text>
              <Text color={model.color}>{model.label}</Text>
              <Text color="gray"> ({share}%)</Text>
            </Box>
            <Text color="gray">
              In: {formatCompactNumber(model.inputTokens)} · Out: {formatCompactNumber(model.outputTokens)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function TokenUsageScreen({ scopeLabel, sourceLabel, summary }: TokenUsageScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 2);
  const chartWidth = Math.max(36, Math.min(66, contentWidth - 10));
  const models = buildModelSeries(summary);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="gray">Overview</Text>
        <Text color="black" backgroundColor={ACCENT}>
          {' '}Models{' '}
        </Text>
      </Box>

      <ChartView summary={summary} models={models} chartWidth={chartWidth} />
      <Legend models={models} />

      <Box marginBottom={1}>
        <Text color={ACCENT}>All time</Text>
        <Text color="gray"> · Last 7 days · Last 30 days</Text>
      </Box>

      <ModelStats models={models} totalTokens={summary.totalTokens} />

      <Text color="gray">
        Scope: {scopeLabel} · Source: {truncateMiddle(sourceLabel, 40)}
      </Text>
    </Box>
  );
}
