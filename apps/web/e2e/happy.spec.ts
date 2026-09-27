import { expect, test, type Page } from '@playwright/test';

// user-browser from docs/lab.md
const MNEMONIC = 'injury raise enable film tissue approve code topple unlock busy candy embark';

const ESCROW_1 = 'blue salt fault plastic fault bargain word lady icon actual speed reflect';

/** Import a mnemonic; with `passphrase` it is stored encrypted, otherwise the user explicitly opts out. */
async function onboard(page: Page, mnemonic = MNEMONIC, passphrase?: string) {
  await page.goto('/');
  await page.getByTestId('onboarding-import-toggle').click();
  await page.getByTestId('onboarding-mnemonic-input').fill(mnemonic);
  if (passphrase) {
    await page.getByTestId('onboarding-passphrase').fill(passphrase);
    await page.getByTestId('onboarding-passphrase-confirm').fill(passphrase);
  } else {
    await page.getByTestId('onboarding-no-passphrase').check();
  }
  await page.getByTestId('onboarding-import-submit').click();
  await expect(page.getByTestId('whoami')).toHaveAttribute('data-pubkey', /^[0-9a-f]{64}$/);
}

/** Every fund-moving button opens an in-page confirmation dialog first. */
async function confirmDialog(page: Page, action: string) {
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toHaveAttribute('data-action', action);
  await expect(dialog.getByTestId('confirm-amount')).toBeVisible();
  await dialog.getByTestId('confirm-ok').click();
}

/** Place an order and fund it; returns once the shopper reports delivery. */
async function fundedOrder(page: Page, payment: 'btc-signet' | 'usdc-evm') {
  await page.getByTestId('nav-new-order').click();
  await page.getByTestId('order-shop-url').fill('https://safe-shop.test/');
  await page.getByTestId('order-region').fill('JP-13-13104');
  await page.getByTestId('order-payment').selectOption(payment);
  await page.getByTestId('order-item-sku-0').fill('A-100');
  await page.getByTestId('order-item-qty-0').fill('1');
  await page.getByTestId('order-search').click();
  await expect(page.getByTestId('offers')).not.toHaveAttribute('data-count', '0');
  await page.getByTestId('offer-select-0').check();
  await page.getByTestId('address-name').fill('山田太郎');
  await page.getByTestId('address-postal-code').fill('160-0022');
  await page.getByTestId('address-address').fill('東京都新宿区新宿1-1-1');
  await page.getByTestId('address-phone').fill('03-0000-0000');
  await page.getByTestId('order-submit').click();
  const status = page.getByTestId('order-status');
  await expect(status).toHaveAttribute('data-status', 'quoted');
  await expect(page.getByTestId('quote-fx-banner')).toHaveAttribute('data-level', 'ok');
  await expect(page.getByTestId('quote-check-ok')).toBeVisible();
  await page.getByTestId('quote-accept').click();
  await expect(status).toHaveAttribute('data-status', 'accepted');
  await page.getByTestId('order-faucet').click();
  await expect(page.getByTestId('order-faucet')).toHaveAttribute('data-busy', 'false');
  await expect(page.getByTestId('fund-balance')).toHaveAttribute('data-enough', 'true');
  if (payment === 'btc-signet') await expect(page.getByTestId('fund-preview')).toHaveAttribute('data-fee', /^\d+$/);
  await page.getByTestId('order-fund').click();
  await expect(page.getByTestId('confirm-recipient')).toHaveText(/^(tb1|0x)/);
  await confirmDialog(page, 'order-fund');
  await expect(status).toHaveAttribute('data-status', 'delivered');
  // the T1/T2 locks are shown as dates with a countdown
  await expect(page.getByTestId('quote-timelock-t1')).toHaveAttribute('data-at', /^\d+$/);
  return (await page.getByTestId('order-id').textContent())!;
}

async function order(page: Page, payment: 'btc-signet' | 'usdc-evm') {
  await fundedOrder(page, payment);
  const status = page.getByTestId('order-status');
  await page.getByTestId('order-release').click();
  await expect(page.getByTestId('confirm-warning')).toHaveCount(0); // delivered: no early-release warning
  await confirmDialog(page, 'order-release');
  await expect(status).toHaveAttribute('data-status', 'completed');
  // the T2 refund panel disappears only once the chain shows the escrow output spent
  await expect(page.getByTestId('refund')).toHaveCount(0);
  await expect(page.getByTestId('order-completed-txid')).toHaveText(/^(0x)?[0-9a-f]{64}$/);
  await page.screenshot({ path: `test-results/order-${payment}.png`, fullPage: true });
}

