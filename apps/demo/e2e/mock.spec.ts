/**
 * The demo in mock mode, end to end, as a visitor of the GitHub Pages site uses it: open the static build,
 * "reset demo", then follow the guide of every scenario (driver.ts, the same logic as the lab's demo e2e in
 * proxy-shopping-go/e2e/src/demo), normal-btc in English, and the separate-windows mode. Throughout, no request
 * may leave the page's origin: relays, chains, faucet, rates, shops and the shopper node all run in the browser.
 *
 *   DEMO_URL=http://localhost:4173/proxy-shopping-web/ npx playwright test -c e2e/playwright.config.ts
 *   DEMO_SCENARIOS=normal-btc (comma separated ids, plus "separate") to pick some.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { followGuide, openDemo, resetDemo, startScenario, type DemoWindow } from './driver';
import { assertNoJapanese, STEP_AREAS } from './i18n';
import { DEMO_SCENARIOS } from './scenarios';

const BASE = (process.env.DEMO_URL ?? 'http://localhost:4173/proxy-shopping-web/').replace(/\/?$/, '/');
const ORIGIN = new URL(BASE).origin;
const PICK = (process.env.DEMO_SCENARIOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const wanted = (id: string) => !PICK.length || PICK.includes(id);
/** ?mock=1 even where it is the default, so the test also covers a lab build with the switch. */
const url = (query = '') => `${BASE}?mock=1${query ? `&${query.replace(/^\?/, '')}` : ''}`;

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
const foreign: string[] = [];

/** Record (and refuse) every request that is not for the page's own static files. */
async function guard(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(`${ORIGIN}/`) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    foreign.push(`${route.request().method()} ${u}`);
    return route.abort();
  });
  ctx.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(`${ORIGIN}/`) && !u.startsWith('data:') && !u.startsWith('blob:')) foreign.push(`${r.method()} ${u}`);
  });
  ctx.on('page', (p) => p.on('websocket', (ws) => foreign.push(`websocket ${ws.url()}`)));
}

async function newPage(name: string): Promise<Page> {
  const page = await context.newPage();
  page.on('websocket', (ws) => foreign.push(`websocket ${ws.url()}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${name} console] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  return page;
}

const log = (l: string) => console.log(`  ${l}`);

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1400, height: 1000 } });
  await guard(context);
  const first = await newPage('reset');
  await openDemo(first, url());
  await expect(first.getByTestId('mock-banner')).toContainText('モック: すべてこのブラウザの中で動いています');
  await expect(first.getByTestId('mock-switch')).toHaveAttribute('data-mock', 'true');
  await resetDemo(first);
  await first.close();
});

test.afterAll(async () => {
  await context?.close();
});

test.afterEach(() => {
  expect(foreign, 'requests that left the page origin').toEqual([]);
});

for (const s of DEMO_SCENARIOS) {
  test(`${s.id}: ${s.title}`, async () => {
    test.skip(!wanted(s.id), 'not selected');
    const page = await newPage(s.id);
    let checked = 0;
    const english = s.english
      ? {
          onStep: async (p: Page, cur: { step: string }) => {
            await assertNoJapanese(p, `step ${cur.step}`, STEP_AREAS);
            checked++;
          },
          onConfirm: async (p: Page, action: string) => {
            await assertNoJapanese(p, `confirmation of ${action}`, ['[data-testid="confirm-dialog"]']);
            checked++;
          },
        }
      : {};
    try {
      await openDemo(page, url(s.query));
      if (s.english) await expect(page.getByTestId('mock-banner')).toContainText('Mock: everything runs inside this browser');
      await startScenario(page, s.scenario ?? s.id);
      await followGuide([{ page, name: 'all' }], { log, stepTimeoutMs: 120_000, timeoutMs: 10 * 60_000, ...english });
      if (s.english) {
        await assertNoJapanese(page, 'scenario complete', STEP_AREAS);
        log(`no Japanese UI text at ${checked} steps and confirmation dialogs`);
      }
      log(await s.check(page));
      await page.screenshot({ path: `test-results/e2e-mock/demo-${s.id}.png`, fullPage: true }).catch(() => undefined);
    } finally {
      await page.close();
    }
  });
}

test('separate windows: ?role=user and ?role=escrow,operator,coordinator share the in-browser network (dispute-refund)', async () => {
  test.skip(!wanted('separate'), 'not selected');
  const userPage = await newPage('user-window');
  const othersPage = await newPage('others-window');
  const windows: DemoWindow[] = [
    { page: userPage, roles: ['user'], name: 'user-window' },
    { page: othersPage, roles: ['escrow', 'operator', 'coordinator'], name: 'others-window' },
  ];
  try {
    await openDemo(userPage, url('role=user'));
    await openDemo(othersPage, url('role=escrow,operator,coordinator'));
    await expect(userPage.getByTestId('mock-separate-unavailable')).toHaveCount(0);
    expect(await othersPage.getByTestId('tab-user').count()).toBe(0);
    expect(await userPage.getByTestId('tab-escrow').count()).toBe(0);
    await startScenario(userPage, 'dispute-refund');
    await othersPage.locator('[data-testid="guide"][data-scenario="dispute-refund"][data-complete="false"]').waitFor({ timeout: 30_000 });
    await followGuide(windows, { log, stepTimeoutMs: 120_000, timeoutMs: 10 * 60_000 });
    await othersPage.locator('[data-testid="guide"][data-complete="true"]').waitFor({ timeout: 30_000 });
    expect(await userPage.getByTestId('order-status').getAttribute('data-status')).toBe('settled');
    log('both windows show the scenario complete; the user window countersigned, the other one ruled');
  } finally {
    await userPage.close();
    await othersPage.close();
  }
});
