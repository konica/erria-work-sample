import { expect, openAccountFromQueue, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Account Detail, Account info tab (Ticket #117 — 77, Ticket #136)

test.beforeEach(async ({ reviewerPage }) => {
  await openAccountFromQueue(reviewerPage, 'Song Hong Shipping');
});

test('TC-INFO-1 — Trust block and ICP fit meter render for the queue’s pending draft', async ({
  reviewerPage,
}) => {
  await reviewerPage.getByRole('button', { name: 'Account info' }).click();

  const info = reviewerPage.locator('[data-od-id="detail-info"]');
  const trustBlock = reviewerPage.locator('[data-od-id="trust-block"]');

  await expect(trustBlock).toContainText('Can I trust this trigger?');
  await expect(trustBlock).toContainText('Moderate');
  await expect(trustBlock).toContainText(
    'the 12-month service interval is illustrative, not a confirmed SOLAS figure',
  );

  await expect(info).toContainText('High fit');
  await expect(info).toContainText('82 / 100');
  await expect(info).toContainText('Offshore support vessel operator');
  await expect(info).toContainText('Haiphong');
  await expect(info).toContainText('MV Song Hong Pioneer · IMO 9482137 · Vietnam');
  await expect(info).toContainText('Ms. Lan Pham');
  await expect(info).toContainText('New account · first contact 12 Jul 2026 · 1 prior message');
  await expect(info).toContainText('Tier 2');
  await expect(info).toContainText('New account — Tier 2 minimum until 2 clean approvals (1 of 2)');
});
