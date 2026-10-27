import { test, expect } from '@playwright/test';

async function fitsPhone(page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test('registration can be interrupted and returned to on a phone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'EuroFlow', exact: true })).toBeVisible();
  await fitsPhone(page);
  await page.locator('[data-auth-tab="register"]').click();
  await page.getByLabel('First name', { exact: true }).fill('Mobile');
  await fitsPhone(page);
  await page.locator('[data-auth-tab="login"]').click();
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#register-form')).not.toBeVisible();
  await page.locator('[data-auth-tab="register"]').click();
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Mobile');
});

test('demo account, navigation, reload and logout work at phone width', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = `${testInfo.project.name.replace(/[^a-z]/g, '')}${Date.now()}`;
  await page.goto('/');
  await page.locator('[data-auth-tab="register"]').click();
  const form = page.locator('#register-form');
  await form.locator('[name="first_name"]').fill('Mobile');
  await form.locator('[name="last_name"]').fill('Fixture');
  await form.locator('[name="email"]').fill(`${id}@example.test`);
  await form.locator('[name="phone"]').fill(`+351${String(Date.now()).slice(-9)}`);
  await form.locator('[name="username"]').fill(id);
  await form.locator('[name="country"]').fill('PT');
  await form.locator('[name="password"]').fill('test-only-mobile-fixture');
  await form.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#user-name')).toContainText('Mobile');
  await expect(page.locator('#balance')).toHaveText('€0.00');
  await fitsPhone(page);
  for (const name of ['send', 'request', 'split', 'activity', 'contacts', 'business', 'home']) {
    await page.locator(`.nav-btn[data-view="${name}"]`).click();
    await expect(page.locator(`.panel[data-panel="${name}"]`)).toBeVisible();
    await fitsPhone(page);
  }
  await page.reload();
  await expect(page.locator('#user-name')).toContainText('Mobile');
  await page.locator('#logout-btn').click();
  await expect(page.locator('#auth-view')).toBeVisible();
  await page.reload();
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#app-view')).not.toBeVisible();
  expect(errors).toEqual([]);
});
