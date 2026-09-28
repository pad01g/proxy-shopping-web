/**
 * Building blocks of the scenarios. Every `done` is "this or anything after it happened", so a step is
 * recognised even when the state moved on quickly (the guide checks the steps in order). Words come from the
 * message catalog `m` of the language the scenarios are built for (scenarios/index.ts).
 */
import type { Payment, UserOrderStatus } from '@proxy-shopping/core/browser';
import { label, type Messages } from '../i18n';
import { formatAsset } from '../lib/format';
import type { PresetId } from './presets';
import type { GuideCtx, OrderPreset, Step } from './types';

const set = (...s: UserOrderStatus[]): ReadonlySet<UserOrderStatus> => new Set(s);
const ACCEPTED = set('accepted', 'funding', 'funded', 'purchased', 'shipped', 'delivered', 'delivery_failed', 'released', 'completed', 'disputed', 'ruled', 'settled', 'refunded');
const PURCHASED = set('purchased', 'shipped', 'delivered', 'delivery_failed', 'released', 'completed', 'disputed', 'ruled', 'settled');
const DELIVERED = set('delivered', 'released', 'completed');
const FAILED = set('delivery_failed', 'disputed', 'ruled', 'settled');
const RELEASED = set('released', 'completed');

const BTC_NEEDED = 200_000n;
const USDC_NEEDED = 100_000_000n;
const ETH_NEEDED = 50_000_000_000_000_000n;
/** The shopper node pays the gas of USDC payouts (§6.4). */
const SHOPPER_ETH_NEEDED = 100_000_000_000_000_000n;

const big = (v?: string): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
const has = (o: GuideCtx['order'], s: ReadonlySet<UserOrderStatus>) => !!o && s.has(o.status);

export const assetWords = (m: Messages, p: Payment) => (p === 'btc-signet' ? m.steps.assetBtc : m.steps.assetEvm);

/** "shopper-1 node: Purchasing…" — what the Go node says about the scenario's order. */
export const nodeProgress = (m: Messages) => (ctx: GuideCtx): string => {
  const n = ctx.nodeOrder;
  if (!n) return m.steps.nodeNotYet(ctx.shopper.name);
  return m.steps.nodeState(ctx.shopper.name, label(m.format.nodeState, n.state), n.error);
};

const userProgress = (m: Messages) => (ctx: GuideCtx): string | undefined => {
  const o = ctx.order;
  if (!o) return undefined;
  return m.steps.userState(label(m.format.status, o.status), o.lastError);
};

const both = (m: Messages) => (ctx: GuideCtx) => [nodeProgress(m)(ctx), userProgress(m)(ctx)].filter(Boolean).join(m.common.sep);

const eth = (wei?: string) => (Number(big(wei)) / 1e18).toFixed(3);

// ---------- preparation (every scenario; ✓ when already done) ----------

export function prepareSteps(m: Messages): Step[] {
  const w = m.steps;
  return [
    {
      id: 'prep-delegate',
      actor: 'coordinator',
      ...w.prepDelegate,
      action: (ctx) => ({ testid: 'coordinator-delegate', prefill: { operator: ctx.ids.operator.pubkey } }),
      done: (ctx) => !!ctx.snap.coordinator?.delegations.some((d) => d.operator === ctx.ids.operator.pubkey && !d.revoked),
    },
    {
      id: 'prep-list',
      actor: 'operator',
      ...w.prepList,
      action: { testid: 'operator-publish', prefill: { demo: true } },
      done: (ctx) => {
        const entries = ctx.snap.operator?.list?.entries ?? [];
        return ['JP-13', 'US'].every((region) =>
          entries.some((e) => e.region === region && e.shopper === ctx.shopper.pubkey && e.escrow === ctx.ids.escrow.pubkey && e.payments.length === 2));
      },
    },
    {
      id: 'prep-escrow-profile',
      actor: 'escrow',
      ...w.prepEscrowProfile,
      action: { testid: 'escrow-profile-publish' },
      done: (ctx) => !!ctx.snap.escrow?.profile,
    },
    {
      id: 'prep-node-trust',
      actor: 'shopper',
      title: w.prepNodeTrust.title,
      text: w.prepNodeTrust.text,
      done: (ctx) =>
        ctx.lab.shopper.effective.some((e) => e.shopper === ctx.shopper.pubkey && e.escrow === ctx.ids.escrow.pubkey && e.operator === ctx.ids.operator.pubkey)
        && ctx.lab.shopper.escrowProfiles.includes(ctx.ids.escrow.pubkey),
      progress: (ctx) => {
        const list = ctx.lab.shopper.effective.some((e) => e.escrow === ctx.ids.escrow.pubkey && e.operator === ctx.ids.operator.pubkey);
        const profile = ctx.lab.shopper.escrowProfiles.includes(ctx.ids.escrow.pubkey);
        return w.prepNodeTrust.progress(list ? w.received : w.waiting, profile ? w.received : w.waiting);
      },
    },
    {
      id: 'prep-btc',
      actor: 'user',
      ...w.prepBtc,
      action: { testid: 'wallet-faucet-btc' },
      done: (ctx) => big(ctx.snap.user?.btcSats) >= BTC_NEEDED,
      progress: (ctx) => w.balance(formatAsset(ctx.snap.user?.btcSats, 'btc-signet')),
    },
    {
      id: 'prep-evm',
      actor: 'user',
      ...w.prepEvm,
      action: { testid: 'wallet-faucet-evm' },
      done: (ctx) => big(ctx.snap.user?.usdc) >= USDC_NEEDED && big(ctx.snap.user?.eth) >= ETH_NEEDED,
      progress: (ctx) => w.balance(`${formatAsset(ctx.snap.user?.usdc, 'usdc-evm')}${m.common.sep}ETH ${eth(ctx.snap.user?.eth)}`),
    },
  ];
}

