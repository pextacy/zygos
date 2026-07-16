/**
 * Server frame/DTO shapes (apps/server is the source of truth; web talks
 * HTTP/WS only — no workspace imports, DOCS.md §2).
 */

export type OutcomeKey = 'HOME' | 'DRAW' | 'AWAY' | 'OVER' | 'UNDER';
export type FeedState = 'LIVE' | 'DEGRADED' | 'STALE';

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
  plan: SerializedPlan;
  unsignedTxBase64: string;
  packetIds: string[];
  consensusAsOf: number;
  simulated: boolean;
}

export interface RuleFiredFrame {
  type: 'RULE_FIRED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: 'GOAL_LOCK' | 'RED_CARD_REDUCE';
  event: MatchEventDto;
  preview: HedgePreviewDto;
  latencyMs: number;
}

export interface RuleDto {
  id: string;
  wallet: string;
  positionRef: string;
  fixtureId: string;
  team: 'HOME' | 'AWAY';
  template: 'GOAL_LOCK' | 'RED_CARD_REDUCE';
  fractionPpm: number;
  createdAt: number;
  intentHash: string;
}

export interface RuleExecutedFrame {
  type: 'RULE_EXECUTED';
  ruleId: string;
  wallet: string;
  positionRef: string;
  template: 'GOAL_LOCK' | 'RED_CARD_REDUCE';
  event: MatchEventDto;
  signature: string;
  latencyMs: number;
}

export type ServerFrame =
  | { type: 'HELLO'; serverTime: number }
  | { type: 'SUBSCRIBED'; fixtureIds: string[] }
  | { type: 'ERROR'; code: string; detail?: string }
  | ConsensusFrame
  | EventFrame
  | FeedHealthFrame
  | ValuationFrame
  | RuleFiredFrame
  | RuleExecutedFrame;

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: 'lock' | 'rule' | 'feed' | 'event' | 'error' | 'info';
  text: string;
}
