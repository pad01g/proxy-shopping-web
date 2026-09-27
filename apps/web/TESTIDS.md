# data-testid reference

Stable hooks for Playwright. Status elements carry the machine-readable value in a
`data-*` attribute (the visible text is Japanese and may change); assert on the attribute.

Every `ActionButton` (async button) sets `data-busy="true|false"` while running and, on failure,
renders its error as `<testid>-error` next to it.

## Happy path (lab)

```ts
await page.goto('/');                                        // redirects to /onboarding
await page.getByTestId('onboarding-import-toggle').click();
await page.getByTestId('onboarding-mnemonic-input').fill(mnemonic);
await page.getByTestId('onboarding-import-submit').click();   // settings come from /config.json
await page.getByTestId('nav-new-order').click();
await page.getByTestId('order-shop-url').fill('https://safe-shop.test/');
await page.getByTestId('order-region').fill('JP-13-13104');
await page.getByTestId('order-payment').selectOption('btc-signet');
await page.getByTestId('order-item-sku-0').fill('A-100');
await page.getByTestId('order-item-qty-0').fill('1');
await page.getByTestId('order-search').click();
await expect(page.getByTestId('offers')).not.toHaveAttribute('data-count', '0');
await page.getByTestId('offer-select-0').check();            // first candidate (selected by default)
await page.getByTestId('address-name').fill('…');            // + address-postal-code, address-address, address-phone
await page.getByTestId('order-submit').click();              // navigates to /user/orders/<id>
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'quoted');
await page.getByTestId('quote-accept').click();
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'accepted');
await page.getByTestId('order-faucet').click();              // or nav-wallet → wallet-faucet-btc
await page.getByTestId('order-fund').click();
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'delivered');
await page.getByTestId('order-release').click();
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'completed');
```

A runnable version is `e2e/happy.spec.ts` (driven by `scripts/e2e-web.sh`).

## Global

| testid | element |
|---|---|
| `app-loading` | shown while config / identity load |
| `runtime-starting`, `runtime-error` | connecting / failed to start (settings form is shown below) |
| `whoami` | header; `data-pubkey` = our Nostr pubkey (hex) |
| `nav-home`, `nav-new-order`, `nav-orders`, `nav-wallet`, `nav-escrow`, `nav-operator`, `nav-coordinator`, `nav-shopper`, `nav-settings` | navigation links |

## Onboarding `/onboarding`

| testid | element |
|---|---|
| `onboarding` | page |
| `onboarding-generate` | create a new 12-word mnemonic |
| `onboarding-backup`, `onboarding-backup-words` | backup screen / the `<ol>` of words |
| `onboarding-backup-confirm` | "I wrote them down" → finishes onboarding |
| `onboarding-import-toggle` | switch to import |
| `onboarding-mnemonic-input` | textarea for 12/24 words |
| `onboarding-import-submit` | import |
| `onboarding-nip07` | checkbox: identity via NIP-07 (disabled without `window.nostr`) |
| `onboarding-error` | invalid mnemonic |

## Settings `/settings`

| testid | element |
|---|---|
| `settings` | page |
| `settings-relays`, `settings-coordinators` | editable lists (see "lists" below) |
| `settings-network`, `settings-esplora`, `settings-evm-rpc`, `settings-chain-id`, `settings-deployments-url`, `settings-faucet-url` | inputs |
| `settings-rates` | rate sources table; rows `settings-rates-item`, remove `settings-rates-remove-<i>` |
| `settings-rates-type`, `settings-rates-base`, `settings-rates-add` | add a rate source (`static` takes JSON in base) |
| `settings-save` | persist overrides (localStorage) and reconnect; then `settings-saved` |
| `settings-reset` | drop overrides, back to `/config.json` |
| `settings-error` | validation error |
| `settings-logout` | delete the key from this browser (confirm dialog) |

Lists (`StringList`) with base id `X`: container `X`, rows `X-item`, remove `X-remove-<i>`,
new value `X-input`, add `X-add`.

## Home `/`

`home`, `home-pubkey`, `home-effective-count` (`data-count` = effective combinations),
`home-refresh-trust`, `home-deployments-error`.

## New order `/user/new`

| testid | element |
|---|---|
| `new-order` | page |
| `order-shop-url`, `order-region`, `order-payment` (`btc-signet` / `usdc-evm`) | inputs |
| `order-item-row`, `order-item-sku-<i>`, `order-item-qty-<i>`, `order-item-add` | items |
| `order-search` | find candidates |
| `offers` | container; `data-count` = number of candidates |
| `offer-<i>`, `offer-select-<i>` (radio), `offer-provenance-<i>` | candidate, its selector and provenance (coordinator → operator, list version) |
| `offers-empty` | no candidates |
| `address-name`, `address-postal-code`, `address-address`, `address-phone` | delivery address |
| `order-submit`, `order-submit-error` | send order.request |

## Orders `/user/orders`

`orders`, `orders-empty`, rows `orders-row` (`data-order-id`), `orders-link-<id>`,
`orders-status` (`data-status`).

## Order detail `/user/orders/:id`

