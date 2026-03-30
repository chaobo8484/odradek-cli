import path from 'path';
import { Box, Text } from 'ink';

type TokenFieldAggregate = {
  name: string;
  total: number;
  count: number;
};

type TokenGroupAggregate = {
  name: string;
  totalTokens: number;
  records: number;
};

type TokenDayAggregate = {
  day: string;
  totalTokens: number;
  records: number;
};

type TokenFileAggregate = {
  filePath: string;
  projectDir: string;
  totalLines: number;
  parsedLines: number;
  invalidLines: number;
  recordsWithTokens: number;
  totalTokens: number;
  latestTimestampMs: number;
};

type TokenStructureSummary = {
  files: TokenFileAggregate[];
  totalFiles: number;
  totalLines: number;
  parsedLines: number;
  invalidLines: number;
  recordsWithTokens: number;
  totalTokens: number;
  tokenFields: TokenFieldAggregate[];
  roleBreakdown: TokenGroupAggregate[];
  typeBreakdown: TokenGroupAggregate[];
  dayBreakdown: TokenDayAggregate[];
};

type TokenStructureScreenProps = {
  scopeLabel: string;
  sourceLabel: string;
  projectDirCount: number;
  summary: TokenStructureSummary;
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

function renderBar(ratio: number, width: number): string {
  const normalized = Math.max(0, Math.min(1, ratio));
  const filled = normalized > 0 ? Math.max(1, Math.round(normalized * width)) : 0;
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(Math.max(0, width - filled))}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
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

function SummaryHero({ summary, recentLabel }: { summary: TokenStructureSummary; recentLabel: string }) {
  const invalidRate = summary.parsedLines + summary.invalidLines > 0 ? summary.invalidLines / (summary.parsedLines + summary.invalidLines) : 0;
  const borderColor = invalidRate >= 0.1 ? 'yellow' : 'gray';

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
        <Text color="gray">{formatNumber(summary.totalFiles)} JSONL files</Text>
      </Box>
      <Box>
        <Text color="white">{formatNumber(summary.totalTokens)}</Text>
        <Text color="gray"> total token values</Text>
      </Box>
      <Box>
        <Text color={summary.recordsWithTokens > 0 ? ACCENT_COLOR : 'gray'}>{formatNumber(summary.recordsWithTokens)}</Text>
        <Text color="gray"> records with token fields</Text>
      </Box>
      <Box>
        <Text color={invalidRate >= 0.1 ? 'yellow' : 'gray'}>{formatPercent(invalidRate)}</Text>
        <Text color="gray"> invalid line rate  |  recent {truncateMiddle(recentLabel, 32)}</Text>
      </Box>
    </Box>
  );
}

function FieldRowView({
  field,
  maxTotal,
  barWidth,
}: {
  field: TokenFieldAggregate;
  maxTotal: number;
  barWidth: number;
}) {
  const ratio = maxTotal > 0 ? field.total / maxTotal : 0;
  return (
    <Box>
      <Box width={22}>
        <Text color="gray" wrap="truncate-end">
          {truncateMiddle(field.name, 22)}
        </Text>
      </Box>
      <Box width={barWidth}>
        <Text color="blue">{renderBar(ratio, barWidth)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color="white">{formatNumber(field.total)}</Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text color="gray">{formatPercent(ratio)}</Text>
      </Box>
      <Box flexGrow={1} marginLeft={1}>
        <Text color="gray">{formatNumber(field.count)} hits</Text>
      </Box>
    </Box>
  );
}

function BreakdownRowView({
  group,
  maxTotal,
  titleWidth,
  barWidth,
  tone,
}: {
  group: TokenGroupAggregate;
  maxTotal: number;
  titleWidth: number;
  barWidth: number;
  tone: string;
}) {
  const ratio = maxTotal > 0 ? group.totalTokens / maxTotal : 0;
  return (
    <Box>
      <Box width={titleWidth}>
        <Text color="gray" wrap="truncate-end">
          {truncateMiddle(group.name, titleWidth)}
        </Text>
      </Box>
      <Box width={barWidth}>
        <Text color={tone}>{renderBar(ratio, barWidth)}</Text>
      </Box>
      <Box width={9} justifyContent="flex-end">
        <Text color="white">{formatNumber(group.totalTokens)}</Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text color="gray">{formatPercent(ratio)}</Text>
      </Box>
      <Box width={8} marginLeft={1}>
        <Text color="gray">{formatNumber(group.records)} rec</Text>
      </Box>
    </Box>
  );
}

function BreakdownCard({
  title,
  groups,
  maxTotal,
  tone,
  width,
}: {
  title: string;
  groups: TokenGroupAggregate[];
  maxTotal: number;
  tone: string;
  width: number;
}) {
  const titleWidth = Math.max(14, Math.floor(width * 0.28));
  const barWidth = Math.max(10, Math.min(18, width - titleWidth - 26));

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Text color="gray">{title}</Text>
      {groups.length > 0 ? <Text color="gray">group  bar  tokens  share  rec</Text> : null}
      {groups.length === 0 ? (
        <Text color="gray">(none)</Text>
      ) : (
        groups.slice(0, 6).map((group) => (
          <BreakdownRowView
            key={`${title}-${group.name}`}
            group={group}
            maxTotal={maxTotal}
            titleWidth={titleWidth}
            barWidth={barWidth}
            tone={tone}
          />
        ))
      )}
    </Box>
  );
}

