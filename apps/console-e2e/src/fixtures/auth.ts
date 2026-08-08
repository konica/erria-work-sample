import type { Page } from '@playwright/test';
import type { Credentials } from './env.js';

/**
 * Drives the real Keycloak-hosted login redirect (`console-web`'s `oidc-client-ts` flow) exactly
 * as TC-LOGIN-1/2 describe: click "Log in" on the gate, fill Keycloak's native form, land back on
 * the Account Queue. No shortcut (e.g. minting a token directly) — the point of this suite is to
 * exercise what a UAT tester actually clicks through.
 *
 * Uses `Locator.waitFor` rather than `expect(...).toBeVisible()` so this helper needs no runtime
 * import from '@playwright/test' at all (the `Page` import above is type-only and erased) — every
 * test that calls this still gets its own `expect` from fixtures/test.js for real assertions.
 */
export async function loginAs(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/');
  await page.locator('[data-gate-view="landing"]').waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'Log in' }).click();

  await page.locator('#username').fill(creds.username);
  await page.locator('#password').fill(creds.password);
  await page.locator('#kc-login').click();

  await page.getByRole('button', { name: 'Account Queue' }).waitFor({ state: 'visible' });
}
