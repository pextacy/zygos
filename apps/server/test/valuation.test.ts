import { describe, expect, it } from 'vitest';
import type { ConsensusSnapshot } from '@zygos/core';
import type { VenueAdapter, VenuePosition } from '@zygos/venue-adapters';
import { ValuationService, type ValuedPosition } from '../src/valuation.js';
import type { FeedLogger, FeedService } from '../src/feed.js';

const T0 = 1_700_000_000_000;

const silentLog: FeedLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeFeed() {
  const listeners: Array<{ onConsensus?: (s: ConsensusSnapshot) => void }> = [];
  return {
    feed: { addListener: (l: { onConsensus?: (s: ConsensusSnapshot) => void }) => listeners.push(l) } as unknown as FeedService,
    emit: (s: ConsensusSnapshot) => listeners.forEach((l) => l.onConsensus?.(s)),
  };
}

function fakeVenue(positions: VenuePosition[]): VenueAdapter {
  return {
    venueId: 'test-venue',
    cluster: 'devnet',
    getPositions: async () => positions,
    getQuote: async () => {
      throw new Error('not used');
    },
    buildHedgeTx: async () => {
      throw new Error('not used');
    },
  };
}

const POSITION: VenuePosition = {
  positionRef: 'pos-1',
  fixtureId: 'fx-1',
  market: { kind: '1X2' },
  outcome: 'HOME',
  size: 10_000_000n,
  entryPrice: 420_000n,
};

function snap(prob: number, asOf: number): ConsensusSnapshot {
  return {
    fixtureId: 'fx-1',
    market: { kind: '1X2' },
    probs: { HOME: prob, DRAW: (1 - prob) / 2, AWAY: (1 - prob) / 2 },
    bookCount: 3,
    confidence: 'OK',
    excludedBookIds: [],
    packetIds: ['pkt-9'],
    asOf,
  };
}

describe('ValuationService (T1.6)', () => {
  it('values wallet positions against fresh consensus (fair = size × prob)', async () => {
    const { feed } = fakeFeed();
    const service = new ValuationService(fakeVenue([POSITION]), feed, silentLog);
    await service.refreshPositions('WALLET');

    const [valued] = service.valueWallet('WALLET', [snap(0.6, T0)], T0 + 1_000);
    expect(valued?.state).toBe('OK');
    expect(valued?.valuation?.fairValue).toBe('6000000');
    expect(valued?.valuation?.consensusProb).toBe(0.6);
    expect(valued?.valuation?.packetIds).toEqual(['pkt-9']);
  });

  it('reports STALE past the 30s threshold and NO_CONSENSUS when the market is missing — never a frozen number', async () => {
    const { feed } = fakeFeed();
    const service = new ValuationService(fakeVenue([POSITION]), feed, silentLog);
    await service.refreshPositions('WALLET');

    const [stale] = service.valueWallet('WALLET', [snap(0.6, T0)], T0 + 31_000);
    expect(stale?.state).toBe('STALE');
    expect(stale?.valuation).toBeNull();

    const [none] = service.valueWallet('WALLET', [], T0);
    expect(none?.state).toBe('NO_CONSENSUS');
    expect(none?.valuation).toBeNull();
  });

  it('flags positions with non-domain outcomes as UNMAPPED_OUTCOME', async () => {
    const { feed } = fakeFeed();
    const service = new ValuationService(fakeVenue([{ ...POSITION, outcome: 'YES' }]), feed, silentLog);
    await service.refreshPositions('WALLET');
    const [valued] = service.valueWallet('WALLET', [snap(0.6, T0)], T0);
    expect(valued?.state).toBe('UNMAPPED_OUTCOME');
  });

  it('pushes re-valuations to listeners on matching consensus updates only', async () => {
    const { feed, emit } = fakeFeed();
    const service = new ValuationService(fakeVenue([POSITION]), feed, silentLog);
    await service.refreshPositions('WALLET');

    const received: ValuedPosition[] = [];
    service.addListener({ wallet: 'WALLET', onValuation: (v) => received.push(v) });
    await Promise.resolve(); // let addListener's refresh settle

    emit(snap(0.55, Date.now()));
    expect(received).toHaveLength(1);
    expect(received[0]?.state).toBe('OK');

    emit({ ...snap(0.55, Date.now()), fixtureId: 'fx-OTHER' });
    expect(received).toHaveLength(1); // unrelated fixture: no push
  });
});
