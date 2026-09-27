import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: process.env.APP_URL ?? 'http://localhost:8080',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  reporter: [['list']],
});
