import type { ActivityEntry, ConsensusFrame, FeedState, MatchEventDto, OutcomeKey, RuleFiredFrame, ValuedPositionDto } from './types';

/** One observed consensus sample; accumulated per market over the session (real frames only). */
export interface HistoryPoint {
  asOf: number;
  probs: Partial<Record<OutcomeKey, number>>;
}

const HISTORY_CAP = 240;

/** Terminal state, reduced from server frames (client-only, in-memory — no browser storage, FR-41). */
export interface TerminalState {
  connected: boolean;
  /** True once the socket has opened at least once — distinguishes the initial "Connecting…" from a "reconnecting" drop. */
  everConnected: boolean;
  consensus: Map<string, ConsensusFrame>; // `${fixtureId}|${market}`
  history: Map<string, HistoryPoint[]>; // `${fixtureId}|${market}` → session timeline
  feedStates: Map<string, FeedState>; // fixtureId
  positions: Map<string, ValuedPositionDto>; // positionRef
  events: MatchEventDto[];
  activity: ActivityEntry[];
  pendingRuleFire: RuleFiredFrame | null;
  subscribedFixtures: string[];
  /** Bumped on RULE_FIRED/RULE_EXECUTED so rule views can refetch. */
  ruleActivitySeq: number;
  /** Bumped only on RULE_EXECUTED — the sole rule frame that writes a ledger row, so only it should refetch lock history. */
  ruleExecutedSeq: number;
  /** Local clock minus server clock from the WS HELLO frame; null before first connect. */
  clockSkewMs: number | null;
}

export const initialState: TerminalState = {
  connected: false,
  everConnected: false,
  consensus: new Map(),
  history: new Map(),
  feedStates: new Map(),
  positions: new Map(),
  events: [],
  activity: [],
  pendingRuleFire: null,
  subscribedFixtures: [],
  ruleActivitySeq: 0,
  ruleExecutedSeq: 0,
  clockSkewMs: null,
};

export type Action =
  | { type: 'socket'; connected: boolean }
  | { type: 'hello'; serverTime: number }
  | { type: 'consensus'; frame: ConsensusFrame }
  | { type: 'feedHealth'; fixtureId: string; state: FeedState }
  | { type: 'valuation'; dto: ValuedPositionDto }
  | { type: 'positions'; list: ValuedPositionDto[] }
  | { type: 'event'; event: MatchEventDto }
  | { type: 'ruleFired'; frame: RuleFiredFrame }
  | { type: 'ruleExecuted'; frame: import('./types').RuleExecutedFrame }
  | { type: 'dismissRuleFire' }
  | { type: 'subscribed'; fixtureIds: string[] }
  | { type: 'log'; kind: ActivityEntry['kind']; text: string };

let logSeq = 0;

export function reducer(state: TerminalState, action: Action): TerminalState {
  switch (action.type) {
    case 'socket':
      return { ...state, connected: action.connected, everConnected: state.everConnected || action.connected };
    case 'hello':
      return { ...state, clockSkewMs: Date.now() - action.serverTime };
    case 'consensus': {
      const key = `${action.frame.fixtureId}|${action.frame.market}`;
      const consensus = new Map(state.consensus);
      consensus.set(key, action.frame);
      const history = new Map(state.history);
      const line = history.get(key) ?? [];
      if (line.length === 0 || line[line.length - 1]!.asOf !== action.frame.asOf) {
        history.set(key, [...line, { asOf: action.frame.asOf, probs: action.frame.probs }].slice(-HISTORY_CAP));
      }
      return { ...state, consensus, history };
    }
    case 'feedHealth': {
      const previous = state.feedStates.get(action.fixtureId);
      const feedStates = new Map(state.feedStates);
      feedStates.set(action.fixtureId, action.state);
      const next = { ...state, feedStates };
      // Only log genuine feed faults (STALE/DEGRADED after being live). PENDING
      // is the benign "no odds yet" state and must not spam the activity log.
      if (previous !== action.state && (action.state === 'STALE' || action.state === 'DEGRADED')) {
        return reducer(next, { type: 'log', kind: 'feed', text: `feed ${action.state.toLowerCase()} for fixture ${action.fixtureId}` });
      }
      return next;
    }
    case 'valuation': {
      const positions = new Map(state.positions);
      positions.set(action.dto.position.positionRef, action.dto);
      return { ...state, positions };
    }
    case 'positions': {
      const positions = new Map<string, ValuedPositionDto>();
      for (const dto of action.list) positions.set(dto.position.positionRef, dto);
      return { ...state, positions };
    }
    case 'event': {
      const events = [action.event, ...state.events].slice(0, 50);
      const team = action.event.team ? ` (${action.event.team})` : '';
      const tag = action.event.inferred ? ' ⚡ inferred from odds move' : '';
      return reducer({ ...state, events }, { type: 'log', kind: 'event', text: `${action.event.type}${team} in ${action.event.fixtureId}${tag}` });
    }
    case 'ruleFired':
      return reducer(
        { ...state, pendingRuleFire: action.frame, ruleActivitySeq: state.ruleActivitySeq + 1 },
        { type: 'log', kind: 'rule', text: `rule ${action.frame.template} fired (${action.frame.latencyMs}ms after trigger, packet ${action.frame.event.packetId})` },
      );
    case 'ruleExecuted':
      return reducer({ ...state, ruleActivitySeq: state.ruleActivitySeq + 1, ruleExecutedSeq: state.ruleExecutedSeq + 1 }, {
        type: 'log',
        kind: 'lock',
        text: `⚡ delegated rule EXECUTED on-chain: ${action.frame.template} → ${action.frame.signature} (${action.frame.latencyMs}ms after trigger)`,
      });
    case 'dismissRuleFire':
      return { ...state, pendingRuleFire: null };
    case 'subscribed':
      return { ...state, subscribedFixtures: [...new Set([...state.subscribedFixtures, ...action.fixtureIds])] };
    case 'log':
      return {
        ...state,
        activity: [{ id: `a${logSeq++}`, ts: Date.now(), kind: action.kind, text: action.text }, ...state.activity].slice(0, 100),
      };
    default:
      return state;
  }
}
