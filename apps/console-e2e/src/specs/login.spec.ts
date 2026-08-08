import { loginAs } from '../fixtures/auth.js';
import { env, expect, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Login

test('TC-LOGIN-1 — Reviewer can log in and reach the console', async ({ page }) => {
  await loginAs(page, env.reviewer);

  await expect(page.getByRole('button', { name: 'Account Queue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Escalations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Audit Trail' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send Audit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
});

test('TC-LOGIN-2 — Admin sees the admin-only Settings nav item', async ({ page }) => {
  await loginAs(page, env.admin);

  await expect(page.getByRole('button', { name: 'Account Queue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
});

test('TC-LOGIN-3 — Unauthenticated visitors are gated, not shown the console', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('[data-gate-view="landing"]')).toBeVisible();
  await expect(page.getByText('Erria Outreach Agent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account Queue' })).toHaveCount(0);
});
