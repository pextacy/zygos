import { describe, expect, it } from 'vitest';
import { JupiterPredictAdapter } from '@zygos/venue-adapters';
import { BindingRegistry, BindingValidationError, parseMarketKey } from '../src/bindings.js';
import { openDb } from '../src/db.js';
import type { FeedLogger, FeedService } from '../src/feed.js';
import { ValuationService } from '../src/valuation.js';

/**
 * Market binding registry: the persistent TxLINE fixture ↔ venue market
 * mapping. The venue adapter must see registry changes live (shared map,
 * no restart), and cached positions must re-map from UNMAPPED to valued
 * after an upsert + refresh.
 */

const silentLog: FeedLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function memoryRegistry(): Promise<BindingRegistry> {
  return BindingRegistry.open(await openDb('memory://'));
}

describe('parseMarketKey', () => {
  it('round-trips the marketKeyString formats and rejects junk', () => {
    expect(parseMarketKey('1X2')).toEqual({ kind: '1X2' });
    expect(parseMarketKey('TOTAL:2.5')).toEqual({ kind: 'TOTAL', line: 2.5 });
    expect(parseMarketKey('TOTAL:3')).toEqual({ kind: 'TOTAL', line: 3 });
    expect(parseMarketKey('MONEYLINE')).toBeNull();
    expect(parseMarketKey('TOTAL:')).toBeNull();
    expect(parseMarketKey('')).toBeNull();
  });
});

describe('BindingRegistry', () => {
  it('upserts, lists, overwrites and removes; live map tracks every change', async () => {
    const registry = await memoryRegistry();
    const rec = await registry.upsert({ marketId: 'mkt-1', fixtureId: 'fx-1', market: '1X2', yesOutcome: 'HOME', createdBy: 'W', nowMs: 1_000 });
    expect(rec).toMatchObject({ marketId: 'mkt-1', market: '1X2', yesOutcome: 'HOME', source: 'MANUAL' });

    expect(registry.map.get('mkt-1')).toEqual({ fixtureId: 'fx-1', market: { kind: '1X2' }, yesOutcome: 'HOME' });

    // Overwrite keeps one row and updates the live map in place.
    await registry.upsert({ marketId: 'mkt-1', fixtureId: 'fx-2', market: 'TOTAL:2.5', yesOutcome: 'OVER', createdBy: 'W', nowMs: 2_000 });
    expect(await registry.list()).toHaveLength(1);
    expect(registry.map.get('mkt-1')).toEqual({ fixtureId: 'fx-2', market: { kind: 'TOTAL', line: 2.5 }, yesOutcome: 'OVER' });

    expect(await registry.remove('mkt-1')).toBe(true);
    expect(await registry.remove('mkt-1')).toBe(false);
    expect(registry.map.size).toBe(0);
    expect(await registry.list()).toHaveLength(0);
  });

  it('persists across registry instances over the same database', async () => {
    const db = await openDb('memory://');
    await (await BindingRegistry.open(db)).upsert({ marketId: 'mkt-9', fixtureId: 'fx-9', market: '1X2', yesOutcome: 'AWAY', createdBy: 'W' });

    const reopened = await BindingRegistry.open(db);
    expect(reopened.map.get('mkt-9')).toEqual({ fixtureId: 'fx-9', market: { kind: '1X2' }, yesOutcome: 'AWAY' });
  });

  it('rejects malformed input with typed validation errors', async () => {
    const registry = await memoryRegistry();
    const base = { marketId: 'mkt-1', fixtureId: 'fx-1', market: '1X2', yesOutcome: 'HOME', createdBy: 'W' };
    await expect(registry.upsert({ ...base, marketId: '  ' })).rejects.toThrow(BindingValidationError);
    await expect(registry.upsert({ ...base, fixtureId: '' })).rejects.toThrow(BindingValidationError);
    await expect(registry.upsert({ ...base, market: 'HANDICAP' })).rejects.toThrow(BindingValidationError);
    // Outcome must match the market kind: no OVER on 1X2, no HOME on totals.
    await expect(registry.upsert({ ...base, yesOutcome: 'OVER' })).rejects.toThrow(BindingValidationError);
    await expect(registry.upsert({ ...base, market: 'TOTAL:2.5', yesOutcome: 'DRAW' })).rejects.toThrow(BindingValidationError);
    // Non-string JSON (route bodies are unvalidated JSON) must be a typed 400,
    // never a TypeError 500; oversized notes are bounded before persistence.
    await expect(registry.upsert({ ...base, fixtureId: 123 as unknown as string })).rejects.toThrow(BindingValidationError);
    await expect(registry.upsert({ ...base, yesOutcome: { $bad: true } as unknown as string })).rejects.toThrow(BindingValidationError);
    await expect(registry.upsert({ ...base, note: 'x'.repeat(501) })).rejects.toThrow(BindingValidationError);
    expect(await registry.list()).toHaveLength(0);
  });
});

// ---- live propagation into the venue adapter and valuation ----

const WALLET = 'WALLET1111111111111111111111111111111111111';

function positionsFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/positions')) {
      return new Response(
        JSON.stringify({ positions: [{ positionPubkey: 'P'.repeat(40), marketId: 'mkt-live', isYes: true, contracts: 10 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('binding changes reach the adapter without a restart', () => {
  it('getPositions maps via the registry map after upsert, and unmaps after remove', async () => {
    const registry = await memoryRegistry();
    const adapter = new JupiterPredictAdapter({ apiKey: 'k', bindings: registry.map, fetchFn: positionsFetch() });

    const before = await adapter.getPositions(WALLET);
    expect(before[0]?.fixtureId).toBe('unmapped:mkt-live');
    expect(before[0]?.outcome).toBe('YES');

    await registry.upsert({ marketId: 'mkt-live', fixtureId: 'fx-1', market: '1X2', yesOutcome: 'HOME', createdBy: 'W' });
    const after = await adapter.getPositions(WALLET);
    expect(after[0]).toMatchObject({ fixtureId: 'fx-1', outcome: 'HOME' });

    await registry.remove('mkt-live');
    const removed = await adapter.getPositions(WALLET);
    expect(removed[0]?.fixtureId).toBe('unmapped:mkt-live');
  });

  it('valuation goes UNMAPPED_OUTCOME → tracked fixture after binding + refreshAllWallets', async () => {
    const registry = await memoryRegistry();
    const adapter = new JupiterPredictAdapter({ apiKey: 'k', bindings: registry.map, fetchFn: positionsFetch() });
    const feedStub = { addListener: () => {} } as unknown as FeedService;
    const valuation = new ValuationService(adapter, feedStub, silentLog);

    await valuation.refreshPositions(WALLET);
    expect(valuation.unmappedMarketIds()).toEqual(['mkt-live']);
    expect(valuation.valueWallet(WALLET, [], Date.now())[0]?.state).toBe('UNMAPPED_OUTCOME'); // unmapped beats NO_CONSENSUS: it is the actionable state

    await registry.upsert({ marketId: 'mkt-live', fixtureId: 'fx-1', market: '1X2', yesOutcome: 'HOME', createdBy: 'W' });
    await valuation.refreshAllWallets();

    expect(valuation.unmappedMarketIds()).toEqual([]);
    const valued = valuation.valueWallet(WALLET, [], Date.now());
    expect(valued[0]?.position.fixtureId).toBe('fx-1');
    expect(valued[0]?.position.outcome).toBe('HOME');
  });
});