| testid | element |
|---|---|
| `order-detail` | page, `data-order-id` |
| `order-id` | full order id text |
| `order-status` | **`data-status`**: `requested` `quoted` `rejected` `accepted` `funding` `funded` `purchased` `shipped` `delivered` `delivery_failed` `released` `completed` `disputed` `ruled` `settled` `refunded` `cancelled` |
| `order-last-error` | last action error recorded on the order |
| `quote-waiting`, `quote-rejected` | before quote / shopper declined |
| `quote` | quote section; `quote-rate`, `quote-lock-amount`, `quote-escrow-address` |
| `quote-fx-banner` | **`data-level`**: `ok`, `warn` (>3 %), `strong` (>10 %) |
| `quote-check-ok`, `quote-check-errors`, `quote-check-warnings` | validation result (errors block accepting) |
| `quote-accept`, `quote-recheck`, `order-cancel` | actions (status `quoted`) |
| `fund` | funding section (status `accepted`/`funding`); `fund-balance` (`data-enough` = the wallet covers lock + upfront fee; `order-fund` is disabled until then) |
| `order-faucet` | lab faucet for the order's asset (only with `faucet_url`) |
| `order-fund` | fund escrow + upfront fee, then order.funded + escrow.notice |
| `progress`, `order-funded-tx`, `order-purchased`, `order-tracking` | after funding |
| `order-release` | sign payout to the shopper |
| `order-completed`, `order-completed-txid` | shopper's order.completed |
| `dispute`, `dispute-claim`, `dispute-text`, `dispute-split-user`, `dispute-split-shopper`, `dispute-open` | open a dispute |
| `dispute-opened`, `dispute-send-evidence` | after opening |
| `ruling`, `ruling-problems`, `ruling-countersign`, `ruling-settled` | escrow ruling: review, countersign + broadcast |
| `refund`, `refund-status` (`data-reached`), `order-refund` | user-only refund after T2 |
| `report`, `report-subject`, `report-text`, `report-send`, `report-sent` | report to the operator |
| `order-timeline`, `order-timeline-item` (`data-kind` = message type) | history |

## Wallet `/wallet`

`wallet`, `wallet-btc-address`, `wallet-btc-balance` (`data-sats`), `wallet-evm-address`,
`wallet-eth-balance`, `wallet-usdc-balance` (`data-units`), `wallet-faucet-btc`, `wallet-faucet-evm`,
`wallet-nostr-pubkey`, `wallet-refresh`.

## Escrow `/escrow`, `/escrow/cases/:id`

| testid | element |
|---|---|
| `escrow-cases`, `escrow-cases-empty` | list page |
| `escrow-case-row` (`data-order-id`), `escrow-case-link-<orderId>`, `escrow-case-status` (`data-status`: `notice` `open` `ruled` `settled`) | rows |
| `escrow-profile`, `escrow-profile-name`, `escrow-profile-bps`, `escrow-profile-min-sats`, `escrow-profile-min-usdc`, `escrow-profile-dispute-bps`, `escrow-profile-publish`, `escrow-profile-published` | kind 30503 publisher |
| `escrow-case` | detail page, `data-order-id` |
| `escrow-case-detail-status` | `data-status` |
| `escrow-check-obligation`, `escrow-obligation` (`data-paid`) | on-chain upfront fee check |
| `escrow-dispute`, `escrow-missing`, `escrow-request-evidence` | claims / missing evidence |
| `escrow-evidence`, `escrow-evidence-message` | evidence viewer |
| `escrow-decrypt-address`, `escrow-address` | decrypted delivery address |
| `escrow-ruling`, `ruling-user`, `ruling-shopper`, `ruling-fee`, `ruling-reason`, `ruling-submit`, `ruling-sent` | ruling form (fee = remainder) |
| `escrow-settled` | a party countersigned |

## Operator `/operator`

`operator`, `operator-version` (`data-version`), `operator-name`, `operator-report-to`,
lists `operator-regions` / `operator-relays`, `operator-chain` (JSON, applied on blur),
`operator-entries`, rows `operator-entry`, `operator-entry-remove-<i>`,
new entry `operator-entry-region`, `operator-entry-sla`, `operator-entry-shopper`, `operator-entry-escrow`,
`operator-entry-shops`, `operator-entry-payment-btc-signet`, `operator-entry-payment-usdc-evm`, `operator-entry-add`,
`operator-donation-btc`, `operator-donation-evm`, `operator-donation-bps`,
`operator-publish`, `operator-published`, `operator-reports`, rows `operator-report`,
`operator-report-remove-subject` (drops the subject's entries from the draft; publish to apply).

## Coordinator `/coordinator`

`coordinator`, rows `coordinator-delegation` (`data-operator`, `data-revoked`),
`coordinator-delegation-version` (`v<N>`), `coordinator-revoke-<first 8 hex of operator>`,
`coordinator-restore-<first 8 hex>`, `coordinator-operator`, `coordinator-note`, `coordinator-delegate`.

## Shopper `/shopper`

`shopper`, `shopper-name`, `shopper-delivery-days`, `shopper-fee-bps`, `shopper-fee-min`, `shopper-max-order`,
`shopper-currencies`, `shopper-btc-address`, `shopper-evm-address`, `shopper-payment-btc-signet`,
`shopper-payment-usdc-evm`, list `shopper-cash-regions`, `shopper-publish`, `shopper-published`.
