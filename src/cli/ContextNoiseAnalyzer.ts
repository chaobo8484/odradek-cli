import path from 'path';
import {
  parseClaudeTranscriptSession,
  type TranscriptSource,
  type ClaudeTranscriptContextItem as ContextItem,
  type ClaudeTranscriptSession as ParsedSession,
  type ClaudeTranscriptObservation as ToolObservation,
} from './ClaudeTranscriptParser.js';
import { estimateTokenCount } from './tokenEstimate.js';

// ---------------------------------------------------------------------------
// Confidence-based noise detection
//
// Every noise event carries a confidence score [0, 1].
// Events below MIN_CONFIDENCE are silently discarded, so the output only
// contains signals we can actually defend.
//
// Scoring model (additive evidence):
//   - Structural evidence  (path match, content fingerprint)  → high weight
//   - Temporal evidence    (time gap, step gap)               → medium weight
//   - Semantic evidence    (keyword co-occurrence)            → low weight
//
// The final confidence is clamped to [0, 1] and compared against
// MIN_CONFIDENCE before an event is emitted.
// ---------------------------------------------------------------------------

export type ContextNoiseTarget = {
  sessionId: string;
  filePath: string;
  source?: TranscriptSource;
};

export type ContextNoiseSeverity = 'high' | 'medium' | 'low';
export type ContextNoiseTag = 'dup' | 'miss' | 'stale' | 'bloat';
export type ContextNoiseCategoryKey =
  | 'read_dup'
  | 'bash_dup'
  | 'grep_miss'
  | 'ctx_stale'
  | 'write_noop'
  | 'ls_redundant'
  | 'read_bloat'
  | 'bash_bloat';

export type ContextNoiseCategory = {
  key: ContextNoiseCategoryKey;
  tool: 'Read' | 'Write' | 'Bash' | 'Grep' | 'LS' | 'ctx';
  label: string;
  tokens: number;
  callCount: number;
  severity: ContextNoiseSeverity;
  thresholdTokens: number;
  shareOfThreshold: number;
  shareOfNoise: number;
};

export type ContextNoiseEvent = {
  sessionId: string;
  sessionFile: string;
  timestampMs: number;
  timestampLabel: string;
  tool: 'Read' | 'Write' | 'Bash' | 'Grep' | 'LS' | 'ctx';
  categoryKey?: ContextNoiseCategoryKey;
  target: string;
  tokens: number;
  tag: ContextNoiseTag;
  severity: ContextNoiseSeverity;
  reason: string;
  confidence: number;
  order: number;
};

export type ContextNoiseFileHotspot = {
  path: string;
  totalReads: number;
  uniqueReads: number;
  dupReads: number;
  tokensConsumed: number;
  heat: ContextNoiseSeverity;
};

export type ContextNoiseReadRecord = {
  sessionId: string;
  path: string;
  cwd: string;
  tokenCount: number;
  order: number;
  resultContent: string;
  wasReferencedLater: boolean;
};

export type ContextNoiseSessionSummary = {
  sessionId: string;
  filePath: string;
  startTime: string;
  endTime: string;
  startTimestampMs: number;
  endTimestampMs: number;
  totalTokens: number;
  noiseTokens: number;
  noiseRatio: number;
  totalToolCalls: number;
  duplicateCalls: number;
};

export type ContextNoiseAnalysis = {
  sessionsScanned: number;
  sessionsAnalyzed: number;
  sessionsWithSignals: number;
  totalEstimatedTokens: number;
  totalNoiseTokens: number;
  totalToolCalls: number;
  duplicateCalls: number;
  primarySession: ContextNoiseSessionSummary | null;
  sessions: ContextNoiseSessionSummary[];
  categories: ContextNoiseCategory[];
  events: ContextNoiseEvent[];
  fileHotspots: ContextNoiseFileHotspot[];
  readRecords: ContextNoiseReadRecord[];
  warnings: string[];
};

type CategoryMeta = {
  tool: ContextNoiseCategory['tool'];
  label: string;
  thresholdTokens: number;
};

