import { disconnectDb, resetSongHongDraft } from './fixtures/db-reset.js';

/**
 * Runs once before the whole suite so a re-run of `pnpm test:e2e` (without a `pnpm compose:reset`
 * in between) starts from the same baseline as a fresh seed — not just the first run. Work-tab
 * tests reset again per-test (see fixtures/db-reset.ts); this covers every other spec that reads
 * Song Hong Shipping's draft/tier-history state, regardless of file run order.
 */
export default async function globalSetup(): Promise<void> {
  await resetSongHongDraft();
  await disconnectDb();
}
