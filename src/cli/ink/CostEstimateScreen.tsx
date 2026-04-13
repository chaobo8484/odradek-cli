import { Box, Newline, Text } from 'ink';

export type CostEstimateScreenSegment = {
  label: string;
  tokenCount: number;
  cacheEligible: boolean;
};

export type CostEstimateScreenScenario = {
  label: string;
  inputCostUsd: number;
  outputExampleCostUsd: number;
  totalWithOutputExampleUsd: number;
  savingsVsColdUsd: number;
  note: string;
};

export type CostEstimateScreenRate = {
  label: string;
  perMillionUsd: number | null;
};

export type CostEstimateScreenVariant = {
  label: string;
  resolvedModelId: string;
  resolvedBy: string;
  rates: CostEstimateScreenRate[];
  scenarios: CostEstimateScreenScenario[];
};

type CostEstimateScreenProps = {
  targetLabel: string;
  providerLabel: string;
  activeModel: string;
  totalInputTokens: number;
  cacheEligibleTokens: number;
  dynamicTokens: number;
  outputExampleTokens: number;
  segments: CostEstimateScreenSegment[];
  variants: CostEstimateScreenVariant[];
  assumptions: string[];
};

type CostEstimateScreenTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const ACCENT = '#D7F54A';
const CACHE_COLOR = '#22D3EE';
const DYNAMIC_COLOR = '#F97316';
const CARD_BORDER_COLOR = '#374151';

const VARIANT_COLORS = ['#A78BFA', '#34D399', '#FBBF24', '#60A5FA', '#F472B6'];

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

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
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

