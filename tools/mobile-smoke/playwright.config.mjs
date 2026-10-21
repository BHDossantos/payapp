import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// These are mobile browser checks, not native-device or store-release validation.
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.',
  testMatch: '*.mobile.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4174', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'android-chromium', use: { ...devices['Pixel 5'],
      ...(process.env.MOBILE_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.MOBILE_CHROMIUM_EXECUTABLE } } : {}) } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'node tools/mobile-smoke/server.mjs', cwd: root,
    url: 'http://127.0.0.1:4174/health', reuseExistingServer: false },
});
