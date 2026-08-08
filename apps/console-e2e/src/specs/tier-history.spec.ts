import { expect, openAccountFromQueue, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Account Detail, Tier history tab

test('TC-HIST-1 — Tier history timeline renders Song Hong Shipping’s clean-approval event', async ({
  reviewerPage,
}) => {
  await openAccountFromQueue(reviewerPage, 'Song Hong Shipping');
  await reviewerPage.getByRole('button', { name: 'Tier history' }).click();

  const timeline = reviewerPage.locator('[data-od-id="audit-timeline"]');
  await expect(timeline).toContainText('Clean approval recorded');
  await expect(timeline).toContainText('First outreach approved without edits — clean approval 1 of 2');
  await expect(timeline.locator('[data-od-id="manual-tag"]')).toHaveCount(0);
});
