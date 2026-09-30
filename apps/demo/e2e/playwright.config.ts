import { defineConfig } from '@playwright/test';

// The mock-mode e2e (mock.spec.ts): the static build served like GitHub Pages, every scenario of the guide.
// DEMO_URL points at the page (default: the local server of scripts/e2e-demo-mock.sh); set it to the live
// site to check the deployment.
const local = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(process.env.DEMO_URL ?? 'http://localhost:4173/');

export default defineConfig({
  testDir: '.',
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 1000 },
    locale: 'ja-JP',
    // Against the local server no name but localhost resolves, so nothing (not even a worker) could reach
    // another host unnoticed; the spec also fails on any request that leaves the page's origin.
    launchOptions: local ? { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] } : {},
  },
  reporter: [['list']],
  outputDir: '../test-results/e2e-mock',
});