function FileRowView({
  file,
  width,
  maxTotal,
  barWidth,
}: {
  file: TokenFileAggregate;
  width: number;
  maxTotal: number;
  barWidth: number;
}) {
  const relativePath = path.relative(process.cwd(), file.filePath);
  const displayPath =
    relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) ? relativePath : file.filePath;
  const ratio = maxTotal > 0 ? file.totalTokens / maxTotal : 0;

  return (
    <Box>
      <Box width={Math.max(28, width - barWidth - 32)}>
        <Text color="cyan" wrap="truncate-end">
          {truncateMiddle(displayPath, Math.max(28, width - barWidth - 32))}
        </Text>
      </Box>
      <Box width={barWidth}>
        <Text color="cyan">{renderBar(ratio, barWidth)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color="white">{formatNumber(file.totalTokens)}</Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text color="gray">{formatPercent(ratio)}</Text>
      </Box>
      <Box flexGrow={1} marginLeft={1}>
        <Text color="gray">
          {formatNumber(file.parsedLines)} / {formatNumber(file.invalidLines)} lines
        </Text>
      </Box>
    </Box>
  );
}

function DayRowView({ day, maxTotal, barWidth }: { day: TokenDayAggregate; maxTotal: number; barWidth: number }) {
  const ratio = maxTotal > 0 ? day.totalTokens / maxTotal : 0;
  return (
    <Box>
      <Box width={12}>
        <Text color="gray">{day.day}</Text>
      </Box>
      <Box width={barWidth}>
        <Text color="yellow">{renderBar(ratio, barWidth)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color="white">{formatNumber(day.totalTokens)}</Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text color="gray">{formatPercent(ratio)}</Text>
      </Box>
      <Box flexGrow={1} marginLeft={1}>
        <Text color="gray">{formatNumber(day.records)} rec</Text>
      </Box>
    </Box>
  );
}

export function TokenStructureScreen({ scopeLabel, sourceLabel, projectDirCount, summary }: TokenStructureScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 4);
  const rule = '-'.repeat(contentWidth);
  const mostRecentMs = summary.files.reduce((max, file) => Math.max(max, file.latestTimestampMs), 0);
  const summaryCells: MetricCell[] = [
    {
      label: 'dirs',
      value: formatNumber(projectDirCount),
      note: 'project dirs',
      tone: ACCENT_COLOR,
    },
    {
      label: 'files',
      value: formatNumber(summary.totalFiles),
      note: 'jsonl',
      tone: 'white',
    },
    {
      label: 'records',
      value: formatNumber(summary.parsedLines),
      note: `${formatNumber(summary.invalidLines)} invalid`,
      tone: 'white',
    },
    {
      label: 'token rec',
      value: formatNumber(summary.recordsWithTokens),
      note: 'with fields',
      tone: summary.recordsWithTokens > 0 ? 'green' : 'gray',
    },
    {
      label: 'fields',
      value: formatNumber(summary.tokenFields.length),
      note: 'token keys',
      tone: 'white',
    },
  ];

  const summaryColumns = terminalWidth >= 120 ? 5 : terminalWidth >= 92 ? 3 : 2;
  const summaryCellWidth = Math.max(18, Math.floor((contentWidth - (summaryColumns - 1) * 2) / summaryColumns));
  const maxFieldTotal = summary.tokenFields.reduce((max, field) => Math.max(max, field.total), 0);
  const maxRoleTotal = summary.roleBreakdown.reduce((max, group) => Math.max(max, group.totalTokens), 0);
  const maxTypeTotal = summary.typeBreakdown.reduce((max, group) => Math.max(max, group.totalTokens), 0);
  const maxFileTotal = summary.files.reduce((max, file) => Math.max(max, file.totalTokens), 0);
  const maxDayTotal = summary.dayBreakdown.reduce((max, day) => Math.max(max, day.totalTokens), 0);
  const sourceLine = `scope ${scopeLabel} | source ${truncateMiddle(sourceLabel, 42)}`;
  const recentLabel = mostRecentMs > 0 ? new Date(mostRecentMs).toLocaleString() : 'none';
  const wideBarWidth = terminalWidth >= 120 ? 24 : terminalWidth >= 92 ? 20 : 16;
  const compactBarWidth = terminalWidth >= 120 ? 18 : 16;
  const breakdownColumns = terminalWidth >= 138 ? 2 : 1;
  const breakdownCardWidth = Math.max(34, Math.floor((contentWidth - (breakdownColumns - 1) * 2) / breakdownColumns));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="white">/scan_tokens</Text>
        <Text color="gray">odradek - token scan</Text>
      </Box>
      <Text color="gray">{sourceLine}</Text>
      <SummaryHero summary={summary} recentLabel={recentLabel} />
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
      <Text color="gray">TOKEN FIELDS</Text>
      {summary.tokenFields.length > 0 ? (
        <Text color="gray">field                  share bar                 tokens   share  hits</Text>
      ) : null}
      {summary.tokenFields.length === 0 ? (
        <Text color="gray">(no token fields found)</Text>
      ) : (
        summary.tokenFields.slice(0, 8).map((field) => (
          <FieldRowView key={field.name} field={field} maxTotal={maxFieldTotal} barWidth={wideBarWidth} />
        ))
      )}

      <Text color="gray">{rule}</Text>
      <Text color="gray">BREAKDOWN</Text>
      {breakdownColumns === 2 ? (
        <Box>
          <Box marginRight={2}>
            <BreakdownCard title="ROLES" groups={summary.roleBreakdown} maxTotal={maxRoleTotal} tone="cyan" width={breakdownCardWidth} />
          </Box>
          <BreakdownCard
            title="EVENT TYPES"
            groups={summary.typeBreakdown}
            maxTotal={maxTypeTotal}
            tone="green"
            width={breakdownCardWidth}
          />
        </Box>
      ) : (
        <>
          <BreakdownCard title="ROLES" groups={summary.roleBreakdown} maxTotal={maxRoleTotal} tone="cyan" width={breakdownCardWidth} />
          <BreakdownCard
            title="EVENT TYPES"
            groups={summary.typeBreakdown}
            maxTotal={maxTypeTotal}
            tone="green"
            width={breakdownCardWidth}
          />
        </>
      )}

      <Text color="gray">{rule}</Text>
      <Text color="gray">TOP FILES</Text>
      {summary.files.length > 0 ? <Text color="gray">file                                   token bar                tokens  share  parsed/invalid</Text> : null}
      {summary.files.length === 0 ? (
        <Text color="gray">(none)</Text>
      ) : (
        summary.files
          .slice(0, 6)
          .map((file) => <FileRowView key={file.filePath} file={file} width={contentWidth} maxTotal={maxFileTotal} barWidth={compactBarWidth} />)
      )}

      <Text color="gray">{rule}</Text>
      <Text color="gray">DAILY TREND</Text>
      {summary.dayBreakdown.length > 0 ? <Text color="gray">day          token bar                tokens  share  records</Text> : null}
      {summary.dayBreakdown.length === 0 ? (
        <Text color="gray">(no timestamp data)</Text>
      ) : (
        summary.dayBreakdown.slice(-7).map((day) => <DayRowView key={day.day} day={day} maxTotal={maxDayTotal} barWidth={wideBarWidth} />)
      )}
    </Box>
  );
}
