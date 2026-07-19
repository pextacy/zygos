/**
 * Server frame/DTO shapes (apps/server is the source of truth; web talks
 * HTTP/WS only — no workspace imports, DOCS.md §2).
 */

export type OutcomeKey = 'HOME' | 'DRAW' | 'AWAY' | 'OVER' | 'UNDER';
/** PENDING = subscribed but no odds yet (pre-match/idle) — benign; STALE = was live, then went stale (a fault). */
export type FeedState = 'LIVE' | 'DEGRADED' | 'STALE' | 'PENDING';

export interface ConsensusFrame {
  type: 'CONSENSUS';
  fixtureId: string;
  market: string;
  probs: Partial<Record<OutcomeKey, number>>;
  bookCount: number;
  confidence: 'OK' | 'LOW_CONFIDENCE';
  packetIds: string[];
  asOf: number;
}

export interface MatchEventDto {
  packetId: string;
  sourceTs: number;
  fixtureId: string;
  type: 'GOAL' | 'RED_CARD' | 'KICKOFF' | 'HT' | 'FT';
  team: 'HOME' | 'AWAY' | null;
  inferred: boolean;
}

export interface EventFrame {
  type: 'EVENT';
  event: MatchEventDto;
}

export interface FeedHealthFrame {
  type: 'FEED_HEALTH';
  fixtureId: string;
  state: FeedState;
}

export interface ValuedPositionDto {
  position: {
    positionRef: string;
    fixtureId: string;
    market: string;
    outcome: string;
    size: string;
    entryPrice: string | null;
  };
  state: 'OK' | 'STALE' | 'NO_CONSENSUS' | 'UNMAPPED_OUTCOME';
  valuation: {
    fairValue: string;
    markValue: string | null;
    lagDelta: string | null;
    consensusProb: number;
    feedAgeMs: number;
    packetIds: string[];
  } | null;
}

export type ValuationFrame = { type: 'VALUATION' } & ValuedPositionDto;

export interface SerializedPlan {
  viable: boolean;
  reason?: string;
  route: 'CLOSE' | 'HEDGE';
  hedgeSize: string;
  cost: string;
  proceeds: string;
  guaranteedFloor: string;
  retainedUpside: string;
  impliedExitProb: number;
  edgePts: number;
  payoutMatrix: Array<{ outcome: string; total: string }>;
}

export interface HedgePreviewDto {
  /** Server-side handle — echoed to /hedge/confirm so the lock ledger records the signed plan. */
  previewId: string;
  plan: SerializedPlan;
  unsignedTxBase64: string;
  packetIds: string[];
  consensusAsOf: number;
  simulated: boolean;
}

/** GET /locks/:wallet — one verified executed lock (plan fields null for delegated submissions). */
export interface LockRecordDto {
  id: string;
  wallet: string;
  positionRef: string;
  fixtureId: string;
  market: string;
  outcome: string;
  fractionPpm: number;
  route: 'CLOSE' | 'HEDGE' | null;
  guaranteedFloor: string | null;
  edgePts: number | null;
  impliedExitProb: number | null;
  packetIds: string[];
  consensusAsOf: number | null;
  txSig: string | null;
  /** Signature of the on-chain memo commitment (FR-33), once attached. */
  memoSig: string | null;
  source: 'MANUAL' | 'RULE' | 'DELEGATED';
  ruleId: string | null;
  sizeBefore: string | null;
  sizeAfter: string | null;
  executedAt: number;
}

export interface LockStatsDto {
  count: number;
  totalGuaranteedFloor: string;
  avgEdgePts: number | null;
  positiveEdgeCount: number;
  lastLockAt: number | null;
}

export type RuleTemplate = 'GOAL_LOCK' | 'RED_CARD_REDUCE' | 'PRICE_LOCK';
export type PriceDirection = 'ABOVE' | 'BELOW';

/** PRICE_LOCK trigger: the consensus tick that crossed the armed threshold. */
export interface PriceTriggerDto {
  type: 'PRICE_CROSS';
  packetId: string;
  sourceTs: number;
  fixtureId: string;
  outcome: 'HOME' | 'AWAY';
  prob: number;
  threshold: number;
  direction: PriceDirection;
}

export type RuleTriggerDto = MatchEventDto | PriceTriggerDto;

export interface RuleFiredFrame {
  type: 'RULE_FIRED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  event: RuleTriggerDto;
  preview: HedgePreviewDto;
  latencyMs: number;
}

export interface RuleDto {
  id: string;
  wallet: string;
  positionRef: string;
  fixtureId: string;
  team: 'HOME' | 'AWAY';
  template: RuleTemplate;
  fractionPpm: number;
  /** PRICE_LOCK only: consensus-probability threshold in ppm of 1.0. */
  thresholdPpm: number | null;
  direction: PriceDirection | null;
  /** PRICE_LOCK is one-shot: non-null once it has fired. */
  firedAt: number | null;
  createdAt: number;
  intentHash: string;
  /** Present on GET /rules/:wallet — null means prompt-based (no pre-signed tx). */
  delegation?: { status: 'armed' | 'submitted' | 'failed' | string; submittedSig: string | null } | null;
}

export interface RuleExecutedFrame {
  type: 'RULE_EXECUTED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: RuleTemplate;
  event: RuleTriggerDto;
  signature: string;
  latencyMs: number;
}

export type ServerFrame =
  | { type: 'HELLO'; serverTime: number }
  | { type: 'SUBSCRIBED'; fixtureIds: string[] }
  | { type: 'ERROR'; code: string; detail?: string }
  | { type: 'NOTICE'; code: string; detail?: string }
  | ConsensusFrame
  | EventFrame
  | FeedHealthFrame
  | ValuationFrame
  | RuleFiredFrame
  | RuleExecutedFrame;

/** GET /healthz: server diagnostics — feed link, RPC, TxLINE config, DB. */
export interface HealthDto {
  status: 'ok' | 'feed-not-configured';
  feed: { connected: boolean; streaming?: boolean; lastTickAgeMs: Record<string, number>; states?: Record<string, FeedState> };
  rpc: { configured: boolean; cluster: string };
  txline: { configured: boolean; origin?: string };
  db: { configured: boolean };
}

/** GET /fixtures: server-side subscribed fixtures with their latest consensus snapshots. */
export interface FixtureDto {
  fixtureId: string;
  state: FeedState;
  markets: Array<{
    market: string;
    probs: Partial<Record<OutcomeKey, number>>;
    bookCount: number;
    confidence: 'OK' | 'LOW_CONFIDENCE';
    packetIds: string[];
    asOf: number;
  }>;
}

/** GET /bindings — one TxLINE fixture ↔ venue market mapping. */
export interface MarketBindingDto {
  marketId: string;
  fixtureId: string;
  market: string;
  yesOutcome: string;
  source: 'MANUAL' | 'MATCHED';
  note: string | null;
  createdBy: string;
  createdAt: number;
}

/** GET /bindings/candidates — inputs for the binding form, all real session data. */
export interface BindingCandidatesDto {
  unmappedMarketIds: string[];
  fixtures: string[];
  markets: Array<{ fixtureId: string; market: string }>;
}

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: 'lock' | 'rule' | 'feed' | 'event' | 'error' | 'info';
  text: string;
}