function formatUsd(value: number): string {
  if (value === 0) {
    return '$0.0000';
  }
  if (Math.abs(value) >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (Math.abs(value) >= 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(6)}`;
}

function formatPerMillion(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return formatUsd(value);
}

function toneToColor(tone: CostEstimateScreenTone): string {
  switch (tone) {
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'danger':
      return 'red';
    case 'info':
      return 'cyan';
    default:
      return 'gray';
  }
}

function ProgressBar({ value, max, width, color }: { value: number; max: number; width: number; color: string }): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return `\u2588`.repeat(filled) + `\u2591`.repeat(empty);
}

function TokenBreakdownBar({ cacheTokens, dynamicTokens, width }: { cacheTokens: number; dynamicTokens: number; width: number }): React.ReactNode {
  const total = cacheTokens + dynamicTokens;
  if (total === 0) {
    return <Text color="gray">{` `.repeat(width)}</Text>;
  }
  const cacheRatio = cacheTokens / total;
  const cacheWidth = Math.round(cacheRatio * width);
  const dynamicWidth = width - cacheWidth;

  return (
    <Box>
      <Text color={CACHE_COLOR}>{`\u2588`.repeat(cacheWidth)}</Text>
      <Text color={DYNAMIC_COLOR}>{`\u2588`.repeat(dynamicWidth)}</Text>
    </Box>
  );
}

type StatCardProps = {
  title: string;
  value: string;
  subtitle?: string;
  tone?: CostEstimateScreenTone;
  accentColor?: string;
};

function StatCard({ title, value, subtitle, tone = 'info', accentColor }: StatCardProps) {
  const color = accentColor ?? toneToColor(tone);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={CARD_BORDER_COLOR}
      paddingX={1}
      paddingY={0}
      marginRight={1}
    >
      <Text color="gray" bold>
        {title}
      </Text>
      <Text color={color} bold>
        {value}
      </Text>
      {subtitle && <Text color="gray">{subtitle}</Text>}
    </Box>
  );
}

type ScenarioCardProps = {
  scenario: CostEstimateScreenScenario;
  inputCostColor: string;
  outputCostColor: string;
  savingsColor: string;
  scenarioColor: string;
};

function ScenarioCard({ scenario, inputCostColor, outputCostColor, savingsColor, scenarioColor }: ScenarioCardProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={CARD_BORDER_COLOR} paddingX={1} paddingY={0} marginTop={1}>
      <Text color={scenarioColor} bold>
        {scenario.label}
      </Text>
      <Box marginTop={0}>
        <Text color="gray">Input: </Text>
        <Text color={inputCostColor}>{formatUsd(scenario.inputCostUsd)}</Text>
        <Text color="gray"> + Output: </Text>
        <Text color={outputCostColor}>{formatUsd(scenario.outputExampleCostUsd)}</Text>
        <Text color="gray"> = </Text>
        <Text color={scenarioColor} bold>
          {formatUsd(scenario.totalWithOutputExampleUsd)}
        </Text>
      </Box>
      {scenario.savingsVsColdUsd > 0 && (
        <Text color={savingsColor}>
          Saves {formatUsd(scenario.savingsVsColdUsd)} vs cold {scenario.note}
        </Text>
      )}
      {scenario.savingsVsColdUsd === 0 && <Text color="gray">{scenario.note}</Text>}
    </Box>
  );
}

type ModelCardProps = {
  variant: CostEstimateScreenVariant;
  variantIndex: number;
  contentWidth: number;
  outputExampleTokens: number;
};

function ModelCard({ variant, variantIndex, contentWidth, outputExampleTokens }: ModelCardProps) {
  const variantColor = VARIANT_COLORS[variantIndex % VARIANT_COLORS.length];
  const accentBar = `\u2503`;

  const inputScenario = variant.scenarios.find((s) => s.label.includes('Input Only') || s.label === 'Input Only');
  const cachedScenario = variant.scenarios.find((s) => s.label.includes('Cached'));
  const firstScenario = variant.scenarios[0];
  const lastScenario = variant.scenarios[variant.scenarios.length - 1];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={variantColor}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Box flexDirection="column">
          <Text bold color="white">
            {variant.label}
          </Text>
          <Text color="gray" bold>
            {truncateMiddle(variant.resolvedModelId, Math.max(24, contentWidth - 35))}
          </Text>
        </Box>
        <Text color={variantColor}>via {variant.resolvedBy}</Text>
      </Box>

      <Newline />

      <Box flexDirection="row" marginBottom={0}>
        <Box flexDirection="column" marginRight={2}>
          <Text color="gray" bold>
            RATE (per 1M tokens)
          </Text>
          {variant.rates.slice(0, 3).map((rate) => (
            <Text key={rate.label} color="gray">
              {rate.label.padEnd(14, ' ')}: <Text color="white">{formatPerMillion(rate.perMillionUsd)}</Text>
            </Text>
          ))}
        </Box>

        {inputScenario && cachedScenario && (
          <Box flexDirection="column">
            <Text color="gray" bold>
              COST ESTIMATE
            </Text>
            <Box flexDirection="row">
              <Text color="gray">Cache: </Text>
              <Text color={CACHE_COLOR}>{formatUsd(cachedScenario.inputCostUsd)}</Text>
              <Text color="gray"> / </Text>
              <Text color={DYNAMIC_COLOR}>{formatUsd(inputScenario.inputCostUsd)}</Text>
              <Text color="gray"> cold</Text>
            </Box>
            <Text color="gray">
              + {formatInteger(outputExampleTokens)} output: <Text color="white">{formatUsd(firstScenario.outputExampleCostUsd)}</Text>
            </Text>
          </Box>
        )}
      </Box>

      {variant.scenarios.length > 0 && (
        <Box flexDirection="column" marginTop={0}>
          <Newline />
          <Text color="gray" bold>
            SCENARIOS
          </Text>
          {variant.scenarios.map((scenario, index) => {
            const scenarioColor = index === 0 ? 'yellow' : index === variant.scenarios.length - 1 ? 'green' : 'white';
            const savingsColor = scenario.savingsVsColdUsd > 0 ? 'green' : 'gray';
            return (
              <ScenarioCard
                key={scenario.label}
                scenario={scenario}
                inputCostColor={scenarioColor}
                outputCostColor={scenarioColor}
                savingsColor={savingsColor}
                scenarioColor={scenarioColor}
              />
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function SegmentBar({ segments, contentWidth }: { segments: CostEstimateScreenSegment[]; contentWidth: number }): React.ReactNode {
  const total = segments.reduce((sum, s) => sum + s.tokenCount, 0);
  if (total === 0) {
    return null;
  }

  const barWidth = Math.max(20, contentWidth - 35);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text color="gray" bold>
          INPUT BREAKDOWN
        </Text>
      </Box>
      <Box flexDirection="row" alignItems="center" marginBottom={0}>
        <TokenBreakdownBar
          cacheTokens={segments.filter((s) => s.cacheEligible).reduce((sum, s) => sum + s.tokenCount, 0)}
          dynamicTokens={segments.filter((s) => !s.cacheEligible).reduce((sum, s) => sum + s.tokenCount, 0)}
          width={barWidth}
        />
        <Text color="gray"> </Text>
        <Text color="white" bold>
          {formatCompactNumber(total)}
        </Text>
        <Text color="gray"> tokens</Text>
      </Box>
      <Box flexDirection="row" marginTop={0}>
        <Box flexDirection="row" marginRight={2}>
          <Text color={CACHE_COLOR}>█</Text>
          <Text color="gray"> Cache </Text>
          <Text color="white">{formatCompactNumber(segments.filter((s) => s.cacheEligible).reduce((sum, s) => sum + s.tokenCount, 0))}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={DYNAMIC_COLOR}>█</Text>
          <Text color="gray"> Dynamic </Text>
          <Text color="white">{formatCompactNumber(segments.filter((s) => !s.cacheEligible).reduce((sum, s) => sum + s.tokenCount, 0))}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function SegmentList({ segments }: { segments: CostEstimateScreenSegment[] }): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>
        SEGMENTS
      </Text>
      {segments.map((segment) => (
        <Box key={segment.label} flexDirection="row" justifyContent="space-between">
          <Text color={segment.cacheEligible ? CACHE_COLOR : DYNAMIC_COLOR}>
            {segment.cacheEligible ? '●' : '○'} {segment.label}
          </Text>
          <Box>
            <Text color="white">{formatInteger(segment.tokenCount)}</Text>
            <Text color="gray"> tok</Text>
            <Text color={segment.cacheEligible ? CACHE_COLOR : 'gray'}> {segment.cacheEligible ? 'cached' : 'dynamic'}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function CostEstimateScreen(props: CostEstimateScreenProps) {
  const terminalWidth = process.stdout.columns ?? 100;
  const contentWidth = Math.max(72, terminalWidth - 2);

  const totalTokens = props.totalInputTokens;
  const cacheRatio = totalTokens > 0 ? ((props.cacheEligibleTokens / totalTokens) * 100).toFixed(1) : '0.0';
  const dynamicRatio = totalTokens > 0 ? ((props.dynamicTokens / totalTokens) * 100).toFixed(1) : '0.0';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="gray" bold>
          COST ESTIMATE
        </Text>
        <Text color="black" backgroundColor={ACCENT}>
          {' '}
          {props.targetLabel} · OpenRouter{' '}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="white" bold>
          {props.activeModel}
        </Text>
        <Text color="gray">
          Provider: {props.providerLabel} · Target: {props.targetLabel}
        </Text>
      </Box>

      <Box flexDirection="row" marginBottom={1} flexWrap="wrap">
        <StatCard
          title="TOTAL INPUT"
          value={formatCompactNumber(totalTokens)}
          subtitle="tokens"
          tone="info"
        />
        <StatCard
          title="CACHE HIT"
          value={`${cacheRatio}%`}
          subtitle={`${formatCompactNumber(props.cacheEligibleTokens)} tok`}
          tone="success"
          accentColor={CACHE_COLOR}
        />
        <StatCard
          title="DYNAMIC"
          value={`${dynamicRatio}%`}
          subtitle={`${formatCompactNumber(props.dynamicTokens)} tok`}
          tone="warning"
          accentColor={DYNAMIC_COLOR}
        />
        <StatCard
          title="OUTPUT SAMPLE"
          value={formatCompactNumber(props.outputExampleTokens)}
          subtitle="tokens"
          tone="info"
        />
      </Box>

      {props.segments.length > 0 && <SegmentBar segments={props.segments} contentWidth={contentWidth} />}

      {props.segments.length > 0 && <SegmentList segments={props.segments} />}

      <Newline />

      <Text color="gray" bold>
        MODEL VARIANTS
      </Text>

      {props.variants.map((variant, index) => (
        <ModelCard
          key={variant.resolvedModelId}
          variant={variant}
          variantIndex={index}
          contentWidth={contentWidth}
          outputExampleTokens={props.outputExampleTokens}
        />
      ))}

      <Newline />

      <Box flexDirection="column" borderStyle="single" borderColor={CARD_BORDER_COLOR} paddingX={1} paddingY={0}>
        <Text color="gray" bold>
          ASSUMPTIONS
        </Text>
        {props.assumptions.map((assumption, index) => (
          <Text key={`assumption-${index}`} color="gray">
            • {truncateMiddle(assumption, contentWidth - 3)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}