/** USDC payouts are executed (and paid for) by the shopper node: give it gas. */
export const shopperGasStep = (m: Messages): Step => ({
  id: 'lab-shopper-gas',
  actor: 'lab',
  title: m.steps.shopperGas.title,
  text: m.steps.shopperGas.text,
  action: { testid: 'lab-shopper-gas' },
  done: (ctx) => big(ctx.lab.shopper.eth) >= SHOPPER_ETH_NEEDED,
  progress: (ctx) => m.steps.shopperGas.progress(eth(ctx.lab.shopper.eth)),
});

// ---------- from the order to the funding ----------

export function orderStep(m: Messages, p: OrderPreset): Step {
  const shop = p.shopUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    id: 'order',
    actor: 'user',
    title: m.steps.order.title,
    text: m.steps.order.text(shop, p.sku, m.presets.item[p.id as PresetId], assetWords(m, p.payment).coin),
    action: { testid: 'order-submit' },
    done: (ctx) => !!ctx.order,
  };
}

export const quoteWaitStep = (m: Messages): Step => ({
  id: 'quote-wait',
  actor: 'shopper',
  ...m.steps.quoteWait,
  done: (ctx) => !!ctx.order && ctx.order.status !== 'requested',
  progress: both(m),
});

export const acceptStep = (m: Messages, p: Payment): Step => ({
  id: 'accept',
  actor: 'user',
  title: m.steps.accept.title,
  text: m.steps.accept.text(assetWords(m, p).lock),
  action: (ctx) => ({ testid: 'quote-accept', confirm: !!ctx.order?.ackRequired }),
  done: (ctx) => has(ctx.order, ACCEPTED),
  progress: userProgress(m),
});

export const fundStep = (m: Messages, p: Payment): Step => ({
  id: 'fund',
  actor: 'user',
  ...(p === 'btc-signet' ? m.steps.fundBtc : m.steps.fundEvm),
  action: { testid: 'order-fund', confirm: true },
  done: (ctx) => !!ctx.order?.funded,
  progress: userProgress(m),
});

export const purchaseWaitStep = (m: Messages): Step => ({
  id: 'purchase-wait',
  actor: 'shopper',
  ...m.steps.purchaseWait,
  done: (ctx) => has(ctx.order, PURCHASED),
  progress: both(m),
});

export const deliveredWaitStep = (m: Messages): Step => ({
  id: 'delivered-wait',
  actor: 'shopper',
  ...m.steps.deliveredWait,
  done: (ctx) => has(ctx.order, DELIVERED),
  progress: both(m),
});

export const failedWaitStep = (m: Messages): Step => ({
  id: 'failed-wait',
  actor: 'shopper',
  ...m.steps.failedWait,
  done: (ctx) => has(ctx.order, FAILED),
  progress: both(m),
});

// ---------- payout ----------

