/**
 * `unmapped:<marketId>` is the server's marker on `position.fixtureId` for a
 * venue market with no TxLINE binding yet. Mirrors UNMAPPED_FIXTURE_PREFIX in
 * packages/venue-adapters/src/types.ts — the web cannot import that package
 * (it talks to the server over HTTP only), so the contract is spelled once
 * per side, here for every web consumer.
 */
const UNMAPPED_FIXTURE_PREFIX = 'unmapped:';

/** The venue marketId inside an `unmapped:` fixtureId, or null for a mapped position. */
export function unmappedMarketIdOf(fixtureId: string): string | null {
  return fixtureId.startsWith(UNMAPPED_FIXTURE_PREFIX) ? fixtureId.slice(UNMAPPED_FIXTURE_PREFIX.length) : null;
}
