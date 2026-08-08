import { expect, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Send Audit (SendAuditPage)
//
// TC-AUDIT-1 tests the real, current, correct behavior — the empty state — per "known gap 3":
// no seed account has reached Tier 1, so `AuditSample` rows (what a real "sampled sends visible"
// case needs) can't exist yet. Getting there requires 2 clean approvals plus the Tier 1 promotion
// path, which is a seed-data change out of scope for this ticket.

test('TC-AUDIT-1 — Empty state, correctly, since no account has reached Tier 1', async ({
  reviewerPage,
}) => {
  await reviewerPage.getByRole('button', { name: 'Send Audit' }).click();

  await expect(
    reviewerPage.getByText(
      'No sampled sends yet. Sampling starts once Tier 1 accounts send autonomously — until then this queue stays empty by design, not broken.',
    ),
  ).toBeVisible();
  await expect(reviewerPage.getByRole('button', { name: 'All' })).toHaveCount(0);
});
