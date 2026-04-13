import path from 'path';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

type ContextHealthLevel = 'healthy' | 'elevated' | 'critical' | 'unknown';
type ContextHealthConfidence = 'high' | 'medium' | 'low';

type ContextHealthSnapshot = {
  level: ContextHealthLevel;
  levelReason: string;
  confidence: ContextHealthConfidence;
  confidenceReason: string;
  source: 'native' | 'calculated';
  windowSource: 'explicit' | 'estimated';
  model: string;
  rawPercent: number;
  usageDerivedPercent: number;
  nativePercent: number | null;
  percentDrift: number | null;
  effectivePercent: number;
  smoothedEffectivePercent: number;
  trendDeltaPercent: number | null;
  dataPoints: number;
  comparableDataPoints: number;
  nativeSampleCount: number;
  calculatedSampleCount: number;
  explicitWindowSampleCount: number;
  estimatedWindowSampleCount: number;
  mixedModels: boolean;
  mixedContextWindows: boolean;
  usedTokens: number;
  contextWindowTokens: number;
  usableContextTokens: number;
  autocompactBufferTokens: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  timestampMs: number;
  timestampLabel: string;
  filePath: string;
};

type ContextHealthScreenProps = {
  scopeLabel: string;
  sourceLabel: string;
  selectedSource: 'claude' | 'codex' | 'cursor';
  snapshot: ContextHealthSnapshot;
};

type Tone = 'green' | 'yellow' | 'red' | 'gray' | 'cyan' | 'blue' | 'white';

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: Tone;
};

const USAGE_BAR_WIDTH = 24;

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
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

function levelColor(level: ContextHealthLevel): Tone {
  if (level === 'critical') return 'red';
  if (level === 'elevated') return 'yellow';
  if (level === 'healthy') return 'green';
  return 'gray';
}

function confidenceColor(confidence: ContextHealthConfidence): Tone {
  if (confidence === 'high') return 'green';
  if (confidence === 'medium') return 'yellow';
  return 'red';
}

function renderBar(percent: number, width = USAGE_BAR_WIDTH): { filled: string; empty: string } {
  const normalized = Math.max(0, Math.min(100, percent));
  const filled = normalized > 0 ? Math.max(1, Math.round((normalized / 100) * width)) : 0;
  return {
    filled: '\u2588'.repeat(filled),
    empty: '\u2591'.repeat(Math.max(0, width - filled)),
  };
}

function formatAgeHours(timestampMs: number): number | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }

  return Math.max(0, (Date.now() - timestampMs) / (1000 * 60 * 60));
}

function formatFreshness(snapshot: ContextHealthSnapshot): { label: string; tone: Tone } {
  const ageHours = formatAgeHours(snapshot.timestampMs);
  if (ageHours === null) {
    return { label: 'age unknown', tone: 'gray' };
  }

  if (ageHours >= 24) {
    return { label: `stale ${ageHours.toFixed(1)}h`, tone: 'yellow' };
  }

  return { label: `fresh ${ageHours.toFixed(1)}h`, tone: 'green' };
}

function trendTone(delta: number | null): Tone {
  if (delta === null) return 'gray';
  if (delta > 0) return 'yellow';
  if (delta < 0) return 'green';
  return 'gray';
}

function formatTrend(delta: number | null): string {
  if (delta === null) {
    return 'n/a';
  }

  if (delta > 0) {
    return `\u2191 +${delta.toFixed(1)}%`;
  }

  if (delta < 0) {
    return `\u2193 ${delta.toFixed(1)}%`;
  }

  return '\u2192 0.0%';
}

function buildEvidenceLine(snapshot: ContextHealthSnapshot): string {
  const parts: string[] = [
    snapshot.source === 'native' ? 'native context usage' : 'derived from usage tokens only',
    snapshot.windowSource === 'explicit'
      ? `window explicit (${formatNumber(snapshot.contextWindowTokens)})`
      : `window estimated (${formatNumber(snapshot.contextWindowTokens)})`,
    snapshot.comparableDataPoints === snapshot.dataPoints
      ? `${snapshot.dataPoints} samples`
      : `${snapshot.dataPoints} samples (${snapshot.comparableDataPoints} comparable)`,
  ];

  if (snapshot.mixedModels || snapshot.mixedContextWindows) {
    parts.push('mixed recent samples');
  }

  if (snapshot.percentDrift !== null) {
    parts.push(`drift ${snapshot.percentDrift.toFixed(1)} pts`);
  }

  return parts.join(' · ');
}

