import path from 'path';
import { Box, Text } from 'ink';

type MetricCell = {
  label: string;
  value: string;
  note: string;
  tone?: string;
};

type DetailRow = {
  label: string;
  value: string;
  note?: string;
  tone?: string;
};

type StateScreenProps = {
  scopeLabel: string;
  workspacePath: string;
  configPath: string;
  trusted: boolean;
  runtimeStatus: 'ready' | 'needs setup';
  providerDisplayName: string;
  providerSourceLabel: string;
  runtimeSourceLabel: string;
  projectContextEnabled: boolean;
  projectContextSourceLabel: string;
  apiKeyConfigured: boolean;
  apiKeySourceLabel: string;
  modelValue: string;
  modelSourceLabel: string;
  endpointValue: string;
  endpointSourceLabel: string;
  envFilesLabel: string;
  envFilesLoaded: boolean;
  sessionOverrides: string[];
};

const ACCENT_COLOR = '#D6F54A';

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

function CompactMetricCellView({ cell, width }: { cell: MetricCell; width: number }) {
  return (
    <Box width={width}>
      <Text color="gray">{cell.label} </Text>
      <Text color={cell.tone ?? 'white'}>{cell.value}</Text>
      <Text color="gray"> {cell.note}</Text>
    </Box>
  );
}

function DetailRowView({ row, labelWidth, valueWidth }: { row: DetailRow; labelWidth: number; valueWidth: number }) {
  return (
    <Box>
      <Box width={labelWidth}>
        <Text color="gray">{row.label}</Text>
      </Box>
      <Box width={valueWidth}>
        <Text color={row.tone ?? 'white'} wrap="truncate-end">
          {row.value}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="gray" wrap="truncate-end">
          {row.note ?? ''}
        </Text>
      </Box>
    </Box>
  );
}

export function StateScreen(props: StateScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 4);
  const rule = '-'.repeat(contentWidth);
  const workspaceLabel = path.basename(props.workspacePath) || props.workspacePath;
  const summaryCells: MetricCell[] = [
    {
      label: 'status',
      value: props.runtimeStatus,
      note: props.runtimeStatus === 'ready' ? 'runtime ok' : 'needs setup',
      tone: props.runtimeStatus === 'ready' ? 'green' : 'yellow',
    },
    {
      label: 'provider',
      value: props.providerDisplayName,
      note: props.providerSourceLabel,
      tone: ACCENT_COLOR,
    },
    {
      label: 'trust',
      value: props.trusted ? 'trusted' : 'not trusted',
      note: props.trusted ? 'workspace allowed' : 'run /trustpath',
      tone: props.trusted ? 'green' : 'yellow',
    },
    {
      label: 'project ctx',
      value: props.projectContextEnabled ? 'enabled' : 'disabled',
      note: props.projectContextSourceLabel,
      tone: props.projectContextEnabled ? 'green' : 'yellow',
    },
    {
      label: 'env',
      value: props.envFilesLoaded ? 'loaded' : 'none',
      note: props.envFilesLoaded ? 'env files present' : 'no env files',
      tone: props.envFilesLoaded ? ACCENT_COLOR : 'gray',
    },
  ];

  const configRows: DetailRow[] = [
    {
      label: 'api key',
      value: props.apiKeyConfigured ? 'configured' : 'missing',
      note: props.apiKeySourceLabel,
      tone: props.apiKeyConfigured ? 'green' : 'yellow',
    },
    {
      label: 'model',
      value: props.modelValue,
      note: props.modelSourceLabel,
      tone: props.modelValue === 'Not set' ? 'yellow' : 'white',
    },
    {
      label: 'endpoint',
      value: truncateMiddle(props.endpointValue, 44),
      note: props.endpointSourceLabel,
      tone: 'white',
    },
    {
      label: 'config',
      value: truncateMiddle(props.configPath, 44),
      note: 'active config file',
      tone: 'white',
    },
  ];

  const sourceRows: DetailRow[] = [
    {
      label: 'workspace',
      value: truncateMiddle(props.workspacePath, 44),
      note: workspaceLabel,
      tone: 'white',
    },
    {
      label: 'runtime src',
      value: props.runtimeSourceLabel,
      note: 'provider/api/model endpoint',
      tone: ACCENT_COLOR,
    },
    {
      label: 'env files',
      value: truncateMiddle(props.envFilesLabel, 56),
      note: props.envFilesLoaded ? 'loaded' : 'none loaded',
      tone: props.envFilesLoaded ? 'white' : 'gray',
    },
  ];

  if (props.sessionOverrides.length > 0) {
    sourceRows.push({
      label: 'session',
      value: props.sessionOverrides.join(', '),
      note: 'temporary overrides',
      tone: 'green',
    });
  }

  const columns = terminalWidth >= 120 ? 5 : terminalWidth >= 94 ? 3 : 2;
  const cellWidth = Math.max(18, Math.floor((contentWidth - (columns - 1) * 2) / columns));
  const labelWidth = 12;
  const valueWidth = Math.max(24, Math.min(46, Math.floor(contentWidth * 0.35)));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="white">/state  {formatScope(props.scopeLabel)}</Text>
      </Box>
      <Text color="gray">{truncateMiddle(props.workspacePath, Math.max(28, contentWidth))}</Text>
      <Text color="gray">{rule}</Text>

      {chunk(summaryCells, columns).map((row, rowIndex) => (
        <Box key={`summary-${rowIndex}`}>
          {row.map((cell, index) => (
            <Box key={cell.label} marginRight={index < row.length - 1 ? 2 : 0}>
              <CompactMetricCellView cell={cell} width={cellWidth} />
            </Box>
          ))}
        </Box>
      ))}

      {!props.trusted ? <Text color="yellow">! workspace is not trusted yet, so project features may stay limited</Text> : null}
      {props.runtimeStatus !== 'ready' ? <Text color="yellow">! runtime still needs setup before normal chat requests can succeed</Text> : null}

      <Text color="gray">{rule}</Text>
      <Text color="gray">CONFIG</Text>
      {configRows.map((row) => (
        <DetailRowView key={row.label} row={row} labelWidth={labelWidth} valueWidth={valueWidth} />
      ))}

      <Text color="gray">{rule}</Text>
      <Text color="gray">SOURCES</Text>
      {sourceRows.map((row) => (
        <DetailRowView key={row.label} row={row} labelWidth={labelWidth} valueWidth={valueWidth} />
      ))}
    </Box>
  );
}
