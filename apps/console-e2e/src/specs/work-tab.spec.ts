import { disconnectDb, resetSongHongDraft } from '../fixtures/db-reset.js';
import { expect, openAccountFromQueue, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Account Detail, Work tab (draft review, Tier 2)
//
// TC-WORK-1/2/3 all act on Song Hong Shipping's one seeded pending-review draft and are mutually
// exclusive against it in a human UAT pass ("known gap 4"). This suite resets that one draft back
// to its seed-time state before each test (see fixtures/db-reset.ts) so all three run in the same
// pass without a full `pnpm compose:reset`.

test.beforeEach(async () => {
  await resetSongHongDraft();
});

test.afterAll(async () => {
  await disconnectDb();
});

test('TC-WORK-1 — Approve a draft as-is (golden path)', async ({ reviewerPage }) => {
  await openAccountFromQueue(reviewerPage, 'Song Hong Shipping');

  await expect(reviewerPage.getByText('MV Song Hong Pioneer')).toBeVisible();
  await reviewerPage.getByRole('button', { name: 'Approve & send' }).click();

  await expect(reviewerPage.getByText('Approved · sending')).toBeVisible();
});

test('TC-WORK-2 — An edited draft is flagged as not counting toward Clean Approval (edge case)', async ({
  reviewerPage,
}) => {
  await openAccountFromQueue(reviewerPage, 'Song Hong Shipping');

  await reviewerPage.getByRole('button', { name: 'Edit' }).click();
  await reviewerPage
    .locator('textarea.draft-edit')
    .fill('Hi Ms. Pham, following up on the life-raft service window for MV Song Hong Pioneer.');
  await reviewerPage.getByRole('button', { name: 'Save changes' }).click();

  await expect(
    reviewerPage.getByText(
      "Edited by a human. This send will not count toward the account's clean-approval progress.",
    ),
  ).toBeVisible();

  await reviewerPage.getByRole('button', { name: 'Approve & send' }).click();
  await expect(reviewerPage.getByText('Approved · sending')).toBeVisible();
});

test('TC-WORK-3 — Reject a draft', async ({ reviewerPage }) => {
  await openAccountFromQueue(reviewerPage, 'Song Hong Shipping');

  await reviewerPage.getByRole('button', { name: 'Reject' }).click();

  await expect(reviewerPage.getByText('Rejected — returned to the agent, not sent')).toBeVisible();
});
