import { expect, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Queue (QueuePage)

test('TC-QUEUE-1 — The pending-draft row is visible and actionable', async ({ reviewerPage }) => {
  const row = reviewerPage.getByRole('button').filter({ hasText: 'Song Hong Shipping' });

  await expect(row).toContainText('Song Hong Shipping');
  await expect(row).toContainText('MV Song Hong Pioneer');
  await expect(row).toContainText('Ms. Lan Pham');
  await expect(row).toContainText('High fit');
  await expect(row).toContainText('Tier 2');
  await expect(row).toContainText('New account — Tier 2 minimum until 2 clean approvals (1 of 2)');

  await row.click();

  await expect(reviewerPage.getByRole('button', { name: 'Draft review' })).toBeVisible();
});

test('TC-QUEUE-2 — Accounts without a pending draft do not appear in the queue', async ({
  reviewerPage,
}) => {
  const rows = reviewerPage.getByRole('button').filter({ hasText: /Shipping|Marine|Supply/ });

  await expect(rows).toHaveCount(1);
  await expect(reviewerPage.getByText('Truong Phat Marine')).toHaveCount(0);
  await expect(reviewerPage.getByText('Dai Duong Shipping')).toHaveCount(0);
  await expect(reviewerPage.getByText('Vina Offshore Supply')).toHaveCount(0);
});
