import path from 'path';
import { Box, Text } from 'ink';

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
  snapshot: ContextHealthSnapshot;
};

type Tone = 'green' | 'yellow' | 'red' | 'gray' | 'cyan' | 'blue' | 'white';

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: Tone;
};

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

function renderBar(percent: number, color: Tone, width = 24): string {
  const normalized = Math.max(0, Math.min(100, percent));
  const filled = normalized > 0 ? Math.max(1, Math.round((normalized / 100) * width)) : 0;
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(Math.max(0, width - filled))}`;
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

function formatScope(scopeLabel: string): string {
  return scopeLabel.trim().replace(/\s+/g, '_').toLowerCase();
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

  return parts.join(' \u00b7 ');
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

  return (
    <Box>
      <Box width={12}>
        <Text color="gray">{label}</Text>
      </Box>
      <Box width={20}>
        <Text color={color}>{renderBar(percentValue, color)}</Text>
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

export function ContextHealthScreen({ scopeLabel, sourceLabel, snapshot }: ContextHealthScreenProps) {
  const modelAccent = '#D6F54A';
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(68, terminalWidth - 4);
  const rule = '\u2500'.repeat(contentWidth);
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

  const headerLeft = `/context_health  ${formatScope(scopeLabel)}`;
  const sourceLine = truncateMiddle(sourceLabel, Math.max(24, contentWidth));
  const notesLine = notes.join(' \u00b7 ');
  const cellWidth = Math.max(18, Math.floor((contentWidth - 4) / 3));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="white">{headerLeft}</Text>
      </Box>
      <Text color="gray">{sourceLine}</Text>
      <Text color="gray">{rule}</Text>

      <Box>
        <Text color={statusTone}>{'\u25cf'} </Text>
        <Text color={statusTone}>{snapshot.level.toUpperCase()}</Text>
        <Text color="white">  {snapshot.levelReason}</Text>
        <Text color="gray">   [</Text>
        <Text color={confidenceTone}>{snapshot.confidence.toUpperCase()}</Text>
        <Text color="gray">]</Text>
      </Box>
      <Text color={modelAccent}>{truncateMiddle(snapshot.model || 'unknown', 32)}</Text>

      <Text color="gray">{buildEvidenceLine(snapshot)}</Text>
      {notesLine ? <Text color="yellow">! {notesLine}</Text> : null}
      <Text color="gray">{rule}</Text>

      <Text color="gray">USAGE</Text>
      {usageRows.map((row) => (
        <MetricRowView key={row.label} label={row.label} value={row.value} note={row.note} color={row.color} />
      ))}

      <Text color="gray">{rule}</Text>
      <Text color="gray">TOKENS</Text>
      <Box>
        {topCells.map((cell, index) => (
          <Box key={cell.label} marginRight={index < topCells.length - 1 ? 2 : 0}>
            <CompactMetricCellView cell={cell} width={cellWidth} />
          </Box>
        ))}
      </Box>

      <Box>
        <Box width={cellWidth} marginRight={2}>
          <Text color="gray">source </Text>
          <Text color="white">{snapshot.source}</Text>
          <Text color="gray"> {snapshot.nativeSampleCount > 0 ? 'mixed' : 'usage-only'}</Text>
        </Box>
        <Box width={cellWidth} marginRight={2}>
          <Text color="gray">input </Text>
          <Text color="white">{formatNumber(snapshot.inputTokens)}</Text>
          <Text color="gray"> request</Text>
        </Box>
        <Box width={cellWidth}>
          <Text color="gray">usable </Text>
          <Text color="white">{formatNumber(snapshot.usableContextTokens)}</Text>
          <Text color="gray"> after reserve</Text>
        </Box>
      </Box>

      <Box>
        {lowerCells.map((cell, index) => (
          <Box key={cell.label} marginRight={index < lowerCells.length - 1 ? 2 : 0}>
            <CompactMetricCellView cell={cell} width={cellWidth} />
          </Box>
        ))}
      </Box>

      <Text color="gray">{rule}</Text>
      <Box justifyContent="space-between">
        <Text color="gray">
          {sessionId}  {snapshot.timestampLabel}
        </Text>
        <Text color={freshness.tone}>{freshness.label}</Text>
      </Box>
    </Box>
  );
}
