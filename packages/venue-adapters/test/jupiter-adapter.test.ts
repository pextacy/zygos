import { describe, expect, it } from 'vitest';
import { JupiterPredictAdapter, type MarketBinding } from '../src/jupiter/JupiterPredictAdapter.js';
import { FeedConfigError } from '../src/txline/errors.js';

// Translation/plumbing tests with an injected fetch. Live-response shape
// verification happens during the Day-1 liquidity gate (venue-selection.md).
const BINDINGS = new Map<string, MarketBinding>([
  ['mkt-home', { fixtureId: 'fx-1', market: { kind: '1X2' }, yesOutcome: 'HOME' }],
]);

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname + new URL(url).search;
    const key = `${init?.method ?? 'GET'} ${path}`;
    const hit = routes[key];
    if (hit === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('JupiterPredictAdapter', () => {
  it('refuses to construct without an API key', () => {
    expect(() => new JupiterPredictAdapter({ apiKey: '' })).toThrow(FeedConfigError);
  });

  it('maps positions to VenuePosition with payout-unit sizes and binding-resolved outcomes', async () => {
    const adapter = new JupiterPredictAdapter({
      apiKey: 'k',
      bindings: BINDINGS,
      fetchFn: fakeFetch({
        'GET /prediction/v1/positions?ownerPubkey=WALLET1111111111111111111111111111111111111': {
          positions: [
            { positionPubkey: 'P'.repeat(40), marketId: 'mkt-home', isYes: true, contracts: 10, entryPrice: 420000 },
            { positionPubkey: 'Q'.repeat(40), marketId: 'mkt-unknown', isYes: false, contracts: 3 },
          ],
        },
      }),
      baseUrl: 'https://api.jup.ag/prediction/v1',
    });

    const positions = await adapter.getPositions('WALLET1111111111111111111111111111111111111');
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      positionRef: 'P'.repeat(40),
      fixtureId: 'fx-1',
      outcome: 'HOME',
      size: 10_000_000n, // 10 contracts × $1 payout in micro-USD
      entryPrice: 420_000n,
    });
    // Unmapped market surfaces, flagged — never silently dropped.
    expect(positions[1]?.fixtureId).toBe('unmapped:mkt-unknown');
    expect(positions[1]?.outcome).toBe('NO');
  });

  it('scopes market routing to the fixture when several fixtures share a MarketKey', async () => {
    // Two bound fixtures, both 1X2/HOME: an unscoped lookup would take the
    // first map entry and quote (or order on!) the wrong match's market.
    const multi = new Map<string, MarketBinding>([
      ['mkt-a', { fixtureId: 'fx-1', market: { kind: '1X2' }, yesOutcome: 'HOME' }],
      ['mkt-b', { fixtureId: 'fx-2', market: { kind: '1X2' }, yesOutcome: 'HOME' }],
    ]);
    const adapter = new JupiterPredictAdapter({
      apiKey: 'k',
      bindings: multi,
      fetchFn: fakeFetch({
        'GET /prediction/v1/markets/mkt-a': { marketId: 'mkt-a', yesPrice: 580000, noPrice: 440000 },
        'GET /prediction/v1/markets/mkt-b': { marketId: 'mkt-b', yesPrice: 300000, noPrice: 720000 },
      }),
    });
    const quote = await adapter.getQuote({ kind: '1X2' }, 'NOT_HOME', 'BUY', 1_000_000n, 'fx-2');
    expect(quote.price).toBe(720_000n);
    await expect(adapter.getQuote({ kind: '1X2' }, 'NOT_HOME', 'BUY', 1_000_000n, 'fx-3')).rejects.toThrow(FeedConfigError);
  });

  it('quotes BUY of the complement side from live market pricing', async () => {
    const adapter = new JupiterPredictAdapter({
      apiKey: 'k',
      bindings: BINDINGS,
      fetchFn: fakeFetch({
        'GET /prediction/v1/markets/mkt-home': { marketId: 'mkt-home', yesPrice: 580000, noPrice: 440000 },
      }),
    });
    // Hedging a HOME (YES) holding means buying NOT_HOME (NO): ask = 440000.
    const quote = await adapter.getQuote({ kind: '1X2' }, 'NOT_HOME', 'BUY', 5_000_000n);
    expect(quote.price).toBe(440_000n);
  });

  it('buildHedgeTx buys the opposite side sized by the lock fraction', async () => {
    let captured: unknown;
    const adapter = new JupiterPredictAdapter({
      apiKey: 'k',
      bindings: BINDINGS,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/orders') && init?.method === 'POST') {
          captured = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ transaction: 'BASE64TX', estimatedFees: 1000 }), { status: 200 });
        }
        return new Response('nope', { status: 404 });
      }) as typeof fetch,
    });

    const tx = await adapter.buildHedgeTx(
      'WALLET',
      { positionRef: 'P', fixtureId: 'fx-1', market: { kind: '1X2' }, outcome: 'HOME', size: 10_000_000n, entryPrice: null },
      0.5,
      { market: { kind: '1X2' }, outcome: 'NOT_HOME', side: 'BUY', size: 5_000_000n, price: 440_000n, feeIncluded: false, asOf: 0 },
    );

    expect(tx.txBase64).toBe('BASE64TX');
    expect(captured).toMatchObject({
      ownerPubkey: 'WALLET',
      marketId: 'mkt-home',
      isYes: false, // holding YES → hedge buys NO
      isBuy: true,
      depositAmount: '2200000', // 5 contracts × 0.44 USD = $2.20 in micro-USD
    });
  });

  it('rejects hedges for unbound markets instead of guessing a marketId', async () => {
    const adapter = new JupiterPredictAdapter({ apiKey: 'k', fetchFn: fakeFetch({}) });
    await expect(
      adapter.getQuote({ kind: '1X2' }, 'HOME', 'BUY', 1_000_000n),
    ).rejects.toThrow(FeedConfigError);
  });
});