function buildMetricRows(snapshot: ContextHealthSnapshot): Array<{
  label: string;
  value: string;
  note: string;
  color: Tone;
}> {
  return [
    {
      label: 'Raw',
      value: formatPercent(snapshot.rawPercent),
      note: `${formatNumber(snapshot.usedTokens)} tok`,
      color: snapshot.source === 'native' ? 'blue' : 'cyan',
    },
    {
      label: 'Buffered',
      value: formatPercent(snapshot.effectivePercent),
      note: `+${Math.round((snapshot.autocompactBufferTokens / snapshot.contextWindowTokens) * 100)}% reserve`,
      color: levelColor(snapshot.level),
    },
    {
      label: 'Smoothed (3)',
      value: snapshot.comparableDataPoints >= 2 ? formatPercent(snapshot.smoothedEffectivePercent) : 'n/a',
      note: snapshot.comparableDataPoints >= 2 ? formatTrend(snapshot.trendDeltaPercent) : 'need 2 comparable',
      color: snapshot.comparableDataPoints >= 2 ? trendTone(snapshot.trendDeltaPercent) : 'gray',
    },
  ];
}

function MetricRowView({
  label,
  value,
  note,
  color,
}: {
  label: string;
  value: string;
  note: string;
  color: Tone;
}) {
  const percentValue = value === 'n/a' ? 0 : Number.parseFloat(value);
  const percentText = value === 'n/a' ? 'n/a' : value;
  const bar = renderBar(percentValue);

  return (
    <Box>
      <Box width={12}>
        <Text color="gray">{label}</Text>
      </Box>
      <Box width={USAGE_BAR_WIDTH}>
        <Text>
          <Text color={color}>{bar.filled}</Text>
          <Text color="gray">{bar.empty}</Text>
        </Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text color={value === 'n/a' ? 'gray' : 'white'}>{percentText}</Text>
      </Box>
      <Box marginLeft={1} flexGrow={1}>
        <Text color={color === 'gray' ? 'gray' : 'white'} wrap="truncate-end">
          {note}
        </Text>
      </Box>
    </Box>
  );
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

export function ContextHealthScreen({
  scopeLabel,
  sourceLabel,
  selectedSource,
  snapshot,
}: ContextHealthScreenProps) {
  const modelAccent = '#D6F54A';
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(68, terminalWidth - 2);
  const metricColumns = terminalWidth >= 120 ? 3 : terminalWidth >= 92 ? 2 : 1;
  const metricCellWidth = Math.max(20, Math.floor((contentWidth - (metricColumns - 1) * 2) / metricColumns));
  const statusTone = levelColor(snapshot.level);
  const confidenceTone = confidenceColor(snapshot.confidence);
  const freshness = formatFreshness(snapshot);
  const sessionId = truncateMiddle(path.basename(snapshot.filePath, path.extname(snapshot.filePath)), 12);
  const topCells: MetricCell[] = [
    {
      label: 'window',
      value: formatNumber(snapshot.contextWindowTokens),
      note: snapshot.windowSource,
      tone: 'white',
    },
    {
      label: 'used',
      value: formatNumber(snapshot.usedTokens),
      note: snapshot.source === 'native' ? 'native' : 'calculated',
      tone: 'white',
    },
    {
      label: 'buffer',
      value: formatNumber(snapshot.autocompactBufferTokens),
      note: `${Math.round((snapshot.autocompactBufferTokens / snapshot.contextWindowTokens) * 100)}% held back`,
      tone: 'white',
    },
  ];
  const middleCells: MetricCell[] = [
    {
      label: 'source',
      value: snapshot.source,
      note: snapshot.nativeSampleCount > 0 ? 'native+usage' : 'usage-only',
      tone: 'white',
    },
    {
      label: 'input',
      value: formatNumber(snapshot.inputTokens),
      note: 'request',
      tone: 'white',
    },
    {
      label: 'usable',
      value: formatNumber(snapshot.usableContextTokens),
      note: 'after reserve',
      tone: 'white',
    },
  ];
  const lowerCells: MetricCell[] = [
    {
      label: 'cache_create',
      value: formatNumber(snapshot.cacheCreationTokens),
      note: snapshot.cacheCreationTokens > 0 ? 'written' : '-',
      tone: 'white',
    },
    {
      label: 'cache_read',
      value: formatNumber(snapshot.cacheReadTokens),
      note: snapshot.cacheReadTokens > 0 ? 'reused' : '-',
      tone: 'white',
    },
    {
      label: 'samples',
      value: `${snapshot.dataPoints} / ${snapshot.comparableDataPoints}`,
      note: 'comparable',
      tone: snapshot.comparableDataPoints >= 2 ? 'white' : 'gray',
    },
  ];
  const usageRows = buildMetricRows(snapshot);
  const notes: string[] = [];

  if (freshness.tone === 'yellow') {
    notes.push(`latest sample is stale (${freshness.label.replace(/^stale\s*/, '')} old)`);
  }
  if (snapshot.dataPoints > 1 && snapshot.comparableDataPoints < 2) {
    notes.push('recent samples are not comparable for a reliable trend');
  }
  if (snapshot.percentDrift !== null && snapshot.percentDrift >= 15) {
    notes.push('native and usage-token estimates diverge materially');
  }

  const tokenGroups = [topCells, middleCells, lowerCells];
  const notesLine = notes.join(' · ');
  const sourceLine = `scope ${scopeLabel} | source ${truncateMiddle(sourceLabel, 42)}`;
  const commandLine = `/context_health ${selectedSource}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="white">{commandLine}</Text>
        <Text color="gray">odradek - context health</Text>
      </Box>
      <Text color="gray">{sourceLine}</Text>

      <SectionBlock title="Summary" width={contentWidth} note={sessionId} tone={statusTone}>
        <Text wrap="wrap">
          <Text color={statusTone}>● {snapshot.level.toUpperCase()}</Text>
          <Text color="white"> {snapshot.levelReason}</Text>
          <Text color="gray"> [</Text>
          <Text color={confidenceTone}>{snapshot.confidence.toUpperCase()}</Text>
          <Text color="gray">]</Text>
        </Text>
        <Text color={modelAccent} wrap="wrap">
          {truncateMiddle(snapshot.model || 'unknown', Math.max(32, contentWidth - 2))}
        </Text>
        <Text color="gray" wrap="wrap">
          {buildEvidenceLine(snapshot)}
        </Text>
        {notesLine ? (
          <Text color="yellow" wrap="wrap">
            ! {notesLine}
          </Text>
        ) : null}
      </SectionBlock>

      <SectionBlock title="Usage" width={contentWidth}>
        {usageRows.map((row) => (
          <MetricRowView key={row.label} label={row.label} value={row.value} note={row.note} color={row.color} />
        ))}
      </SectionBlock>

      <SectionBlock title="Tokens" width={contentWidth}>
        {tokenGroups.map((cells, groupIndex) => (
          <Box key={`token-group-${groupIndex}`} flexDirection="column" marginBottom={groupIndex < tokenGroups.length - 1 ? 1 : 0}>
            {chunk(cells, metricColumns).map((row, rowIndex) => (
              <Box key={`token-row-${groupIndex}-${rowIndex}`}>
                {row.map((cell, index) => (
                  <Box key={`${groupIndex}-${cell.label}`} marginRight={index < row.length - 1 ? 2 : 0}>
                    <CompactMetricCellView cell={cell} width={metricCellWidth} />
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        ))}
      </SectionBlock>

      <SectionBlock title="Snapshot" width={contentWidth} note={snapshot.timestampLabel} tone={freshness.tone} marginBottom={0}>
        <Box>
          <Box flexGrow={1} marginRight={1}>
            <Text color="gray" wrap="truncate-end">
              {snapshot.confidenceReason}
            </Text>
          </Box>
          <Text color={freshness.tone}>{freshness.label}</Text>
        </Box>
      </SectionBlock>
    </Box>
  );
}