test('happy path: BTC then USDC', async ({ page }) => {
  page.on('console', (m) => m.type() === 'error' && console.log('[browser]', m.text()));
  await onboard(page);
  await expect(page.getByTestId('whoami')).toHaveAttribute('data-pubkey', '756e3c706ba0cc47d9d06e6e083c972694da76fc556b8b5defb7d3265d0e3bcf');
  await order(page, 'btc-signet');
  await order(page, 'usdc-evm');
  await page.getByTestId('nav-orders').click();
  await expect(page.getByTestId('orders-status')).toHaveCount(2);
});

test('dispute: user opens, escrow rules in its own browser, user countersigns', async ({ browser }) => {
  const user = await (await browser.newContext()).newPage();
  await onboard(user);
  const orderId = await fundedOrder(user, 'btc-signet');
  await user.getByTestId('dispute-claim').selectOption('wrong_item');
  await user.getByTestId('dispute-text').fill('違う商品が届きました');
  await user.getByTestId('dispute-open').click();
  await expect(user.getByTestId('order-status')).toHaveAttribute('data-status', 'disputed');

  const escrow = await (await browser.newContext()).newPage();
  await onboard(escrow, ESCROW_1);
  await escrow.getByTestId('nav-escrow').click();
  await escrow.getByTestId(`escrow-case-link-${orderId}`).click();
  await expect(escrow.getByTestId('escrow-case-detail-status')).toHaveAttribute('data-status', 'open');
  await escrow.getByTestId('escrow-check-obligation').click();
  await expect(escrow.getByTestId('escrow-obligation')).toHaveAttribute('data-paid', 'true');
  await expect(escrow.getByTestId('escrow-verification')).toHaveAttribute('data-ok', 'true');
  await escrow.getByTestId('escrow-decrypt-address').click();
  await expect(escrow.getByTestId('escrow-address')).toContainText('東京都新宿区新宿1-1-1');
  // the escrow fee is exactly dispute_fee_bps (2 %) of the distributable 28667 sats, rounded down: 573
  await expect(escrow.getByTestId('ruling-distributable')).toHaveAttribute('data-amount', '28667');
  await expect(escrow.getByTestId('ruling-fee')).toHaveAttribute('data-fee', '573');
  await escrow.getByTestId('ruling-user').fill('20000');
  await escrow.getByTestId('ruling-shopper').fill('8100'); // would leave 567 for the escrow: refused
  await expect(escrow.getByTestId('ruling-fee')).toHaveAttribute('data-split-ok', 'false');
  await expect(escrow.getByTestId('ruling-submit')).toBeDisabled();
  await escrow.getByTestId('ruling-shopper').fill('8094');
  await expect(escrow.getByTestId('ruling-fee')).toHaveAttribute('data-split-ok', 'true');
  await escrow.getByTestId('ruling-reason').fill('一部返金');
  await escrow.getByTestId('ruling-submit').click();
  await expect(escrow.getByTestId('ruling-sent')).toBeVisible();
  await escrow.screenshot({ path: 'test-results/escrow-case.png', fullPage: true });

  await expect(user.getByTestId('order-status')).toHaveAttribute('data-status', 'ruled');
  await user.getByTestId('ruling-countersign').click();
  await confirmDialog(user, 'ruling-countersign');
  await expect(user.getByTestId('order-status')).toHaveAttribute('data-status', 'settled');
  await expect(escrow.getByTestId('escrow-settled')).toBeVisible();
});