// Evidence record used internally during scoring
type UsageEvidence = {
  pathMutation: boolean;       // a later write/edit targeted the same path
  resultPathFollowup: boolean; // later reads/edits directly used a file returned by the tool
  sameDirectoryFollowup: boolean; // later work narrowed into the same directory subtree
  pathMentioned: boolean;      // the path string appears in later tool inputs
  filenameMentioned: boolean;  // just the basename appears in later messages
  strongKeywordHit: boolean;   // a rare, specific keyword from the content appears later
  weakKeywordHit: boolean;     // a common keyword appears later (lower weight)
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_MUTATION_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const DIRECTORY_TOOLS = new Set(['ls', 'glob']);

// Duplicate detection window: 5 minutes or 20 steps (whichever applies)
const DUPLICATE_LOOKBACK_MS = 5 * 60 * 1000;
const DUPLICATE_LOOKBACK_STEPS = 20;

// Stale-context thresholds: re-read after this much intervening context
const STALE_INTERVENING_TOKENS = 4000;
const STALE_STEP_GAP = 12;

// Bloat: minimum token size before we even consider flagging
const READ_BLOAT_MIN_TOKENS = 1200;
const BASH_BLOAT_MIN_TOKENS = 900;
const BROAD_SCAN_ENTRY_THRESHOLD = 50;

// Confidence thresholds
const MIN_CONFIDENCE = 0.55;   // events below this are discarded
const CATEGORY_ORDER: ContextNoiseCategoryKey[] = [
  'read_dup',
  'bash_dup',
  'ctx_stale',
  'read_bloat',
  'bash_bloat',
  'write_noop',
  'grep_miss',
  'ls_redundant',
];

const CATEGORY_META: Record<ContextNoiseCategoryKey, CategoryMeta> = {
  read_dup:     { tool: 'Read',  label: 'Duplicate Reads',     thresholdTokens: 20000 },
  bash_dup:     { tool: 'Bash',  label: 'Repeated Commands',   thresholdTokens: 20000 },
  grep_miss:    { tool: 'Grep',  label: 'Missed Searches',     thresholdTokens: 12000 },
  ctx_stale:    { tool: 'ctx',   label: 'Stale Context',       thresholdTokens: 18000 },
  write_noop:   { tool: 'Write', label: 'No-op Writes',        thresholdTokens: 16000 },
  ls_redundant: { tool: 'LS',    label: 'Redundant Scans',     thresholdTokens: 10000 },
  read_bloat:   { tool: 'Read',  label: 'Unused Large Reads',  thresholdTokens: 24000 },
  bash_bloat:   { tool: 'Bash',  label: 'Unused Large Output', thresholdTokens: 16000 },
};

export class ContextNoiseAnalyzer {
  async analyze(targets: ContextNoiseTarget[]): Promise<ContextNoiseAnalysis> {
    const warnings: string[] = [];
    const sessions: ParsedSession[] = [];

    for (const target of targets) {
      const parsed = await this.parseSession(target);
      if (!parsed) {
        warnings.push(`Failed to parse session: ${target.filePath}`);
        continue;
      }
      sessions.push(parsed);
    }

    const totalEstimatedTokens = sessions.reduce(
      (sum, session) => sum + session.items.reduce((sessionSum, item) => sessionSum + item.tokenCount, 0),
      0
    );
    const totalToolCalls = sessions.reduce((sum, session) => sum + session.observations.length, 0);
    const events = sessions
      .flatMap((session) => this.detectNoiseEvents(session))
      .sort((a, b) => b.confidence - a.confidence || b.tokens - a.tokens || a.target.localeCompare(b.target));
    const totalNoiseTokens = events.reduce((sum, event) => sum + event.tokens, 0);
    const duplicateCalls = events.filter((event) => event.tag === 'dup').length;
    const sessionsWithSignals = new Set(events.map((event) => event.sessionId)).size;
    const categories = this.aggregateCategories(events, totalNoiseTokens);
    const fileHotspots = this.buildFileHotspots(sessions);
    const sessionSummaries = this.buildSessionSummaries(sessions, events);
    const primarySession = sessionSummaries[0] ?? null;

    if (sessions.length === 0) {
      warnings.push('No analyzable session JSONL files were found.');
    }

    return {
      sessionsScanned: targets.length,
      sessionsAnalyzed: sessions.length,
      sessionsWithSignals,
      totalEstimatedTokens,
      totalNoiseTokens,
      totalToolCalls,
      duplicateCalls,
      primarySession,
      sessions: sessionSummaries,
      categories,
      events: events.slice(0, 32),
      fileHotspots,
      readRecords: sessions
        .flatMap((session) =>
          session.observations
            .filter((observation) => observation.name.toLowerCase() === 'read' && observation.targetPath)
            .map((observation) => ({
              sessionId: session.sessionId,
              path: this.toDisplayPath(observation.targetPath),
              cwd: observation.cwd,
              tokenCount: Math.max(observation.resultTokens, observation.estimatedTokens),
              order: observation.order,
              resultContent: observation.resultContent,
              wasReferencedLater: (() => {
                const usage = this.scoreUsageEvidence(session, observation);
                return usage.pathMutation || usage.resultPathFollowup || usage.pathMentioned || usage.strongKeywordHit;
              })(),
            }))
        )
        .sort((a, b) => b.tokenCount - a.tokenCount || a.path.localeCompare(b.path)),
      warnings: Array.from(new Set(warnings)),
    };
  }

  private async parseSession(target: ContextNoiseTarget): Promise<ParsedSession | null> {
    return parseClaudeTranscriptSession(target);
  }



  // -------------------------------------------------------------------------
  // Noise detection — entry point
  // -------------------------------------------------------------------------

  private detectNoiseEvents(session: ParsedSession): ContextNoiseEvent[] {
    const flaggedIds = new Set<string>();
    const raw: ContextNoiseEvent[] = [
      ...this.detectReadDuplicates(session, flaggedIds),
      ...this.detectReadBloat(session, flaggedIds),
      ...this.detectBashDuplicates(session, flaggedIds),
      ...this.detectBashBloat(session, flaggedIds),
      ...this.detectGrepMisses(session),
      ...this.detectWriteNoops(session),
      ...this.detectListingNoise(session),
    ];
    return raw.filter((e) => e.confidence >= MIN_CONFIDENCE);
  }

  // -------------------------------------------------------------------------
  // Detector: duplicate / stale reads
  // -------------------------------------------------------------------------

  private detectReadDuplicates(session: ParsedSession, flaggedIds: Set<string>): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];
    const lastMutationOrder = new Map<string, number>();
    const lastRead = new Map<string, ToolObservation>();

    for (const obs of session.observations) {
      const name = obs.name.toLowerCase();
      const normPath = this.normalizePathKey(obs.targetPath);

      if (TOOL_MUTATION_NAMES.has(name) && normPath) {
        lastMutationOrder.set(normPath, obs.order);
        continue;
      }
      if (name !== 'read' || !normPath || obs.estimatedTokens <= 0) continue;

      const prev = lastRead.get(normPath);
      const lastMut = lastMutationOrder.get(normPath) ?? -1;

      if (prev && prev.order > lastMut) {
        const overlap = this.describeReadOverlap(prev, obs);
        if (overlap.comparable && !overlap.overlaps) {
          lastRead.set(normPath, obs);
          continue;
        }
        const fpMatch = this.isEquivalentReadReplay(prev, obs, overlap);
        if (fpMatch) {
          const gapTokens = this.sumTokensBetween(session.items, prev.order, obs.order);
          const stepGap = obs.order - prev.order;
          const isStale = gapTokens >= STALE_INTERVENING_TOKENS || stepGap >= STALE_STEP_GAP;

          // Confidence: high for exact fingerprint match, slight penalty for tiny gaps
          let confidence = overlap.sameRange ? 0.88 : 0.78;
          if (!overlap.sameRange && overlap.overlapRatio < 0.95) confidence -= 0.08;
          if (stepGap < 3) confidence -= 0.15; // very close re-reads may be intentional
          if (stepGap < 1) confidence -= 0.10;

          if (isStale) {
            events.push(this.makeEvent(session, obs, {
              tool: 'ctx', categoryKey: 'ctx_stale', tag: 'stale',
              target: this.toDisplayPath(obs.targetPath),
              tokens: obs.estimatedTokens,
              severity: obs.estimatedTokens >= 1400 ? 'high' : 'medium',
              reason: `Re-read after ${this.fmtTokens(gapTokens)} of intervening context — earlier read likely went stale.`,
              confidence,
            }));
          } else {
            events.push(this.makeEvent(session, obs, {
              tool: 'Read', categoryKey: 'read_dup', tag: 'dup',
              target: this.toDisplayPath(obs.targetPath),
              tokens: obs.estimatedTokens,
              severity: obs.estimatedTokens >= 1200 ? 'high' : 'medium',
              reason: 'Same file read again with identical content and no intervening write.',
              confidence,
            }));
          }
          flaggedIds.add(obs.id);
        }
      }
      lastRead.set(normPath, obs);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Detector: read bloat (large reads that were never used)
  // -------------------------------------------------------------------------

  private detectReadBloat(session: ParsedSession, flaggedIds: Set<string>): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];
    const lastMutationOrder = new Map<string, number>();

    for (const obs of session.observations) {
      const name = obs.name.toLowerCase();
      const normPath = this.normalizePathKey(obs.targetPath);
      if (TOOL_MUTATION_NAMES.has(name) && normPath) {
        lastMutationOrder.set(normPath, obs.order);
        continue;
      }
      if (name !== 'read' || flaggedIds.has(obs.id)) continue;
      if (obs.estimatedTokens < READ_BLOAT_MIN_TOKENS) continue;

      const mutatedAfter = session.observations.some(
        (n) => n.order > obs.order && TOOL_MUTATION_NAMES.has(n.name.toLowerCase()) &&
          this.normalizePathKey(n.targetPath) === normPath
      );
      if (mutatedAfter) continue;

      const usageScore = this.computeUsageScore(session, obs);
      const confidence = Math.max(0, 1.0 - usageScore - (obs.estimatedTokens < 400 ? 0.1 : 0));

      events.push(this.makeEvent(session, obs, {
        tool: 'Read', categoryKey: 'read_bloat', tag: 'bloat',
        target: this.toDisplayPath(obs.targetPath),
        tokens: obs.estimatedTokens,
        severity: obs.estimatedTokens >= 2000 ? 'high' : 'medium',
        reason: `Large file read (${this.fmtTokens(obs.estimatedTokens)}) with no clear downstream use — consider reading only the needed line range.`,
        confidence,
      }));
      void lastMutationOrder;
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Detector: duplicate bash commands
  // -------------------------------------------------------------------------

  private detectBashDuplicates(session: ParsedSession, flaggedIds: Set<string>): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];
    const lastCommand = new Map<string, ToolObservation>();

    for (const obs of session.observations) {
      if (obs.name.toLowerCase() !== 'bash') continue;
      if (this.isDirectoryListingCommand(obs.command, obs.resultContent)) continue;
      const normCmd = this.normalizeCommand(obs.command);
      if (!normCmd) continue;

      const prev = lastCommand.get(normCmd);
      if (prev && this.isWithinDuplicateWindow(prev, obs) &&
          this.contentFingerprint(prev.resultContent) === this.contentFingerprint(obs.resultContent)) {
        const gapMs = (obs.timestampMs > 0 && prev.timestampMs > 0)
          ? obs.timestampMs - prev.timestampMs : -1;
        let confidence = 0.85;
        if (gapMs >= 0 && gapMs < 30_000) confidence -= 0.10;

        events.push(this.makeEvent(session, obs, {
          tool: 'Bash', categoryKey: 'bash_dup', tag: 'dup',
          target: this.truncateCommand(obs.command || 'bash'),
          tokens: obs.estimatedTokens,
          severity: obs.estimatedTokens >= 900 ? 'high' : 'medium',
          reason: 'Same command rerun within the duplicate window with identical output.',
          confidence,
        }));
        flaggedIds.add(obs.id);
      }
      lastCommand.set(normCmd, obs);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Detector: bash bloat (large outputs never referenced)
  // -------------------------------------------------------------------------

  private detectBashBloat(session: ParsedSession, flaggedIds: Set<string>): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];

    for (const obs of session.observations) {
      if (obs.name.toLowerCase() !== 'bash') continue;
      if (flaggedIds.has(obs.id)) continue;
      if (obs.estimatedTokens < BASH_BLOAT_MIN_TOKENS) continue;
      if (this.isDirectoryListingCommand(obs.command, obs.resultContent)) continue;

      const usageScore = this.computeUsageScore(session, obs);
      const confidence = Math.max(0, 1.0 - usageScore);

      events.push(this.makeEvent(session, obs, {
        tool: 'Bash', categoryKey: 'bash_bloat', tag: 'bloat',
        target: this.truncateCommand(obs.command || 'bash'),
        tokens: obs.estimatedTokens,
        severity: obs.estimatedTokens >= 1600 ? 'high' : 'medium',
        reason: `Large shell output (${this.fmtTokens(obs.estimatedTokens)}) with no clear downstream reference.`,
        confidence,
      }));
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Detector: grep misses
  // -------------------------------------------------------------------------

  private detectGrepMisses(session: ParsedSession): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];
    for (const obs of session.observations) {
      if (obs.name.toLowerCase() !== 'grep') continue;
      if (!this.isMissedSearch(obs.resultContent)) continue;
      const target = this.extractSearchTarget(obs.input) || this.toDisplayPath(obs.targetPath) || 'grep';
      events.push(this.makeEvent(session, obs, {
        tool: 'Grep', categoryKey: 'grep_miss', tag: 'miss',
        target: this.truncateCommand(target),
        tokens: obs.estimatedTokens,
        severity: obs.estimatedTokens >= 400 ? 'medium' : 'low',
        reason: 'Search returned no matches — pattern or path did not contribute useful information.',
        confidence: 0.90,
      }));
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Detector: write no-ops
  // -------------------------------------------------------------------------

  private detectWriteNoops(session: ParsedSession): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];
    const lastWriteByPath = new Map<string, ToolObservation>();

    for (const obs of session.observations) {
      const name = obs.name.toLowerCase();
      if (!TOOL_MUTATION_NAMES.has(name)) continue;
      const normPath = this.normalizePathKey(obs.targetPath);
      if (!normPath) continue;

      const structuredNoop =
        (name === 'edit' || name === 'multiedit' || name === 'notebookedit') &&
        obs.successFlag === true &&
        obs.structuredPatchCount === 0 &&
        obs.userModified !== true &&
        (obs.writePayload.length > 0 || obs.oldString === obs.newString);

      if (structuredNoop) {
        events.push(this.makeEvent(session, obs, {
          tool: 'Write', categoryKey: 'write_noop', tag: 'dup',
          target: this.toDisplayPath(obs.targetPath),
          tokens: Math.max(obs.estimatedTokens, estimateTokenCount(obs.writePayload)),
          severity: obs.estimatedTokens >= 800 ? 'high' : 'medium',
          reason: 'Edit completed without any structured patch output, so the requested change likely did not alter file state.',
          confidence: 0.94,
        }));
      }

      if (!obs.writePayload) {
        lastWriteByPath.set(normPath, obs);
        continue;
      }

      const prev = lastWriteByPath.get(normPath);
      if (prev && this.isWithinDuplicateWindow(prev, obs)) {
        const fpA = this.contentFingerprint(prev.writePayload);
        const fpB = this.contentFingerprint(obs.writePayload);
        if (fpA === fpB) {
          events.push(this.makeEvent(session, obs, {
            tool: 'Write', categoryKey: 'write_noop', tag: 'dup',
            target: this.toDisplayPath(obs.targetPath),
            tokens: Math.max(obs.estimatedTokens, estimateTokenCount(obs.writePayload)),
            severity: obs.writePayload.length >= 1200 ? 'high' : 'medium',
            reason: 'Identical write payload sent to the same file — no state change occurred.',
            confidence: 0.90,
          }));
        }
      }
      lastWriteByPath.set(normPath, obs);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Detector: listing noise
  // -------------------------------------------------------------------------

  private detectListingNoise(session: ParsedSession): ContextNoiseEvent[] {
    const events: ContextNoiseEvent[] = [];
    const lastScanByTarget = new Map<string, ToolObservation>();

    for (const obs of session.observations) {
      const isListing = DIRECTORY_TOOLS.has(obs.name.toLowerCase()) ||
        this.isDirectoryListingCommand(obs.command, obs.resultContent);
      if (!isListing) continue;

      const scanTarget = this.normalizeListingTarget(obs);
      const prev = lastScanByTarget.get(scanTarget);

      if (prev && this.isWithinDuplicateWindow(prev, obs) &&
          this.contentFingerprint(prev.resultContent) === this.contentFingerprint(obs.resultContent)) {
        events.push(this.makeEvent(session, obs, {
          tool: 'LS', categoryKey: 'ls_redundant', tag: 'dup',
          target: this.toDisplayPath(obs.targetPath || obs.command || '.'),
          tokens: obs.estimatedTokens,
          severity: obs.estimatedTokens >= 500 ? 'medium' : 'low',
          reason: 'Same directory scanned again with identical results.',
          confidence: 0.80,
        }));
      } else {
        const entryCount = this.estimateObservationEntryCount(obs);
        const followupCount = this.countListingFollowups(session, obs);
        const utilizationRatio = entryCount > 0 ? followupCount / entryCount : 0;
        if (
          entryCount >= BROAD_SCAN_ENTRY_THRESHOLD &&
          this.isRootLikeScan(obs) &&
          (obs.truncated || followupCount <= 2 || utilizationRatio < 0.12)
        ) {
          events.push(this.makeEvent(session, obs, {
            tool: 'LS', categoryKey: 'ls_redundant', tag: 'bloat',
            target: this.toDisplayPath(obs.targetPath || obs.command || '.'),
            tokens: obs.estimatedTokens,
            severity: entryCount >= 100 ? 'high' : 'medium',
            reason: obs.truncated
              ? `Broad directory scan pulled ~${entryCount} entries and truncated the result. Only ${followupCount} downstream paths were used.`
              : `Broad directory scan pulled ~${entryCount} entries, but only ${followupCount} downstream paths were used (${Math.round(utilizationRatio * 100)}% utilization).`,
            confidence: obs.truncated ? 0.82 : Math.min(0.9, 0.62 + (utilizationRatio < 0.05 ? 0.18 : 0)),
          }));
        }
      }
      lastScanByTarget.set(scanTarget, obs);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Usage evidence scoring (replaces wasReadUsedLater)
  // -------------------------------------------------------------------------

  // Expanded stopword list — words that appear in almost any codebase and
  // therefore carry no signal about whether a specific read was "used".
  private static readonly STOPWORDS = new Set([
    'this','that','from','with','have','were','will','would','should','about',
    'there','their','error','warning','result','value','type','name','data',
    'true','false','null','undefined','return','const','class','function',
    'import','export','async','await','string','number','boolean','object',
    'array','index','item','list','file','path','line','code','text','info',
    'debug','test','spec','util','helper','service','module','config','setup',
    'init','run','get','set','add','new','old','use','key','map','log',
  ]);

  private computeUsageScore(session: ParsedSession, obs: ToolObservation): number {
    const ev = this.scoreUsageEvidence(session, obs);
    let score = 0;
    if (ev.pathMutation) score += 1.0;
    if (ev.resultPathFollowup) score += 0.95;
    if (ev.sameDirectoryFollowup) score += 0.55;
    if (ev.pathMentioned) score += 0.75;
    if (ev.filenameMentioned) score += 0.4;
    if (ev.strongKeywordHit) score += 0.45;
    if (ev.weakKeywordHit) score += 0.1;
    return Math.min(1, score);
  }

  private scoreUsageEvidence(session: ParsedSession, obs: ToolObservation): UsageEvidence {
    const normPath = this.normalizePathKey(obs.targetPath);
    const displayPath = this.toDisplayPath(obs.targetPath).toLowerCase();
    const basename = path.basename(obs.targetPath).toLowerCase();
    const futureObservations = session.observations
      .filter((n) => n.order > obs.order)
      .slice(0, 25);
    const futureMessages = session.messages
      .filter((m) => m.order > obs.order && !m.isSynthetic)
      .slice(0, 25);

    // Check for later mutation on the same path
    const pathMutation = normPath ? futureObservations.some(
      (n) => TOOL_MUTATION_NAMES.has(n.name.toLowerCase()) &&
        this.normalizePathKey(n.targetPath) === normPath
    ) : false;

    const resultPathSet = new Set(
      (obs.resultPaths.length > 0 ? obs.resultPaths : [obs.targetPath])
        .map((candidate) => this.normalizePathKey(candidate))
        .filter(Boolean)
    );
    const resultPathFollowup = resultPathSet.size > 0 && futureObservations.some((next) => {
      const nextPath = this.normalizePathKey(next.targetPath);
      return nextPath ? resultPathSet.has(nextPath) : false;
    });
    const sameDirectoryFollowup = this.hasSameDirectoryFollowup(obs, futureObservations);

    if (pathMutation) {
      return {
        pathMutation: true,
        resultPathFollowup,
        sameDirectoryFollowup,
        pathMentioned: false,
        filenameMentioned: false,
        strongKeywordHit: false,
        weakKeywordHit: false,
      };
    }

    // Build future text corpus (next 20 messages + next 20 tool inputs)
    const futureMessageText = futureMessages
      .map((m) => m.text.toLowerCase())
      .join('\n');
    const futureInputs = futureObservations
      .map((n) => `${n.inputText}\n${n.command}`.toLowerCase())
      .join('\n');
    const futureText = `${futureMessageText}\n${futureInputs}`;

    const pathMentioned = displayPath.length >= 4 && futureText.includes(displayPath);
    const filenameMentioned = basename.length >= 3 && futureText.includes(basename);

    // Extract rare identifiers from content for strong keyword matching
    const { strong, weak } = this.extractSignalKeywords(obs.resultContent || obs.command || '');
    const strongKeywordHit = strong.some((kw) => futureText.includes(kw));
    const weakKeywordHit = !strongKeywordHit && weak.some((kw) => futureText.includes(kw));

    return {
      pathMutation,
      resultPathFollowup,
      sameDirectoryFollowup,
      pathMentioned,
      filenameMentioned,
      strongKeywordHit,
      weakKeywordHit,
    };
  }

  // Extract keywords from content, split into strong (rare, specific) and weak (common)
  private extractSignalKeywords(text: string): { strong: string[]; weak: string[] } {
    const strong: string[] = [];
    const weak: string[] = [];
    const seen = new Set<string>();

    // Count occurrences to identify rare tokens
    const tokenFreq = new Map<string, number>();
    const allTokens = text.match(/[A-Za-z_][A-Za-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const t of allTokens) {
      const lc = t.toLowerCase();
      tokenFreq.set(lc, (tokenFreq.get(lc) ?? 0) + 1);
    }

    for (const [token, freq] of tokenFreq) {
      if (seen.size >= 24) break;
      if (ContextNoiseAnalyzer.STOPWORDS.has(token)) continue;
      if (token.length < 4) continue;
      seen.add(token);
      // Strong: long identifier that appears rarely in the content (likely unique to this file)
      if (token.length >= 8 && freq <= 3) {
        strong.push(token);
      } else {
        weak.push(token);
      }
    }
    return { strong: strong.slice(0, 8), weak: weak.slice(0, 8) };
  }

  private describeReadOverlap(
    previous: ToolObservation,
    current: ToolObservation
  ): { comparable: boolean; overlaps: boolean; sameRange: boolean; overlapRatio: number } {
    if (!previous.fileRange || !current.fileRange) {
      return { comparable: false, overlaps: true, sameRange: true, overlapRatio: 1 };
    }

    const previousStart = previous.fileRange.startLine;
    const previousEnd = previousStart + Math.max(0, previous.fileRange.numLines - 1);
    const currentStart = current.fileRange.startLine;
    const currentEnd = currentStart + Math.max(0, current.fileRange.numLines - 1);
    const overlapStart = Math.max(previousStart, currentStart);
    const overlapEnd = Math.min(previousEnd, currentEnd);
    const overlaps = overlapStart <= overlapEnd;
    const overlapLines = overlaps ? overlapEnd - overlapStart + 1 : 0;
    const denominator = Math.max(1, Math.min(previous.fileRange.numLines, current.fileRange.numLines));
    return {
      comparable: true,
      overlaps,
      sameRange: previousStart === currentStart && previous.fileRange.numLines === current.fileRange.numLines,
      overlapRatio: overlapLines / denominator,
    };
  }

  private isEquivalentReadReplay(
    previous: ToolObservation,
    current: ToolObservation,
    overlap: { comparable: boolean; overlaps: boolean; sameRange: boolean; overlapRatio: number }
  ): boolean {
    if (this.contentFingerprint(previous.resultContent) === this.contentFingerprint(current.resultContent)) {
      return true;
    }
    if (!overlap.comparable || !overlap.overlaps || overlap.overlapRatio < 0.85) {
      return false;
    }
    const previousText = this.normalizeComparableText(previous.resultContent);
    const currentText = this.normalizeComparableText(current.resultContent);
    if (previousText.length < 80 || currentText.length < 80) {
      return false;
    }
    return previousText.includes(currentText) || currentText.includes(previousText);
  }

  private countListingFollowups(session: ParsedSession, observation: ToolObservation): number {
    const futureObservations = session.observations
      .filter((next) => next.order > observation.order)
      .slice(0, 25);
    const resultPathSet = new Set(observation.resultPaths.map((candidate) => this.normalizePathKey(candidate)).filter(Boolean));

    if (resultPathSet.size > 0) {
      const matched = new Set<string>();
      for (const next of futureObservations) {
        const nextPath = this.normalizePathKey(next.targetPath);
        if (nextPath && resultPathSet.has(nextPath)) {
          matched.add(nextPath);
        }
      }
      return matched.size;
    }

    const baseDirectory = this.normalizePathKey(observation.targetPath);
    if (!baseDirectory) {
      return 0;
    }
    const matched = new Set<string>();
    for (const next of futureObservations) {
      const nextPath = this.normalizePathKey(next.targetPath);
      if (nextPath && this.isPathWithinDirectory(nextPath, baseDirectory)) {
        matched.add(nextPath);
      }
    }
    return matched.size;
  }

  private estimateObservationEntryCount(observation: ToolObservation): number {
    if (typeof observation.numFiles === 'number' && observation.numFiles > 0) {
      return observation.numFiles;
    }
    if (observation.resultPaths.length > 0) {
      return observation.resultPaths.length;
    }
    return this.estimateEntryCount(observation.resultContent);
  }

  private hasSameDirectoryFollowup(observation: ToolObservation, futureObservations: ToolObservation[]): boolean {
    const baseDirectory = this.resolveObservationDirectory(observation);
    if (!baseDirectory) {
      return false;
    }
    return futureObservations.some((next) => {
      const nextPath = this.normalizePathKey(next.targetPath);
      return nextPath ? this.isPathWithinDirectory(nextPath, baseDirectory) : false;
    });
  }

  private resolveObservationDirectory(observation: ToolObservation): string {
    const normalizedPath = this.normalizePathKey(observation.targetPath);
    if (!normalizedPath) {
      return '';
    }
    if (DIRECTORY_TOOLS.has(observation.name.toLowerCase()) || this.looksLikeDirectoryPath(observation.targetPath)) {
      return normalizedPath;
    }
    return this.normalizePathKey(path.dirname(observation.targetPath));
  }

  private isPathWithinDirectory(candidatePath: string, directoryPath: string): boolean {
    const normalizedCandidate = this.normalizePathKey(candidatePath);
    const normalizedDirectory = this.normalizePathKey(directoryPath);
    if (!normalizedCandidate || !normalizedDirectory || normalizedCandidate === normalizedDirectory) {
      return false;
    }

    const candidateSegments = normalizedCandidate.split(/[\\/]+/).filter(Boolean);
    const directorySegments = normalizedDirectory.split(/[\\/]+/).filter(Boolean);
    if (candidateSegments.length <= directorySegments.length) {
      return false;
    }

    return directorySegments.every((segment, index) => candidateSegments[index] === segment);
  }

  private looksLikeDirectoryPath(candidatePath: string): boolean {
    if (!candidatePath) {
      return false;
    }
    const trimmed = candidatePath.replace(/[\\/]+$/, '');
    return path.extname(trimmed) === '';
  }

  private normalizeComparableText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Aggregation helpers
  // -------------------------------------------------------------------------

  private aggregateCategories(events: ContextNoiseEvent[], totalNoiseTokens: number): ContextNoiseCategory[] {
    const eventMap = new Map<ContextNoiseCategoryKey, { tokens: number; callCount: number }>();
    for (const event of events) {
      if (!event.categoryKey) continue;
      const cur = eventMap.get(event.categoryKey) ?? { tokens: 0, callCount: 0 };
      cur.tokens += event.tokens;
      cur.callCount += 1;
      eventMap.set(event.categoryKey, cur);
    }
    return CATEGORY_ORDER.map((key) => {
      const meta = CATEGORY_META[key];
      const cur = eventMap.get(key) ?? { tokens: 0, callCount: 0 };
      const shareOfThreshold = meta.thresholdTokens > 0 ? cur.tokens / meta.thresholdTokens : 0;
      return {
        key, tool: meta.tool, label: meta.label,
        tokens: cur.tokens, callCount: cur.callCount,
        severity: this.resolveCategorySeverity(cur.tokens, cur.callCount, meta.thresholdTokens),
        thresholdTokens: meta.thresholdTokens, shareOfThreshold,
        shareOfNoise: totalNoiseTokens > 0 ? cur.tokens / totalNoiseTokens : 0,
      };
    }).sort((a, b) => b.tokens - a.tokens || b.callCount - a.callCount || a.label.localeCompare(b.label));
  }

  private buildFileHotspots(sessions: ParsedSession[]): ContextNoiseFileHotspot[] {
    const hotspotMap = new Map<string, { path: string; totalReads: number; tokensConsumed: number; fingerprints: Set<string> }>();
    for (const session of sessions) {
      for (const obs of session.observations) {
        if (obs.name.toLowerCase() !== 'read' || !obs.targetPath) continue;
        const displayPath = this.toDisplayPath(obs.targetPath);
        const fp = this.contentFingerprint(obs.resultContent) || `order:${obs.order}`;
        const cur = hotspotMap.get(displayPath) ?? { path: displayPath, totalReads: 0, tokensConsumed: 0, fingerprints: new Set<string>() };
        cur.totalReads += 1;
        cur.tokensConsumed += obs.estimatedTokens;
        cur.fingerprints.add(fp);
        hotspotMap.set(displayPath, cur);
      }
    }
    return Array.from(hotspotMap.values()).map((item) => {
      const uniqueReads = item.fingerprints.size;
      const dupReads = Math.max(0, item.totalReads - uniqueReads);
      return {
        path: item.path, totalReads: item.totalReads, uniqueReads, dupReads,
        tokensConsumed: item.tokensConsumed,
        heat: (dupReads >= 7 ? 'high' : dupReads >= 3 ? 'medium' : 'low') as ContextNoiseSeverity,
      };
    })
    .sort((a, b) => b.tokensConsumed - a.tokensConsumed || b.dupReads - a.dupReads || a.path.localeCompare(b.path))
    .slice(0, 12);
  }

  private buildSessionSummaries(sessions: ParsedSession[], events: ContextNoiseEvent[]): ContextNoiseSessionSummary[] {
    const eventMap = new Map<string, ContextNoiseEvent[]>();
    for (const event of events) {
      const arr = eventMap.get(event.sessionId) ?? [];
      arr.push(event);
      eventMap.set(event.sessionId, arr);
    }
    return sessions.map((session) => {
      const totalTokens = session.items.reduce((sum, item) => sum + item.tokenCount, 0);
      const sessionEvents = eventMap.get(session.sessionId) ?? [];
      const noiseTokens = sessionEvents.reduce((sum, e) => sum + e.tokens, 0);
      return {
        sessionId: session.sessionId, filePath: session.filePath,
        startTime: this.formatTimestamp(session.startTimestampMs),
        endTime: this.formatTimestamp(session.endTimestampMs),
        startTimestampMs: session.startTimestampMs, endTimestampMs: session.endTimestampMs,
        totalTokens, noiseTokens,
        noiseRatio: totalTokens > 0 ? noiseTokens / totalTokens : 0,
        totalToolCalls: session.observations.length,
        duplicateCalls: sessionEvents.filter((e) => e.tag === 'dup').length,
      };
    }).sort((a, b) => b.endTimestampMs - a.endTimestampMs || b.totalTokens - a.totalTokens);
  }

  private makeEvent(
    session: ParsedSession,
    obs: ToolObservation,
    args: {
      tool: ContextNoiseEvent['tool'];
      categoryKey?: ContextNoiseCategoryKey;
      target: string;
      tokens: number;
      tag: ContextNoiseTag;
      severity: ContextNoiseSeverity;
      reason: string;
      confidence: number;
    }
  ): ContextNoiseEvent {
    return {
      sessionId: session.sessionId, sessionFile: session.filePath,
      timestampMs: obs.timestampMs, timestampLabel: this.formatTimestamp(obs.timestampMs),
      tool: args.tool, categoryKey: args.categoryKey,
      target: args.target, tokens: args.tokens, tag: args.tag,
      severity: args.severity, reason: args.reason,
      confidence: Math.min(1, Math.max(0, args.confidence)),
      order: obs.order,
    };
  }

  // -------------------------------------------------------------------------
  // Content fingerprinting (improved)
  // -------------------------------------------------------------------------

  // Produces a fingerprint that is:
  //   - Robust to minor whitespace/formatting changes (normalizes whitespace)
  //   - Sensitive to actual content changes (uses head + tail + line count)
  // This avoids the old "full lowercase string" approach which was both slow
  // and too sensitive to trivial changes.
  private contentFingerprint(content: string): string {
    if (!content) return '';
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.length === 0) return '';
    const lineCount = (content.match(/\n/g) ?? []).length;
    const head = normalized.slice(0, 200);
    const tail = normalized.length > 200 ? normalized.slice(-200) : '';
    return `${lineCount}|${head}|${tail}`;
  }

  // -------------------------------------------------------------------------
  // isMissedSearch (improved)
  // -------------------------------------------------------------------------

  private isMissedSearch(resultContent: string): boolean {
    const normalized = resultContent.trim().toLowerCase();
    if (!normalized) return true;
    // Exact empty-structure matches
    if (normalized === '[]' || normalized === '{}' || normalized === 'null') return true;
    // Numeric zero patterns
    if (/\b0\s*(matches?|results?|files?|hits?|occurrences?)\b/.test(normalized)) return true;
    // Negative phrasing
    if (/\bno\s+(matches?|results?|files?\s+found|output|hits?|occurrences?)\b/.test(normalized)) return true;
    if (/\bnot\s+found\b/.test(normalized)) return true;
    if (/\bnothing\s+found\b/.test(normalized)) return true;
    if (/\bno\s+files\s+searched\b/.test(normalized)) return true;
    // Content that is only punctuation/brackets/whitespace
    if (/^[\s\[\]{},.:;()\-|]+$/.test(normalized)) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Utility methods (kept from original, minor cleanup)
  // -------------------------------------------------------------------------

  private resolveCategorySeverity(tokens: number, callCount: number, thresholdTokens: number): ContextNoiseSeverity {
    if (tokens >= thresholdTokens * 0.5 || callCount >= 6) return 'high';
    if (tokens >= thresholdTokens * 0.15 || callCount >= 2) return 'medium';
    return 'low';
  }

  private normalizeCommand(command: string): string {
    return command.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private isWithinDuplicateWindow(previous: ToolObservation, current: ToolObservation): boolean {
    if (previous.timestampMs > 0 && current.timestampMs > 0) {
      return current.timestampMs - previous.timestampMs <= DUPLICATE_LOOKBACK_MS;
    }
    return current.order - previous.order <= DUPLICATE_LOOKBACK_STEPS;
  }

  private sumTokensBetween(items: ContextItem[], startOrder: number, endOrder: number): number {
    return items.reduce((sum, item) => {
      if (item.order <= startOrder || item.order >= endOrder) return sum;
      return sum + item.tokenCount;
    }, 0);
  }

  private fmtTokens(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 tok';
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k tok`;
    return `${Math.round(value)} tok`;
  }

  private normalizePathKey(inputPath: string): string {
    return inputPath.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  }

  private toDisplayPath(inputPath: string): string {
    if (!inputPath) return '';
    return inputPath.replace(/\//g, path.sep);
  }

  private truncateCommand(value: string, maxLength: number = 72): string {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLength) return singleLine;
    return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private formatTimestamp(timestampMs: number): string {
    if (!timestampMs || !Number.isFinite(timestampMs)) return 'n/a';
    const date = new Date(timestampMs);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  private estimateEntryCount(resultContent: string): number {
    return resultContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).length;
  }

  private isDirectoryListingCommand(command: string, resultContent: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (/(^|\s)(ls|dir|tree|find|get-childitem)(\s|$)/i.test(normalized) || normalized.includes('rg --files')) return true;
    const entryCount = this.estimateEntryCount(resultContent);
    const looksLikePaths = resultContent.split(/\r?\n/).slice(0, 10)
      .filter((line) => /[\\/]/.test(line) || /\.[A-Za-z0-9]+$/.test(line.trim())).length;
    return entryCount >= 10 && looksLikePaths >= 6;
  }

  private isRootLikeScan(obs: ToolObservation): boolean {
    const command = obs.command.toLowerCase();
    const targetPath = this.normalizePathKey(obs.targetPath);
    const cwd = this.normalizePathKey(obs.cwd);
    if (!targetPath) return true;
    if (targetPath === '.' || targetPath === './' || targetPath === '.\\') return true;
    if (cwd && targetPath === cwd) return true;
    if (command.includes(' .') || command.includes(' "./') || command.includes(" '.\\")) return true;
    const relativeDepth = targetPath.replace(/^[a-z]:/i, '').split(/[\\/]+/).filter(Boolean).length;
    return relativeDepth <= 3;
  }

  private normalizeListingTarget(obs: ToolObservation): string {
    const target = obs.targetPath || obs.command || '.';
    return this.normalizeCommand(target) || '.';
  }

  private extractSearchTarget(input: Record<string, unknown>): string {
    return (
      this.getStringAtPaths(input, [['pattern'], ['query'], ['regex'], ['path'], ['file_path'], ['filePath']]) ??
      this.stringifyValue(input)
    );
  }

  private stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  private getStringAtPaths(payload: unknown, keyPaths: string[][]): string | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  private getValueAtPath(payload: unknown, keyPath: string[]): unknown {
    let current: unknown = payload;
    for (const key of keyPath) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }
}
