import type { ConsensusSnapshot, MatchEvent } from './types.js';

/**
 * Event inference from consensus discontinuities (DOCS.md §6) — the fallback
 * when the feed tier lacks an explicit event stream. 100% real data: a large,
 * sustained jump in consensus win probability during live play is the odds
 * market reacting to a scoring event.
 *
 * Trigger: |ΔP(outcome)| ≥ JUMP_THRESHOLD within WINDOW_MS, sustained for
 * ≥ SUSTAIN_TICKS consecutive snapshots. A jump UP in HOME win probability
 * classifies as GOAL(HOME), symmetrically for AWAY. Inferred events carry
 * `inferred: true` and are visually tagged in the UI.
 */

/** 8 probability points: comfortably above in-play drift, below any goal move in a 1X2 market. */
export const JUMP_THRESHOLD = 0.08;
/** Baseline lookback: goals reprice across books well inside a minute. */
export const WINDOW_MS = 60_000;
/** Two consecutive confirming snapshots filter single-book blips that survive the outlier guard. */
export const SUSTAIN_TICKS = 2;

interface OutcomeTrack {
  /** Rolling (ts, prob) history within WINDOW_MS. */
  history: Array<{ ts: number; prob: number }>;
  /** Consecutive snapshots confirming the current jump candidate. */
  sustainedCount: number;
  direction: 1 | -1 | 0;
  /** Suppress duplicate emissions for the same move. */
  lastEmittedAt: number | null;
}

export interface InferenceState {
  tracks: Map<string, OutcomeTrack>; // key: fixtureId|outcome
}

export function createInferenceState(): InferenceState {
  return { tracks: new Map() };
}

/**
 * Fold one 1X2 consensus snapshot; returns an inferred event when a sustained
 * jump is detected. Pure: state in, state mutated deterministically, no clock.
 */
export function inferFromSnapshot(state: InferenceState, snap: ConsensusSnapshot): MatchEvent | null {
  if (snap.market.kind !== '1X2') return null;

  let emitted: MatchEvent | null = null;
  for (const outcome of ['HOME', 'AWAY'] as const) {
    const prob = snap.probs[outcome];
    if (prob === undefined) continue;
    const key = `${snap.fixtureId}|${outcome}`;
    const track = state.tracks.get(key) ?? { history: [], sustainedCount: 0, direction: 0 as const, lastEmittedAt: null };

    track.history.push({ ts: snap.asOf, prob });
    while (track.history.length > 0 && snap.asOf - (track.history[0] as { ts: number }).ts > WINDOW_MS) {
      track.history.shift();
    }

    const baseline = track.history[0] as { ts: number; prob: number };
    const delta = prob - baseline.prob;
    const direction = delta >= JUMP_THRESHOLD ? 1 : delta <= -JUMP_THRESHOLD ? -1 : 0;

    if (direction === 0) {
      track.sustainedCount = 0;
      track.direction = 0;
    } else if (direction === track.direction) {
      track.sustainedCount += 1;
    } else {
      track.direction = direction;
      track.sustainedCount = 1;
    }

    const alreadyEmittedForThisMove = track.lastEmittedAt !== null && snap.asOf - track.lastEmittedAt < WINDOW_MS;
    // Only an upward jump for a side is a goal FOR that side; downward jumps
    // are the mirror of the other side's rise and would double-report.
    if (direction === 1 && track.sustainedCount >= SUSTAIN_TICKS && !alreadyEmittedForThisMove && emitted === null) {
      emitted = {
        packetId: `inferred:${snap.fixtureId}:${outcome}:${snap.asOf}`,
        sourceTs: snap.asOf,
        fixtureId: snap.fixtureId,
        type: 'GOAL',
        team: outcome,
        inferred: true,
      };
      track.lastEmittedAt = snap.asOf;
      track.history = [{ ts: snap.asOf, prob }]; // reset baseline post-event
      track.sustainedCount = 0;
      track.direction = 0;
    }

    state.tracks.set(key, track);
  }
  return emitted;
}