export const releaseStep = (m: Messages): Step => ({
  id: 'release',
  actor: 'user',
  ...m.steps.release,
  action: { testid: 'order-release', confirm: true },
  done: (ctx) => has(ctx.order, RELEASED),
  progress: userProgress(m),
});

export const completedWaitStep = (m: Messages): Step => ({
  id: 'completed-wait',
  actor: 'chain',
  ...m.steps.completedWait,
  done: (ctx) => ctx.order?.status === 'completed',
  progress: both(m),
});

// ---------- dispute ----------

export const disputeStep = (m: Messages): Step => ({
  id: 'dispute',
  actor: 'user',
  title: m.steps.dispute.title,
  text: m.steps.dispute.text,
  action: { testid: 'dispute-open', prefill: { claim: 'not_delivered', text: m.steps.dispute.prefill } },
  done: (ctx) => !!ctx.order?.dispute,
  progress: userProgress(m),
});

export const caseWaitStep = (m: Messages): Step => ({
  id: 'case-wait',
  actor: 'escrow',
  title: m.steps.caseWait.title,
  text: m.steps.caseWait.text,
  done: (ctx) => !!ctx.escrowCase && ctx.escrowCase.disputes > 0,
  progress: (ctx) => (ctx.escrowCase
    ? m.steps.caseWait.progress(label(m.format.status, ctx.escrowCase.status), ctx.escrowCase.disputes)
    : m.steps.caseWait.none),
});

export const decryptStep = (m: Messages): Step => ({
  id: 'decrypt',
  actor: 'escrow',
  ...m.steps.decrypt,
  action: { testid: 'escrow-decrypt-address' },
  done: (ctx) => !!ctx.escrowCase?.decrypted,
});

export const rulingStep = (m: Messages, to: 'user' | 'shopper'): Step => {
  const w = to === 'user' ? m.steps.rulingUser : m.steps.rulingShopper;
  return {
    id: 'ruling',
    actor: 'escrow',
    title: w.title,
    text: w.text,
    action: { testid: 'ruling-submit', prefill: { preset: to, reason: w.prefill } },
    done: (ctx) => !!ctx.escrowCase?.ruling,
  };
};

export const rulingArrivesStep = (m: Messages): Step => ({
  id: 'ruling-arrives',
  actor: 'user',
  ...m.steps.rulingArrives,
  done: (ctx) => !!ctx.order?.ruling || ctx.order?.status === 'settled',
  progress: userProgress(m),
});

export const countersignStep = (m: Messages): Step => ({
  id: 'countersign',
  actor: 'user',
  ...m.steps.countersign,
  action: { testid: 'ruling-countersign', confirm: true },
  done: (ctx) => ctx.order?.status === 'settled' || !!ctx.order?.pendingSettlement?.mine,
  progress: userProgress(m),
});

/** `who`: the role name of whoever broadcast the settlement. */
export const settledWaitStep = (m: Messages, who: string): Step => ({
  id: 'settled-wait',
  actor: 'chain',
  title: m.steps.settledWait.title,
  text: m.steps.settledWait.text(who),
  done: (ctx) => ctx.order?.status === 'settled',
  progress: both(m),
});

// ---------- refunds ----------

export const refundOfferWaitStep = (m: Messages): Step => ({
  id: 'refund-offer-wait',
  actor: 'shopper',
  ...m.steps.refundOfferWait,
  // A bot result the node cannot interpret goes to a human; in the lab the shopper tab stands in for them.
  action: (ctx) => (ctx.nodeOrder?.state === 'needs_human' ? { testid: 'shopper-resolve-refund', tab: 'shopper', confirm: true } : undefined),
  done: (ctx) => !!ctx.order?.refundOffer || ctx.order?.status === 'refunded',
  progress: both(m),
});

export const acceptRefundStep = (m: Messages): Step => ({
  id: 'refund-accept',
  actor: 'user',
  ...m.steps.refundAccept,
  action: { testid: 'refund-offer-accept', confirm: true },
  done: (ctx) => ctx.order?.status === 'refunded' || ctx.order?.pendingSettlement?.kind === 'refunded' || !!ctx.order?.refundTxid,
  progress: userProgress(m),
});

export const refundedWaitStep = (m: Messages): Step => ({
  id: 'refunded-wait',
  actor: 'chain',
  ...m.steps.refundedWait,
  done: (ctx) => ctx.order?.status === 'refunded',
  progress: userProgress(m),
});
