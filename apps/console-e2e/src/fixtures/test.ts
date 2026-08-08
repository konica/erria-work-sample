import { test as base, expect, type Page } from '@playwright/test';
import { loginAs } from './auth.js';
import { loadE2eEnv } from './env.js';

export const env = loadE2eEnv();

interface Fixtures {
  /** A page already logged in as the `reviewer`-role UAT account. */
  reviewerPage: Page;
  /** A page already logged in as the `admin`-role UAT account. */
  adminPage: Page;
}

export const test = base.extend<Fixtures>({
  reviewerPage: async ({ page }, use) => {
    await loginAs(page, env.reviewer);
    await use(page);
  },
  adminPage: async ({ page }, use) => {
    await loginAs(page, env.admin);
    await use(page);
  },
});

export { expect };

/** Opens Account Detail the only way the console currently allows: clicking its Queue row. */
export async function openAccountFromQueue(page: Page, companyName: string): Promise<void> {
  await page.getByRole('button').filter({ hasText: companyName }).click();
}
