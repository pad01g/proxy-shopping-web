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
await page.getByTestId('onboarding-no-passphrase').check();   // or fill onboarding-passphrase + onboarding-passphrase-confirm (≥ 8 chars)
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
// only when quote-ack-required is shown (rate > 10 % off, or not checkable): check quote-ack-deviation first
await page.getByTestId('quote-accept').click();
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'accepted');
await page.getByTestId('order-faucet').click();              // or nav-wallet → wallet-faucet-btc
await page.getByTestId('order-fund').click();
await page.getByTestId('confirm-ok').click();                // confirm-dialog data-action="order-fund"
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'delivered');
await page.getByTestId('order-release').click();
await page.getByTestId('confirm-ok').click();                // confirm-dialog data-action="order-release"
// 'completed' is set only after the chain shows the escrow output spent (re-checked every 5 s);
// likewise 'settled' / 'refunded' after our own countersign / refund broadcast
await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'completed');
```

A runnable version is `e2e/happy.spec.ts` (driven by `scripts/e2e-web.sh`).

## Confirmation dialog (every fund-moving action)

`order-fund`, `order-fund-resume`, `order-release`, `ruling-countersign`, `order-refund` and `refund-offer-accept` do
nothing on click except open an in-page modal (never `window.confirm`):

| testid | element |
|---|---|
| `confirm-dialog` | the modal; **`data-action`** = testid of the button that opened it |
| `confirm-amount`, `confirm-recipient` | amount and receiving address |
| `confirm-details` | (fund) per-recipient amounts, miner fee and fee rate |
| `confirm-warning` | strong warning, e.g. `order-release` before status `delivered`, or logout |
| `confirm-ok`, `confirm-cancel` | run / abort the action |

The logout button `settings-logout` uses the same dialog (`data-action="settings-logout"`).

## Error boundaries

A panel that fails to render is replaced by `panel-error` (`data-panel` = panel name, or the route path).

## Global

| testid | element |
|---|---|
| `app-loading` | shown while config / identity load |
| `runtime-starting`, `runtime-error` | connecting / failed to start (settings form is shown below, including the key section) |
| `unlock`, `unlock-passphrase`, `unlock-submit`, `unlock-error`, `unlock-forget` | the stored mnemonic is encrypted: enter the passphrase |
| `other-tab`, `other-tab-take-over` | the app is active in another tab of this browser; take over here |
| `whoami` | header; `data-pubkey` = our Nostr pubkey (hex) |
| `nav-home`, `nav-new-order`, `nav-orders`, `nav-wallet`, `nav-escrow`, `nav-operator`, `nav-coordinator`, `nav-shopper`, `nav-settings` | navigation links |

## Onboarding `/onboarding`

| testid | element |
|---|---|
| `onboarding` | page |
| `onboarding-generate` | create a new 12-word mnemonic |
| `onboarding-backup`, `onboarding-backup-words` | backup screen / the `<ol>` of words |
| `onboarding-backup-confirm` | "I wrote them down" → finishes onboarding (needs a passphrase or the opt-out) |
| `onboarding-import-toggle` | switch to import |
| `onboarding-mnemonic-input` | textarea for 12/24 words |
| `onboarding-import-submit` | import |
| `onboarding-nip07` | checkbox: identity via NIP-07 (disabled without `window.nostr`; if the extension is missing later the app refuses to start instead of falling back) |
| `onboarding-passphrase`, `onboarding-passphrase-confirm` | passphrase (≥ 8) that encrypts the mnemonic (PBKDF2-SHA256 600k + AES-GCM) |
| `onboarding-no-passphrase` | explicit opt-out: store the mnemonic in plaintext |
| `onboarding-error` | invalid mnemonic |

## Settings `/settings`

| testid | element |
|---|---|
| `settings` | page |
| `settings-relays`, `settings-coordinators`, `settings-trust-bundles` | editable lists (see "lists" below); trust bundles are URLs of signed events (config `trust_bundles`) |
| `settings-directory` (`data-url`) | coordinator directory of config.json `coordinator_directory`; rows `settings-directory-item` (`data-pk`, `data-added`), add button `settings-directory-add-<name>` (also adds its `bundle` to the trust bundles), `settings-directory-empty`, `settings-directory-error` |
| `settings-network`, `settings-esplora`, `settings-evm-rpc`, `settings-chain-id`, `settings-deployments-url`, `settings-faucet-url` | inputs |
| `settings-rates` | rate sources table; rows `settings-rates-item`, remove `settings-rates-remove-<i>` |
| `settings-rates-type`, `settings-rates-base`, `settings-rates-add` | add a rate source (`static` takes JSON in base) |
| `settings-save` | persist overrides (localStorage) and reconnect; then `settings-saved` |
| `settings-p2p` section: `settings-p2p-enabled` (checkbox, config `p2p.enabled`), `settings-p2p-relays` (list of p2p relay multiaddrs), `settings-trust-from-nostr` (checkbox, config `trust_from_nostr`; unset = only when P2P is off) | P2P (§10) and the Nostr trust path (§2.6) |
| `settings-max-fee-rate` | cap for the BTC funding fee rate (sat/vB, default 50) |
| `settings-reset` | drop all overrides, back to `/config.json` |
| `settings-overrides`, rows `settings-override-item` (`data-field`), `settings-override-reset-<field>` | fields that override config.json, with a per-field reset |
| `settings-endpoint-warning` | an endpoint (relays, esplora, evm_rpc, deployments_url, rates, faucet, chain id) differs from config.json |
| `settings-error` | validation error (coordinator keys; endpoints must be https/wss unless `allow_private_endpoints` in config.json) |
| `settings-key` | key section (shown even when the runtime failed) |
| `settings-pubkey` | the identity's Nostr public key (hex), when connected |
| `settings-mnemonic-passphrase`, `settings-show-mnemonic`, `settings-mnemonic-words`, `settings-key-error` | re-show the mnemonic (asks the passphrase again) |
| `settings-export-orders` | download orders and escrow cases as JSON |
| `settings-logout-delete-data`, `settings-logout` | delete the key (confirm dialog); optionally also this identity's database |

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
| `order-pending-settlement` (`data-kind` = `completed` / `settled` / `refunded`) | a peer claimed completion / countersignature, or we broadcast a payout ourselves (countersign, refund); waiting for the chain (BTC outspend, USDC balance < lock_amount + Transfer out of the Safe) |
| `order-dropped` (`data-count`), rows `order-dropped-item` (`data-type` = message type) | messages of this order's shopper / escrow that were dropped (schema, rate limit) |
| `quote-waiting`, `quote-rejected` | before quote / shopper declined |
| `order-resend`, `order-cancel` | status `requested` (e.g. the request could not be published): send order.request + order.escrow_key again / cancel |
| `quote` | quote section; `quote-rate`, `quote-lock-amount`, `quote-escrow-address` |
| `quote-timelock-t1`, `quote-timelock-t2` | T1 / T2 with date and countdown; `data-value` = height / UNIX time, `data-at` = estimated UNIX time |
| `quote-fx-banner` | **`data-level`**: `ok`, `warn` (>3 %), `strong` (>10 %) |
| `quote-check-ok`, `quote-check-errors`, `quote-check-warnings` | validation result (errors block accepting: address, lock_amount, payout_fee_reserve cap, upfront fee > 2×, timelock policy, deployments cross-check) |
| `quote-ack-required`, `quote-ack-deviation` | rate > 10 % off or not checkable: the checkbox must be checked before `quote-accept` is enabled |
| `quote-accept`, `quote-recheck`, `order-cancel` | actions (status `quoted`) |
| `fund` | funding section (status `accepted`/`funding`); `fund-balance` (`data-enough` = the wallet covers lock + upfront fee; `order-fund` is disabled until then); `order-cancel` while no funding transaction exists |
| `fund-in-progress`, `order-fund-resume` | a funding transaction exists (txid / tx hash persisted) but order.funded was not sent (tab closed, error): resume (confirm dialog, `data-action="order-fund-resume"`) skips the balance / fee preview and never pays twice; cancel is no longer offered |
| `fund-preview` | BTC: `data-fee` (sats), `data-fee-rate` (sat/vB, capped) |
| `order-faucet` | lab faucet for the order's asset (only with `faucet_url`) |
| `order-fund` | fund escrow + upfront fee, then order.funded + escrow.notice (confirm dialog) |
| `progress`, `order-funded-tx`, `order-purchased`, `order-tracking` | after funding |
| `order-release` | sign payout to the shopper (confirm dialog; `confirm-warning` unless status is `delivered`) |
| `order-completed`, `order-completed-txid` | completion verified on chain (BTC outspend / Safe empty + receipt) |
| `refund-offer`, `refund-offer-problems`, `refund-offer-accept` | shopper's cooperative refund: never auto-signed; accept (confirm dialog) only if it matches the template |
| `dispute`, `dispute-claim`, `dispute-text`, `dispute-split-user`, `dispute-split-shopper`, `dispute-open` | open a dispute (also after an interrupted funding; the evidence goes out in several messages when large) |
| `dispute-opened`, `dispute-send-evidence` | after opening |
| `ruling-pending` (`data-split-user`) | a ruling arrived before we knew of a dispute; shown as ruling once the shopper's dispute.open copy or an escrow evidence request arrives |
| `ruling`, `ruling-problems`, `ruling-countersign`, `ruling-settled` | escrow ruling: review, countersign + broadcast (confirm dialog). `ruling-countersign` is shown whenever there is a ruling and the escrow output is unspent — not keyed on `order-status` (a later dispute.open keeps `ruled`) — and hidden only while our own broadcast waits for the chain |
| `refund`, `refund-status` (`data-reached`), `refund-t2`, `order-refund` | user-only refund after T2 (confirm dialog); shown while the escrow output is unspent on chain, whatever the status, including after an interrupted funding |
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
| `escrow-conflicts`, `escrow-verification` (`data-ok`), `escrow-pending-settlement` | §4.7 assembly: messages naming another request (recorded, ignored), on-chain checks, unconfirmed countersignature. A case appears only once a notice / dispute names a request whose request + quote match the funded output on chain; a notice of the real request signer replaces a case assembled without one |
| `escrow-check-obligation`, `escrow-obligation` (`data-paid`) | on-chain upfront fee check |
| `escrow-dispute`, `escrow-missing`, `escrow-request-evidence` | claims / missing evidence |
| `escrow-evidence`, `escrow-evidence-message` | evidence viewer |
| `escrow-evidence-item` (`data-integrity` = `ok` / `mismatch` / `no-data`), `escrow-evidence-mismatch`, `escrow-evidence-image` | purchase evidence; inline data must match its sha256 |
| `escrow-attachment` (`data-sha256`) | assembled and hash-checked attachments (images shown) |
| `escrow-decrypt-address`, `escrow-address` | decrypted delivery address |
| `escrow-ruling`, `ruling-user`, `ruling-shopper`, `ruling-reason`, `ruling-submit`, `ruling-sent` | ruling form |
| `ruling-distributable` (`data-amount`), `ruling-terms-error` | what the ruling splits (BTC: output − reserve; USDC: the Safe's balance now) / why it cannot be computed (e.g. no escrow profile published) |
| `ruling-fee` (`data-fee`, `data-split-ok`) | the escrow fee = floor(dispute_fee_bps × distributable); `ruling-submit` is enabled only when user + shopper = distributable − fee (`data-split-ok="true"`) |
| `escrow-settled` | a party countersigned |

## Operator `/operator`

`operator`, `operator-version` (`data-version`; versions are `max(known + 1, now)`, so compare, do not expect 1/2), `operator-name`, `operator-report-to`,
lists `operator-regions` / `operator-relays`, `operator-chain` (JSON, applied on blur),
`operator-entries`, rows `operator-entry`, `operator-entry-remove-<i>`,
new entry `operator-entry-region`, `operator-entry-sla`, `operator-entry-shopper`, `operator-entry-escrow`,
`operator-entry-shops`, `operator-entry-payment-btc-signet`, `operator-entry-payment-usdc-evm`, `operator-entry-add`,
`operator-donation-btc`, `operator-donation-evm`, `operator-donation-bps`,
`operator-publish`, `operator-published`, `operator-reports`, rows `operator-report`,
`operator-report-remove-subject` (drops the subject's entries from the draft; publish to apply).

## Coordinator `/coordinator`

`coordinator`, rows `coordinator-delegation` (`data-operator`, `data-revoked`),
`coordinator-delegation-version` (`v<N>`, N = max(known + 1, now)), `coordinator-revoke-<first 8 hex of operator>`,
`coordinator-restore-<first 8 hex>`, `coordinator-operator`, `coordinator-note`, `coordinator-delegate`.

## Shopper `/shopper`

`shopper`, `shopper-name`, `shopper-delivery-days`, `shopper-fee-bps`, `shopper-fee-min`, `shopper-max-order`,
`shopper-currencies`, `shopper-btc-address`, `shopper-evm-address`, `shopper-payment-btc-signet`,
`shopper-payment-usdc-evm`, list `shopper-cash-regions`, `shopper-publish`, `shopper-published`.
