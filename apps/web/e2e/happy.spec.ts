import { expect, test, type Page } from '@playwright/test';

// user-browser from docs/lab.md
const MNEMONIC = 'injury raise enable film tissue approve code topple unlock busy candy embark';

const ESCROW_1 = 'blue salt fault plastic fault bargain word lady icon actual speed reflect';

async function onboard(page: Page, mnemonic = MNEMONIC) {
  await page.goto('/');
  await page.getByTestId('onboarding-import-toggle').click();
  await page.getByTestId('onboarding-mnemonic-input').fill(mnemonic);
  await page.getByTestId('onboarding-import-submit').click();
  await expect(page.getByTestId('whoami')).toHaveAttribute('data-pubkey', /^[0-9a-f]{64}$/);
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
  await page.getByTestId('order-fund').click();
  await expect(status).toHaveAttribute('data-status', 'delivered');
  return (await page.getByTestId('order-id').textContent())!;
}

async function order(page: Page, payment: 'btc-signet' | 'usdc-evm') {
  await fundedOrder(page, payment);
  const status = page.getByTestId('order-status');
  await page.getByTestId('order-release').click();
  await expect(status).toHaveAttribute('data-status', 'completed');
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
  await escrow.getByTestId('escrow-decrypt-address').click();
  await expect(escrow.getByTestId('escrow-address')).toContainText('東京都新宿区新宿1-1-1');
  await escrow.getByTestId('ruling-user').fill('20000');
  await escrow.getByTestId('ruling-shopper').fill('8000');
  await escrow.getByTestId('ruling-reason').fill('一部返金');
  await escrow.getByTestId('ruling-submit').click();
  await expect(escrow.getByTestId('ruling-sent')).toBeVisible();
  await escrow.screenshot({ path: 'test-results/escrow-case.png', fullPage: true });

  await expect(user.getByTestId('order-status')).toHaveAttribute('data-status', 'ruled');
  await user.getByTestId('ruling-countersign').click();
  await expect(user.getByTestId('order-status')).toHaveAttribute('data-status', 'settled');
  await expect(escrow.getByTestId('escrow-settled')).toBeVisible();
});

test('operator and coordinator pages publish signed events', async ({ page }) => {
  await onboard(page, 'sphere nation isolate asthma phrase this discover detect judge start poverty measure'); // coordinator-2
  await page.getByTestId('nav-coordinator').click();
  await page.getByTestId('coordinator-operator').fill('aa1e2688daf4a1b4da779435210ea7dea8521a63b60328fd25beb0a73732b51f');
  await page.getByTestId('coordinator-delegate').click();
  await expect(page.getByTestId('coordinator-delegation')).toHaveAttribute('data-revoked', 'false');
  await page.getByTestId('coordinator-revoke-aa1e2688').click();
  await expect(page.getByTestId('coordinator-delegation')).toHaveAttribute('data-revoked', 'true');
  await expect(page.getByTestId('coordinator-delegation-version')).toHaveText('v2');

  await page.getByTestId('nav-operator').click();
  await page.getByTestId('operator-name').fill('テスト operator');
  await page.getByTestId('operator-entry-region').fill('JP-27');
  await page.getByTestId('operator-entry-shopper').fill('58faf8c359a8c0c9e27e4c610a93406536f07b4585d6351a9ea3ee8fc3891ae4');
  await page.getByTestId('operator-entry-escrow').fill('5733593b6fb3c911be92e6d5cfc10e22520b4df2f73e057732814393440f205e');
  await page.getByTestId('operator-entry-add').click();
  await page.getByTestId('operator-publish').click();
  await expect(page.getByTestId('operator-version')).toHaveAttribute('data-version', '1');
  await page.getByTestId('operator-entry-remove-0').click();
  await page.getByTestId('operator-publish').click();
  await expect(page.getByTestId('operator-version')).toHaveAttribute('data-version', '2');
  await page.screenshot({ path: 'test-results/operator.png', fullPage: true });

  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-relays-item')).toHaveCount(1);
  await page.getByTestId('settings-coordinators-input').fill('23c66e3b8b09d6f242e501ddbff2e6a2c786b4d36a8bdffddb1299b4c5de13dd');
  await page.getByTestId('settings-coordinators-add').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
});
