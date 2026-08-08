import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @erria/db's client reads `process.env.DATABASE_URL` at import time (see `packages/db/src/client.ts`),
// so .env must be loaded before the first import of '@erria/db' — same ordering `seed.ts` uses.
// `process.loadEnvFile` is a Node >=20.6 built-in (this workspace requires >=24), so no extra
// dependency is needed just to read one file.
try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const { prisma } = await import('@erria/db');

const SONG_HONG_EXTERNAL_REF = 'seed-song-hong-shipping';

const ORIGINAL_DRAFT_BODY =
  "Hi Ms. Pham, I hope this finds you well. Based on publicly available vessel " +
  "particulars, it looks like MV Song Hong Pioneer's life-raft equipment may be " +
  'approaching a typical service interval. If it would help, we’d be glad to check ' +
  "availability at our Vung Tau station and share a few dates — no obligation, just " +
  "flagging it in case it's useful for your maintenance planning.";

const ORIGINAL_TIER_RATIONALE = 'New account — Tier 2 minimum until 2 clean approvals (1 of 2)';
const CLEAN_APPROVAL_REASON = 'First outreach approved without edits — clean approval 1 of 2';

/**
 * TC-WORK-1/2/3 (docs/qa/uat-test-cases.md, "known gap 4") each act on Song Hong Shipping's one
 * seeded pending-review draft and are mutually exclusive against it — a human UAT pass plans one
 * full reseed per case. Re-running `pnpm --filter @erria/db run seed` doesn't work either: it's an
 * idempotency-refusing seed that no-ops once the account's `externalRef` exists.
 *
 * For automation this suite instead resets just Song Hong Shipping's mutable rows straight to
 * their seed-time values before each Work-tab test, via direct Prisma access rather than the UI —
 * restoring the one thing `pnpm compose:reset` would give a human tester, without the ~10s
 * container-recreate cost on every test.
 */
export async function resetSongHongDraft(): Promise<void> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { externalRef: SONG_HONG_EXTERNAL_REF },
  });

  await prisma.$transaction(async (tx) => {
    await tx.account.update({
      where: { id: account.id },
      data: { cleanApprovalsCount: 1, tierRationale: ORIGINAL_TIER_RATIONALE },
    });

    await tx.tierHistoryEvent.deleteMany({
      where: { accountId: account.id, eventType: { not: 'clean_approval' } },
    });
    await tx.tierHistoryEvent.updateMany({
      where: { accountId: account.id, eventType: 'clean_approval' },
      data: { reason: CLEAN_APPROVAL_REASON },
    });

    await tx.message.updateMany({
      where: { accountId: account.id, role: 'agent_draft' },
      data: {
        body: ORIGINAL_DRAFT_BODY,
        originalBody: null,
        edited: false,
        status: 'pending_review',
        decidedBy: null,
        decidedAt: null,
        sentAt: null,
      },
    });
  });
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
