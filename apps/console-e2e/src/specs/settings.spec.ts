import { expect, test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Settings (SettingsPage), one case per Setting Risk Level

test.beforeEach(async ({ adminPage }) => {
  await adminPage.getByRole('button', { name: 'Settings' }).click();
});

test('TC-SET-1 — Freely Adjustable: Basic settings save immediately', async ({ adminPage }) => {
  const input = adminPage.getByLabel('Promotion threshold (clean approvals)');
  const current = Number(await input.inputValue());
  const next = current >= 4 ? current - 1 : current + 1;

  await input.fill(String(next));

  const saveButton = adminPage.getByRole('button', { name: 'Save', exact: true });
  await expect(adminPage.getByText('Saves immediately — no confirmation')).toBeVisible();
  await expect(adminPage.locator('[data-testid="confirm-advanced"]')).toHaveCount(0);

  await saveButton.click();
  await expect(input).toHaveValue(String(next));
});

test('TC-SET-2 — Confirm-Required: Advanced settings show a two-step confirmation', async ({
  adminPage,
}) => {
  await adminPage.getByRole('button', { name: 'Advanced' }).click();

  const input = adminPage.getByLabel('Max follow-ups');
  const current = Number(await input.inputValue());
  const next = current >= 5 ? current - 1 : current + 1;
  await input.fill(String(next));

  await adminPage.getByRole('button', { name: 'Save (requires confirm)' }).click();

  const confirmPanel = adminPage.locator('[data-testid="confirm-advanced"]');
  await expect(confirmPanel).toBeVisible();
  await expect(confirmPanel).toContainText(`maxFollowups: ${current} → ${next}`);
  // Step 2 alone must not have saved the change yet.
  await expect(input).toHaveValue(String(current));

  await adminPage.getByRole('button', { name: 'Cancel — nothing saved' }).click();
  await expect(confirmPanel).toHaveCount(0);
  await expect(input).toHaveValue(String(current));

  await adminPage.getByRole('button', { name: 'Save (requires confirm)' }).click();
  await adminPage.getByRole('button', { name: 'Confirm & apply' }).click();
  await expect(confirmPanel).toHaveCount(0);
  await expect(input).toHaveValue(String(next));
});

test('TC-SET-3 — Locked: hard-trigger rules and the rollout overlay are read-only reference', async ({
  adminPage,
}) => {
  const locked = adminPage.locator('[data-testid="locked-settings"]');

  await expect(locked).toContainText('New-account Tier 2 rollout overlay');
  await expect(locked.getByText('Locked — policy decision').first()).toBeVisible();
  await expect(locked.locator('input')).toHaveCount(0);
  await expect(locked.locator('button')).toHaveCount(0);
});
