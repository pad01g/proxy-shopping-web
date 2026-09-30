# デモ画面の data-testid

The demo e2e (`proxy-shopping-go/e2e/src/demo`) drives the page only through these ids and the guide.

## Language

The page is in Japanese (default) or English. The header's switch (`lang-ja` / `lang-en`) stores the choice in localStorage
(`ps-demo-lang`, kept by "デモを初期化"); `?lang=en` / `?lang=ja` overrides it for that page (not stored) and the switch rewrites it.
`<html lang>` follows. Test ids, `data-*` values and scenario / step ids are the same in both languages.

Messages live in `src/i18n`: `ja.ts` defines the keys (the `Messages` type), `en.ts` must provide every one of them (a missing key is
a type error); components read them with `useT()`, code outside React with `msg()`. Core's timeline lines (`kind` + Japanese
`text`) are rendered from their kind (`src/i18n/timeline.ts`); an unknown kind keeps core's text.

`data-i18n-exempt="<why>"` marks the few elements that show data rather than UI copy, which the English e2e (`normal-btc-en`)
skips when it looks for Japanese: other parties' free text (dispute text, ruling reason, report text, shopper's reject detail),
published profile names and delegation notes, the decrypted address, core's and the node's error / history details, values
inside timeline lines, the original text of unknown timeline kinds, and the "日本語" button (a language's own name).

## Mock mode

`?mock=1` runs everything inside the browser (src/mock), `?mock=0` against the lab; without the parameter the build
decides (`VITE_DEMO_MOCK=1` in `.env.pages`, the GitHub Pages build). Each mode keeps its own data (`ps-demo-mock.*` /
`ps-demo-mock-<role>` vs `ps-demo.*` / `ps-demo-<role>`). Test ids and the guide are the same in both modes.

| testid | element | attributes |
|---|---|---|
| `mock-switch` | header toggle "モック / Mock": reloads the page with `?mock=1` / `?mock=0` | `data-mock="true\|false"` |
| `mock-banner` | banner under the header in mock mode (「モック: すべてこのブラウザの中で動いています…」) | |
| `mock-separate-unavailable` | `?role=…` in a browser without SharedWorker: every role runs in this window | |
| `lab-mock-info` | lab tab: what the mock simulates | |

## Guide and layout

| testid | element | attributes |
|---|---|---|
| `guide` | the guide column | `data-scenario`, `data-run`, `data-complete="true\|false"` |
| `guide-step-<step id>` | one step | `data-state="done\|current\|pending"` |
| `guide-current` | the current step | `data-step`, `data-role` (actor: user, shopper, escrow, operator, coordinator, lab, chain), `data-action` (testid of the control to press, empty while waiting), `data-tab` (tab holding the control), `data-confirm="true"` when the control opens a confirmation dialog |
| `guide-go` | "この操作へ": opens the tab and highlights the control | only when this window runs the role |
| `guide-elsewhere` | "別のウィンドウで … が操作します" | separate-windows mode |
| `guide-waiting`, `guide-progress` | waiting text, live progress | |
| `guide-complete` | banner when every step is done | |
| `scenario-select` | scenario `<select>` (values: `normal-btc`, `normal-usdc`, `dispute-refund`, `sold-out`, `risky`, `fraud`, `timelock-t2`) | changing it starts a new run |
| `scenario-restart` | "最初から": new run of the same scenario | |
| `demo-reset` | "デモを初期化" (confirm dialog, then reload) | |
| `lang-switch`, `lang-ja`, `lang-en` | language switch "日本語 / English" in the header | `lang-switch[data-lang]`, `lang-<ja\|en>[data-active]` |
| `tab-<user\|shopper\|escrow\|operator\|coordinator\|lab>` | role tabs | `data-active` |
| `panel-<tab>` | the open tab's panel | |
| `role-elsewhere-<role>`, `role-takeover-<role>` | the role runs in another window; take it over | |
| `confirm-dialog`, `confirm-ok`, `confirm-cancel`, `confirm-amount`, `confirm-recipient`, `confirm-warning`, `confirm-details` | confirmation dialog | `confirm-dialog[data-action]` = testid of the button that opened it |
| `<button testid>-error` | error of an action button | |
| `identity-<role>` | keys card; `.identity[data-pubkey]`; `identity-<role>-pubkey`, `-btc`, `-evm`, `-btc-balance` | |

## 利用者

| testid | |
|---|---|
| `wallet-faucet-btc`, `wallet-faucet-evm` | lab faucet |
| `new-order`, `order-preset-<id>`, `order-shop-url`, `order-sku`, `order-qty`, `order-region`, `order-region-preset`, `order-payment` | order form (prefilled with the scenario's preset) |
| `order-search` | search candidates again (`data-busy`) |
| `offers` (`data-count`), `offer` (`data-escrow`, `data-shopper`), `offers-empty` | candidates |
| `address-name`, `address-postal-code`, `address-address`, `address-phone` | delivery address |
| `order-submit` | create the order (picks shopper-1 × this demo's escrow) |
| `order-list`, `order-row` (`data-order-id`, `data-status`), `order-open-<id8>` | orders |
| `order-detail` (`data-order-id`, `data-status`), `order-id`, `order-status` (`data-status`), `order-last-error`, `order-pending-settlement` | order detail (the scenario's order by default) |
| `quote`, `quote-waiting`, `quote-rejected` (`data-reason`), `quote-check-ok`, `quote-check-errors`, `quote-rate`, `quote-lock-amount`, `quote-timelock-t1`, `quote-timelock-t2`, `quote-escrow-address` | quote |
| `quote-accept` (confirm only when a rate deviation needs acknowledging), `quote-recheck`, `quote-cancel`, `request-resend`, `request-cancel` | quote actions |
| `fund`, `order-fund` (confirm), `fund-cancel`, `fund-in-progress` | funding |
| `progress`, `order-funded-tx`, `order-purchased`, `order-tracking`, `order-release` (confirm), `order-completed`, `order-completed-txid` | purchase, delivery, payout |
| `refund-offer`, `refund-offer-accept` (confirm), `refund-offer-problems` | cooperative refund |
| `dispute`, `dispute-claim`, `dispute-text`, `dispute-open`, `dispute-opened`, `ruling` (`data-split-user`, `data-split-shopper`, `data-fee`), `ruling-problems`, `ruling-countersign` (confirm), `ruling-settled`, `ruling-settled-txid` | dispute |
| `refund`, `refund-status` (`data-reached`), `refund-t2`, `order-refund` (confirm), `order-refunded`, `order-refund-txid` | T2 refund / refunded |
| `report`, `report-subject`, `report-text`, `report-send`, `report-sent` | report to the operator |
| `order-timeline`, `order-timeline-item` (`data-kind`) | timeline |

## escrow

| testid | |
|---|---|
| `escrow-profile`, `escrow-profile-name`, `-bps`, `-min-sats`, `-min-usdc`, `-dispute-bps`, `escrow-profile-publish`, `escrow-profile-published` | profile (kind 30503) |
| `escrow-cases`, `escrow-case-row` (`data-order-id`, `data-status`), `escrow-case-open-<id8>`, `escrow-cases-empty` | cases |
| `escrow-case` (`data-order-id`, `data-status`), `escrow-case-status`, `escrow-verification` (`data-ok`), `escrow-conflicts`, `escrow-check-obligation` | case |
| `escrow-dispute`, `escrow-missing`, `escrow-request-evidence` | disputes and missing evidence |
| `escrow-evidence`, `escrow-evidence-message`, `escrow-evidence-item` (`data-integrity`), `escrow-attachment` (`data-sha256`) | evidence |
| `escrow-decrypt-address`, `escrow-address` | delivery address |
| `escrow-ruling`, `ruling-distributable` (`data-amount`), `ruling-preset-user`, `ruling-preset-shopper`, `ruling-user`, `ruling-shopper`, `ruling-fee` (`data-fee`, `data-split-ok`), `ruling-reason`, `ruling-submit`, `ruling-sent`, `ruling-terms-error`, `escrow-settled` | ruling |

## operator / coordinator

| testid | |
|---|---|
| `operator-delegated` (`data-delegated`) | delegated by the coordinator? |
| `operator-list`, `operator-version` (`data-version`), `operator-entries`, `operator-entry` (`data-escrow`), `operator-entry-remove-<i>`, `operator-fill-demo`, `operator-publish`, `operator-published` | list (kind 30501) |
| `operator-reports`, `operator-report` (`data-subject`, `data-order-id`), `operator-reports-empty`, `operator-remove-escrow`, `operator-removed` | reports |
| `operator-bond`, `operator-bond-amount`, `operator-bond-slash-amount`, `operator-bond-slash` | optional bond (only with the bond contract) |
| `coordinator-operator`, `coordinator-note`, `coordinator-delegate` | delegate (kind 30500) |
| `coordinator-delegations`, `coordinator-delegation` (`data-operator`, `data-revoked`), `coordinator-revoke-<pk8>`, `coordinator-restore-<pk8>` | delegations |

## shopper（ノード）/ lab 操作

| testid | |
|---|---|
| `shopper-status`, `shopper-node-status` (`data-paused`), `shopper-orders`, `shopper-order-row` (`data-order-id`, `data-state`), `shopper-order`, `shopper-order-state` (`data-state`), `shopper-order-history`, `shopper-resolve-refund` (confirm; only for `needs_human`) | Go shopper node |
| `lab-heights` (`data-btc`, `data-evm-time`), `lab-mine-blocks`, `lab-mine`, `lab-evm-seconds`, `lab-evm-time` | chains |
| `lab-shopper-state` (`data-paused`), `lab-pause-shopper`, `lab-resume-shopper`, `lab-shopper-gas` | shopper-1 node |
| `lab-rates-current`, `lab-rates-pair`, `lab-rates-value`, `lab-rates-set`, `lab-rates-reset` | rate mock |