test('operator and coordinator pages publish signed events', async ({ page }) => {
  await onboard(page, 'sphere nation isolate asthma phrase this discover detect judge start poverty measure'); // coordinator-2
  await page.getByTestId('nav-coordinator').click();
  await page.getByTestId('coordinator-operator').fill('aa1e2688daf4a1b4da779435210ea7dea8521a63b60328fd25beb0a73732b51f');
  await page.getByTestId('coordinator-delegate').click();
  await expect(page.getByTestId('coordinator-delegation')).toHaveAttribute('data-revoked', 'false');
  // versions are max(known + 1, now) (§2.1), so compare rather than expect v1/v2
  const v1 = Number((await page.getByTestId('coordinator-delegation-version').textContent())!.slice(1));
  await page.getByTestId('coordinator-revoke-aa1e2688').click();
  await expect(page.getByTestId('coordinator-delegation')).toHaveAttribute('data-revoked', 'true');
  const v2 = Number((await page.getByTestId('coordinator-delegation-version').textContent())!.slice(1));
  expect(v2).toBeGreaterThan(v1);

  await page.getByTestId('nav-operator').click();
  await page.getByTestId('operator-name').fill('テスト operator');
  await page.getByTestId('operator-entry-region').fill('JP-27');
  await page.getByTestId('operator-entry-shopper').fill('58faf8c359a8c0c9e27e4c610a93406536f07b4585d6351a9ea3ee8fc3891ae4');
  await page.getByTestId('operator-entry-escrow').fill('5733593b6fb3c911be92e6d5cfc10e22520b4df2f73e057732814393440f205e');
  await page.getByTestId('operator-entry-add').click();
  await page.getByTestId('operator-publish').click();
  await expect(page.getByTestId('operator-published')).toBeVisible();
  const first = Number(await page.getByTestId('operator-version').getAttribute('data-version'));
  expect(first).toBeGreaterThan(0);
  await page.getByTestId('operator-entry-remove-0').click();
  await page.getByTestId('operator-publish').click();
  await expect.poll(async () => Number(await page.getByTestId('operator-version').getAttribute('data-version'))).toBeGreaterThan(first);
  await page.screenshot({ path: 'test-results/operator.png', fullPage: true });

  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-relays-item')).toHaveCount(1);
  await page.getByTestId('settings-coordinators-input').fill('23c66e3b8b09d6f242e501ddbff2e6a2c786b4d36a8bdffddb1299b4c5de13dd');
  await page.getByTestId('settings-coordinators-add').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  // the override is listed against config.json and can be reset field by field
  await expect(page.getByTestId('settings-override-item')).toHaveAttribute('data-field', 'coordinators');
  await page.getByTestId('settings-override-reset-coordinators').click();
  await expect(page.getByTestId('settings-override-item')).toHaveCount(0);
  // changing an endpoint warns before saving
  await page.getByTestId('settings-esplora').fill('http://lab:9999');
  await expect(page.getByTestId('settings-endpoint-warning')).toBeVisible();
});

test('passphrase: the mnemonic is stored encrypted and unlocked after reload', async ({ page }) => {
  await onboard(page, ESCROW_1, 'correct horse battery');
  await page.reload();
  await expect(page.getByTestId('unlock')).toBeVisible();
  await page.getByTestId('unlock-passphrase').fill('wrong passphrase');
  await page.getByTestId('unlock-submit').click();
  await expect(page.getByTestId('unlock-error')).toBeVisible();
  await page.getByTestId('unlock-passphrase').fill('correct horse battery');
  await page.getByTestId('unlock-submit').click();
  await expect(page.getByTestId('whoami')).toHaveAttribute('data-pubkey', /^[0-9a-f]{64}$/);
  // backup: the words are shown again only with the passphrase
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-mnemonic-passphrase').fill('correct horse battery');
  await page.getByTestId('settings-show-mnemonic').click();
  await expect(page.getByTestId('settings-mnemonic-words')).toContainText('fault');
  // logout goes through a confirmation dialog and can drop this identity's database
  await page.getByTestId('settings-logout-delete-data').check();
  await page.getByTestId('settings-logout').click();
  await expect(page.getByTestId('confirm-warning')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('onboarding')).toBeVisible();
});

test('only one tab runs the app at a time', async ({ context }) => {
  const a = await context.newPage();
  await onboard(a);
  const b = await context.newPage();
  await b.goto('/');
  await expect(b.getByTestId('other-tab')).toBeVisible();
  await b.getByTestId('other-tab-take-over').click();
  await expect(b.getByTestId('whoami')).toHaveAttribute('data-pubkey', /^[0-9a-f]{64}$/);
  await expect(a.getByTestId('other-tab')).toBeVisible();
});
