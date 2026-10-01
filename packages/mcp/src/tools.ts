/**
 * Tool handlers. Every handler returns a short text for the agent plus structured data. Protocol logic stays in
 * @proxy-shopping/core (UserClient, TrustDirectory, checkQuote, …); this file only selects, gates and explains.
 *
 * Tools that move money, sign a payout/transaction or disclose secrets (fund_order, confirm_receipt, open_dispute,
 * countersign_ruling, accept_refund_offer, refund_after_timelock, export_backup) do nothing without `confirm: true`:
 * they return what would happen instead.
 */
import {
  covers, formatUnits, parseUnits, requestItemsProblem, sleep,
  type Address, type DirectorySnapshot, type DisputeOpen, type Offer, type Payment, type UserOrder, type UserOrderStatus,
} from '@proxy-shopping/core/node';
import { REGISTRY_REPO } from './config.js';
import { becomeShopperPlan, registryEntry, type RegistryRole } from './earn.js';
import type { Runtime } from './runtime.js';

export interface ToolResult {
  text: string;
  data: Record<string, unknown>;
}

const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
const short = (pk: string) => `${pk.slice(0, 8)}…`;

export function formatAmount(p: Payment, v: string | bigint | undefined): string | undefined {
  if (v === undefined) return undefined;
  const b = typeof v === 'bigint' ? v : parseUnits(v);
  return p === 'btc-signet' ? `${b} sats (${formatUnits(b, 8)} signet BTC)` : `${formatUnits(b, 6)} USDC`;
}

const DONE: readonly UserOrderStatus[] = ['completed', 'settled', 'refunded', 'cancelled', 'rejected'];

// ---------- order views ----------

export function quoteValidation(o: UserOrder) {
  const c = o.quoteCheck;
  const q = o.quote;
  if (!c || !q) return undefined;
  return {
    ok: c.ok,
    errors: c.errors,
    warnings: c.warnings,
    acknowledgement_required: c.ackRequired,
    rate: c.fx && {
      pair: c.fx.pair,
      quoted: c.fx.quoted,
      our_sources: c.fx.own,
      deviation_percent: Math.round(c.fx.deviation * 10000) / 100,
      level: c.fx.level,
      meaning: 'ok ≤ 3 %, warn > 3 %, strong > 10 % (strong needs acknowledge_rate_deviation)',
    },
    escrow_address: !q.escrow_address ? undefined : {
      quoted: q.escrow_address,
      recomputed_by_us: c.escrowAddress,
      matches: !!c.escrowAddress && c.escrowAddress.toLowerCase() === q.escrow_address.toLowerCase(),
      meaning: o.payment === 'btc-signet'
        ? 'P2WSH 2-of-3 (user, shopper, escrow) rebuilt from our key, the shopper key and the escrow xpub, with the quoted timelocks'
        : 'Safe predicted from the three owners, timelocks and the contracts the operator list vouches for',
    },
    timelocks: q.timelock && {
      t1: q.timelock.t1,
      t2: q.timelock.t2,
      unit: o.payment === 'btc-signet' ? 'block height' : 'unix seconds',
      meaning: 'before T1 funds move only with 2 of 3 signatures; after T1 the shopper can claim alone if nobody disputed; after T2 you can take everything back alone',
    },
  };
}

export function nextSteps(o: UserOrder): string[] {
  const s: string[] = [];
  const id = o.id;
  switch (o.status) {
    case 'requested':
      s.push(`Waiting for the shopper's quote: get_order {order_id: "${id}", wait_for: ["quoted", "rejected"]}. cancel_order is possible.`);
      break;
    case 'quoted':
      if (o.quoteCheck?.ok) {
        s.push(o.quoteCheck.ackRequired.length
          ? `The quote is valid but needs your acknowledgement (${o.quoteCheck.ackRequired.join('; ')}). If acceptable: accept_quote {order_id, acknowledge_rate_deviation: true}. Otherwise cancel_order.`
          : `Review the price and validation, then accept_quote {order_id: "${id}"} (or cancel_order).`);
      } else {
        s.push('The quote FAILED validation: do not accept it. cancel_order and try another offer (and consider report).');
      }
      break;
    case 'rejected':
      s.push(`The shopper declined (${o.quote?.reject_reason ?? 'no reason'}${o.quote?.detail ? `: ${o.quote.detail}` : ''}). Try another offer from find_offers.`);
      break;
    case 'accepted':
    case 'funding':
      s.push(`Fund the escrow: fund_order {order_id: "${id}"} shows amounts and recipients; then fund_order with confirm: true.`);
      break;
    case 'funded':
      s.push('Funded. Waiting for the shopper to buy the items (purchased) and ship them. get_order to follow.');
      break;
    case 'purchased':
    case 'shipped':
      s.push('Waiting for delivery. When the items arrive and are right: confirm_receipt. If they never arrive or are wrong: open_dispute.');
      break;
    case 'delivered':
      s.push(`The shopper reports delivery. If you have the items and they are right: confirm_receipt {order_id: "${id}"} (pays the shopper). Otherwise open_dispute.`);
      break;
    case 'delivery_failed':
      s.push('Delivery failed. Wait for a cooperative refund offer from the shopper (accept_refund_offer), or open_dispute with claim not_delivered.');
      break;
    case 'released':
      s.push('You signed the payout; waiting for the shopper to co-sign and broadcast it. The order becomes completed once the payment is on chain.');
      break;
    case 'disputed':
      s.push('Dispute open. The escrow rules before T1; then review_ruling and countersign_ruling.');
      break;
    case 'ruled':
      s.push(`The escrow ruled: review_ruling {order_id: "${id}"}, then countersign_ruling with confirm: true if it matches.`);
      break;
    default:
      if (DONE.includes(o.status)) s.push('Nothing left to do for this order.');
  }
  if (o.refundOffer && !o.refundTxid) {
    s.push(o.refundOffer.problems.length
      ? `There is a refund offer but it does not match the template (${o.refundOffer.problems.join('; ')}); do not accept it.`
      : `The shopper offers a refund of ${o.refundOffer.amount ?? '?'}: accept_refund_offer {order_id: "${id}"} (preview), then confirm: true.`);
  }
  if ((o.funded || o.fundingProgress) && !o.escrowSpent && !DONE.includes(o.status) && o.quote?.timelock) {
    s.push(`Safety net: after T2 (${o.payment === 'btc-signet' ? `block ${o.quote.timelock.t2}` : iso(o.quote.timelock.t2)}) refund_after_timelock returns the locked funds to you alone.`);
  }
  return s;
}

export function orderView(o: UserOrder, opts: { timeline?: number } = {}) {
  const q = o.quote;
  return {
    order_id: o.id,
    status: o.status,
    payment: o.payment,
    created_at: iso(o.createdAt),
    updated_at: iso(o.updatedAt),
    shop_url: o.request.shop_url,
    region: o.request.shop_region,
    items: o.request.items,
    shopper: { pubkey: o.shopper, name: o.shopperProfile?.name },
    escrow: { pubkey: o.escrow, name: o.escrowProfile?.name },
    provenance: o.entry.provenance,
    quote: q && (q.accept
      ? {
        lock_amount: q.lock_amount,
        lock_amount_text: formatAmount(o.payment, q.lock_amount),
        escrow_upfront_fee: formatAmount(o.payment, q.escrow_upfront_fee ?? '0'),
        payout_fee_reserve: formatAmount(o.payment, q.payout_fee_reserve ?? '0'),
        price: q.price,
        fx: q.fx && { pair: q.fx.pair, rate: q.fx.rate },
        expires_at: iso(q.expires_at),
        escrow_address: q.escrow_address,
        timelock: q.timelock,
      }
      : { declined: q.reject_reason ?? 'unknown', detail: q.detail }),
    validation: quoteValidation(o),
    funding: o.funded
      ? o.funded.asset === 'btc-signet' ? { txid: o.funded.txid, vout: o.funded.vout, amount: o.funded.amount } : { safe: o.funded.safe, fund_tx: o.funded.fund_tx, amount: o.funded.amount }
      : o.fundingProgress,
    purchased: o.purchased && { shop_order_id: o.purchased.shop_order_id, total: o.purchased.total },
    tracking: o.tracking.at(-1),
    dispute: o.dispute && { claim: o.dispute.open.claim, text: o.dispute.open.text },
    shopper_dispute: o.shopperDispute && { claim: o.shopperDispute.open.claim, text: o.shopperDispute.open.text },
    ruling: o.ruling && { split: o.ruling.split, reason: o.ruling.reason, no_obligation: o.ruling.no_obligation },
    pending_ruling: o.pendingRuling ? 'a ruling arrived before the dispute was known; it is evaluated once it is' : undefined,
    refund_offer: o.refundOffer && { amount: o.refundOffer.amount, recipient: o.refundOffer.recipient, problems: o.refundOffer.problems },
    settlement: {
      pending: o.pendingSettlement,
      completed_txid: o.completedTxid,
      settled_txid: o.settledTxid,
      refund_txid: o.refundTxid,
      escrow_spent: o.escrowSpent,
    },
    last_error: o.lastError,
    dropped_messages: o.dropped?.slice(-3),
    timeline: o.timeline.slice(-(opts.timeline ?? 10)).map((t) => ({ at: iso(t.at), kind: t.kind, text: t.text })),
    next_steps: nextSteps(o),
  };
}

function orderLine(o: UserOrder): string {
  return `${o.id} ${o.status} ${o.request.shop_url} ${o.request.items.map((i) => `${i.sku}×${i.qty}`).join(',')}${o.quote?.lock_amount ? ` ${formatAmount(o.payment, o.quote.lock_amount)}` : ''}`;
}

// ---------- offers ----------

export function offerView(snap: DirectorySnapshot | undefined, o: Offer, index: number, region: string) {
  const s = o.shopper?.content;
  const e = o.escrow?.content;
  const list = snap?.lists.get(o.entry.provenance.operator);
  return {
    index,
    shopper: {
      pubkey: o.entry.shopper,
      name: s?.name,
      fee: s?.fee && { bps: s.fee.bps, percent: s.fee.bps / 100, min: s.fee.min },
      delivery_days: s?.delivery_days,
      currencies: s?.currencies,
      payments: s?.payments,
      cash_regions: s?.cash_regions,
      can_pay_cash_here: !!s?.cash_regions?.some((r) => covers(r, region)),
      max_order: s?.max_order,
      profile_known: !!s,
    },
    escrow: {
      pubkey: o.entry.escrow,
      name: e?.name,
      upfront_fee: e?.upfront_fee,
      dispute_fee_bps: e?.dispute_fee_bps,
      sla_days: o.entry.escrow_sla_days,
      profile_known: !!e,
    },
    listed_for: { region: o.entry.region, shops: o.entry.shops, payments: o.entry.payments, tags: o.entry.tags },
    provenance: {
      coordinator: o.entry.provenance.coordinator,
      operator: o.entry.provenance.operator,
      operator_list: list?.content.name,
      list_version: o.entry.provenance.listVersion,
    },
  };
}

// ---------- the tools ----------

interface OfferQuery {
  shopUrl: string;
  region: string;
  payment: Payment;
}

export class Tools {
  private lastOffers?: { q: OfferQuery; offers: Offer[]; at: number };

  constructor(private readonly rt: Runtime) {}

  private get user() {
    return this.rt.user;
  }

  private async order(id: string): Promise<UserOrder> {
    const o = await this.user.getOrder(id);
    if (!o) throw new Error(`no order ${id} in this data dir (list_orders shows the known ones)`);
    return o;
  }

  async waitStatus(id: string, want: UserOrderStatus[], seconds: number): Promise<UserOrder> {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      const o = await this.order(id);
      if (want.includes(o.status) || Date.now() >= end) return o;
      await sleep(250);
    }
  }

  private async trust(refresh: boolean): Promise<DirectorySnapshot | undefined> {
    if (refresh) return this.rt.trust.refresh();
    return this.rt.session.directory.current ?? this.rt.trust.refresh();
  }

  async networkInfo(p: { refresh?: boolean } = {}): Promise<ToolResult> {
    const cfg = this.rt.cfg;
    let snap: DirectorySnapshot | undefined;
    let trustError: string | undefined;
    try {
      snap = await this.trust(p.refresh ?? true);
    } catch (err) {
      trustError = (err as Error).message;
      snap = this.rt.session.directory.current;
    }
    const entries = snap?.entries ?? [];
    const shoppers = new Set(entries.map((e) => e.shopper));
    const escrows = new Set(entries.map((e) => e.escrow));
    const regions = [...new Set(entries.map((e) => e.region))].sort();
    const ts = this.rt.trust.status();
    const status: string[] = [...cfg.notes];
    if (!entries.length) {
      status.push(`No trusted shopper × escrow combination is visible right now under ${cfg.coordinators.length} coordinator(s). ` +
        'That means nobody can take orders here yet (or the relays did not answer). You can still set up a wallet, and you can earn by becoming a shopper (become_shopper).');
    } else {
      status.push(`${entries.length} trusted shopper × escrow combination(s): ${shoppers.size} shopper(s), ${escrows.size} escrow(s), regions ${regions.join(', ')}.`);
    }
    if (ts.errors.length) status.push(`Registry: ${ts.errors.join('; ')}`);
    if (trustError) status.push(`Trust refresh failed: ${trustError}`);
    if (this.rt.evmNote) status.push(this.rt.evmNote);
    const data = {
      network: cfg.network,
      preset: cfg.preset,
      relays: cfg.relays,
      relay_routes: cfg.relayMap,
      coordinators: cfg.coordinators,
      chains: {
        btc: cfg.esplora ? { network: 'signet', esplora: cfg.esplora, payment: 'btc-signet' } : undefined,
        evm: this.rt.session.evm ? { chain_id: this.rt.session.evm.chainId, rpc: cfg.evmRpc, payment: 'usdc-evm' } : undefined,
      },
      timelock_policy: cfg.timelockPolicy ?? 'spec defaults (§4.5.1)',
      trust: {
        combinations: entries.length,
        shoppers: shoppers.size,
        escrows: escrows.size,
        regions,
        operators: [...(snap?.lists.values() ?? [])].map((l) => ({ operator: l.operator, name: l.content.name, version: l.version, regions: l.content.regions })),
        registry: ts,
        evaluated_at: snap ? new Date(snap.fetchedAt).toISOString() : undefined,
      },
      identity: await this.rt.session.pubkey(),
      p2p: cfg.p2p?.enabled
        ? this.rt.p2p
          ? (({ peerId, circuitAddrs, relays, peers, gossipReceived, syncReceived, messagesSent, messagesReceived }) =>
            ({ peer_id: peerId, circuit_addrs: circuitAddrs, relays, peers, gossip_received: gossipReceived, sync_received: syncReceived, messages_sent: messagesSent, messages_received: messagesReceived }))(this.rt.p2p.status())
          : { error: this.rt.p2pError ?? 'starting' }
        : { enabled: false },
      trust_from_nostr: this.rt.session.trustFromNostr,
      status,
    };
    return { text: [`Network ${cfg.network} (${cfg.preset}).`, ...status].join('\n'), data };
  }

  async wallet(): Promise<ToolResult> {
    const s = this.rt.session;
    const k = s.keys;
    const b = await this.user.balances().catch((err: Error) => ({ error: err.message }) as { error: string });
    const bal = 'error' in b ? undefined : b;
    const data: Record<string, unknown> = {
      identity_pubkey: await s.pubkey(),
      btc: { network: 'signet', address: k.btcWallet.address, balance_sats: bal?.btcSats?.toString(), balance: bal?.btcSats !== undefined ? formatAmount('btc-signet', bal.btcSats) : undefined },
      evm: s.evm ? { chain_id: s.evm.chainId, address: k.evmAddress, eth_wei: bal?.eth?.toString(), usdc: bal?.usdc !== undefined ? formatAmount('usdc-evm', bal.usdc) : undefined } : undefined,
      balance_error: 'error' in b ? b.error : undefined,
      data_dir: this.rt.dataDir,
      new_identity: this.rt.identityCreated || undefined,
      funding_hint: this.rt.faucet
        ? 'lab: lab_faucet {btc_sats: 1000000} sends test coins to this wallet.'
        : 'Send signet BTC to the address (e.g. from a public signet faucet). Signet coins have no market value.',
      backup_hint: 'The mnemonic is in the data dir (mode 0600). export_backup with confirm: true shows it; keep it offline.',
    };
    const lines = [
      `Identity ${data.identity_pubkey}`,
      `BTC (signet) ${k.btcWallet.address}: ${(data.btc as { balance?: string }).balance ?? `balance unavailable (${data.balance_error})`}`,
    ];
    if (s.evm) lines.push(`EVM chain ${s.evm.chainId} ${k.evmAddress}: ${bal?.usdc !== undefined ? formatAmount('usdc-evm', bal.usdc) : '? USDC'}, ${bal?.eth !== undefined ? `${formatUnits(bal.eth, 18)} ETH` : '? ETH'}`);
    lines.push(data.funding_hint as string);
    return { text: lines.join('\n'), data };
  }

  async labFaucet(p: { btc_sats?: number; usdc?: string; eth?: string; mine_blocks?: number }): Promise<ToolResult> {
    const f = this.rt.faucet;
    if (!f) throw new Error('lab_faucet exists only on the lab network (PS_NETWORK=lab)');
    const k = this.rt.session.keys;
    const done: Record<string, unknown> = {};
    if (p.btc_sats) done.btc = await f.btc(k.btcWallet.address, p.btc_sats);
    if (p.usdc || p.eth) done.evm = await f.evm(k.evmAddress, { usdc: p.usdc, eth: p.eth });
    if (p.mine_blocks) done.mined = await f.mine(p.mine_blocks);
    if (!Object.keys(done).length) throw new Error('give btc_sats, usdc/eth or mine_blocks');
    const parts = [
      p.btc_sats ? `${p.btc_sats} sats to ${k.btcWallet.address}` : '',
      p.usdc || p.eth ? `${p.usdc ?? '1000'} USDC / ${p.eth ?? '1'} ETH to ${k.evmAddress}` : '',
      p.mine_blocks ? `mined ${p.mine_blocks} block(s)` : '',
    ].filter(Boolean);
    return { text: `lab faucet: ${parts.join('; ')}.`, data: done };
  }

  async findOffers(p: { shop_url: string; region: string; payment?: Payment }): Promise<ToolResult> {
    const q: OfferQuery = { shopUrl: p.shop_url, region: p.region, payment: p.payment ?? 'btc-signet' };
    if (q.payment === 'usdc-evm' && !this.rt.session.evm) throw new Error(`USDC is not available on ${this.rt.cfg.network}: use payment "btc-signet"`);
    const snap = await this.trust(true);
    const offers = await this.user.discoverOffers({ ...q, refresh: false });
    this.lastOffers = { q, offers, at: Date.now() };
    const views = offers.map((o, i) => offerView(snap, o, i, q.region));
    const total = snap?.entries.length ?? 0;
    const note = offers.length
      ? `${offers.length} trusted shopper × escrow combination(s) for ${q.shopUrl} in ${q.region} paid with ${q.payment}. Pick one by index for request_quote.`
      : total
        ? `No trusted combination covers ${q.shopUrl} in ${q.region} with ${q.payment}. The network has ${total} combination(s) in regions ${[...new Set(snap!.entries.map((e) => e.region))].join(', ')}.`
        : `No trusted shopper × escrow combination exists on ${this.rt.cfg.network} right now${this.rt.cfg.preset === 'ps-main' ? ' (the public network is new and may have no shoppers yet)' : ''}.`;
    const lines = [note, ...views.map((v) =>
      `[${v.index}] shopper ${v.shopper.name ?? short(v.shopper.pubkey)} (fee ${v.shopper.fee?.percent ?? '?'} %, ${v.shopper.delivery_days ?? '?'} days${v.shopper.can_pay_cash_here ? ', pays cash here' : ''}) × escrow ${v.escrow.name ?? short(v.escrow.pubkey)} (upfront ${v.escrow.upfront_fee ? `${v.escrow.upfront_fee.bps} bps` : '?'}) via ${v.provenance.operator_list ?? short(v.provenance.operator)}`)];
    return { text: lines.join('\n'), data: { query: q, offers: views, trusted_combinations_total: total } };
  }

  private async resolveOffer(p: { offer_index?: number; shopper?: string; escrow?: string }, q: OfferQuery): Promise<Offer> {
    if (p.shopper || p.escrow) {
      if (!p.shopper || !p.escrow) throw new Error('give both shopper and escrow pubkeys (or offer_index)');
      await this.trust(true);
      const offers = await this.user.discoverOffers({ ...q, refresh: false });
      const o = offers.find((x) => x.entry.shopper === p.shopper!.toLowerCase() && x.entry.escrow === p.escrow!.toLowerCase());
      if (!o) throw new Error(`shopper ${short(p.shopper)} × escrow ${short(p.escrow)} is not a trusted combination for ${q.shopUrl} in ${q.region} with ${q.payment} (find_offers lists the ones that are)`);
      return o;
    }
    if (p.offer_index === undefined) throw new Error('give offer_index (from find_offers) or shopper + escrow');
    const last = this.lastOffers;
    if (!last || last.q.shopUrl !== q.shopUrl || last.q.region !== q.region || last.q.payment !== q.payment) {
      throw new Error('call find_offers with the same shop_url, region and payment first; offer_index refers to its result');
    }
    const o = last.offers[p.offer_index];
    if (!o) throw new Error(`offer_index ${p.offer_index} is out of range (find_offers returned ${last.offers.length})`);
    return o;
  }

  async requestQuote(p: {
    offer_index?: number; shopper?: string; escrow?: string; shop_url: string; region: string; payment?: Payment;
    items: Array<{ sku: string; qty: number }>; address: Address; wait_seconds?: number;
  }): Promise<ToolResult> {
    const q: OfferQuery = { shopUrl: p.shop_url, region: p.region, payment: p.payment ?? 'btc-signet' };
    const problem = requestItemsProblem(p.items);
    if (problem) throw new Error(problem);
    const offer = await this.resolveOffer(p, q);
    const created = await this.user.createOrder({ offer, shopUrl: q.shopUrl, region: q.region, items: p.items, payment: q.payment, address: p.address });
    const o = await this.waitStatus(created.id, ['quoted', 'rejected', 'cancelled'], p.wait_seconds ?? 60);
    const v = orderView(o, { timeline: 4 });
    const lines = [`Order ${o.id}: ${o.status}.`];
    if (o.status === 'quoted' && o.quote) {
      lines.push(`Quote: lock ${formatAmount(o.payment, o.quote.lock_amount)} + escrow upfront fee ${formatAmount(o.payment, o.quote.escrow_upfront_fee ?? '0')} (price ${o.quote.price?.items.amount} + shipping ${o.quote.price?.shipping.amount} + shopper fee ${o.quote.price?.shopper_fee.amount} ${o.quote.price?.items.currency}, rate ${o.quote.fx?.pair} ${o.quote.fx?.rate}).`);
      const val = v.validation!;
      lines.push(`Validation: ${val.ok ? 'OK' : `FAILED: ${val.errors.join('; ')}`}; rate ${val.rate ? `${val.rate.deviation_percent} % off our sources (${val.rate.level})` : 'not checked'}; escrow address ${val.escrow_address?.matches ? 'matches our computation' : 'DOES NOT match'}; T1 ${o.quote.timelock?.t1}, T2 ${o.quote.timelock?.t2}.`);
      if (val.warnings.length) lines.push(`Warnings: ${val.warnings.join('; ')}`);
      if (val.acknowledgement_required.length) lines.push(`Needs acknowledgement: ${val.acknowledgement_required.join('; ')}`);
    } else if (o.status === 'requested') {
      lines.push(`No answer within ${p.wait_seconds ?? 60} s. The server keeps listening; check with get_order {order_id: "${o.id}", wait_for: ["quoted", "rejected"]}.`);
      if (o.lastError) lines.push(`Last error: ${o.lastError}`);
    }
    lines.push(...v.next_steps);
    return { text: lines.join('\n'), data: v };
  }

  async getOrder(p: { order_id: string; wait_for?: UserOrderStatus[]; wait_seconds?: number }): Promise<ToolResult> {
    const o = p.wait_for?.length ? await this.waitStatus(p.order_id, p.wait_for, p.wait_seconds ?? 30) : await this.order(p.order_id);
    const v = orderView(o);
    const waited = p.wait_for?.length && !p.wait_for.includes(o.status) ? ` (still not ${p.wait_for.join('/')} after ${p.wait_seconds ?? 30} s)` : '';
    return { text: [`${orderLine(o)}${waited}`, ...(o.lastError ? [`Last error: ${o.lastError}`] : []), ...v.next_steps].join('\n'), data: v };
  }

  async listOrders(p: { status?: UserOrderStatus[]; limit?: number } = {}): Promise<ToolResult> {
    const all = await this.user.listOrders();
    const rows = all.filter((o) => !p.status?.length || p.status.includes(o.status)).slice(0, p.limit ?? 20);
    return {
      text: rows.length ? rows.map(orderLine).join('\n') : 'No orders.',
      data: { total: all.length, orders: rows.map((o) => ({ order_id: o.id, status: o.status, created_at: iso(o.createdAt), shop_url: o.request.shop_url, items: o.request.items, payment: o.payment, lock_amount: o.quote?.lock_amount, next_steps: nextSteps(o) })) },
    };
  }

  async acceptQuote(p: { order_id: string; acknowledge_rate_deviation?: boolean }): Promise<ToolResult> {
    const before = await this.order(p.order_id);
    if (before.status !== 'quoted') throw new Error(`cannot accept in status ${before.status}`);
    const ack = before.quoteCheck?.ackRequired ?? [];
    if (before.quoteCheck?.ok && ack.length && !p.acknowledge_rate_deviation) {
      return {
        text: `Not accepted: the quote needs your explicit acknowledgement: ${ack.join('; ')}. Call accept_quote again with acknowledge_rate_deviation: true if that is acceptable.`,
        data: { done: false, acknowledgement_required: ack, order: orderView(before, { timeline: 3 }) },
      };
    }
    const o = await this.user.acceptQuote(p.order_id, { acknowledgeRateDeviation: p.acknowledge_rate_deviation });
    const v = orderView(o, { timeline: 3 });
    return { text: [`Accepted the quote of order ${o.id} (${o.status}). Nothing is paid yet.`, ...v.next_steps].join('\n'), data: { done: true, order: v } };
  }

  async fundOrder(p: { order_id: string; confirm?: boolean }): Promise<ToolResult> {
    const o = await this.order(p.order_id);
    if (o.status !== 'accepted' && o.status !== 'funding') throw new Error(`cannot fund in status ${o.status}${o.status === 'quoted' ? ' (accept_quote first)' : ''}`);
    let preview;
    try {
      preview = await this.user.previewFunding(p.order_id);
    } catch (err) {
      const w = await this.wallet().catch(() => undefined);
      throw new Error(`cannot prepare the funding: ${(err as Error).message}${w ? ` — wallet: ${w.text.split('\n')[1]}` : ''}`);
    }
    const pv = {
      asset: preview.asset,
      recipients: preview.recipients.map((r) => ({ label: r.label, address: r.address, amount: formatAmount(o.payment, r.amount) })),
      network_fee: preview.networkFee !== undefined ? formatAmount(o.payment, preview.networkFee) : undefined,
      fee_rate_sat_vb: preview.feeRate,
      total: formatAmount(o.payment, preview.total),
    };
    if (!p.confirm) {
      return {
        text: [
          `Not sent. fund_order with confirm: true will pay ${pv.total} from this wallet:`,
          ...pv.recipients.map((r) => `- ${r.amount} to ${r.label} ${r.address}`),
          ...(pv.network_fee ? [`- network fee ${pv.network_fee} (${pv.fee_rate_sat_vb} sat/vB)`] : []),
          'The lock goes to the 2-of-3 escrow address the quote validation recomputed; the upfront fee pays the escrow for handling disputes.',
        ].join('\n'),
        data: { done: false, would_pay: pv, validation: quoteValidation(o) },
      };
    }
    const after = await this.user.fund(p.order_id);
    const v = orderView(after, { timeline: 3 });
    const tx = after.funded?.asset === 'btc-signet' ? after.funded.txid : after.funded?.fund_tx;
    return {
      text: [`Funded order ${after.id}: ${pv.total} sent (tx ${tx}). Status ${after.status}. The shopper buys once the funding is confirmed on chain.`, ...v.next_steps].join('\n'),
      data: { done: true, paid: pv, txid: tx, order: v },
    };
  }

  async confirmReceipt(p: { order_id: string; confirm?: boolean; wait_seconds?: number }): Promise<ToolResult> {
    const o = await this.order(p.order_id);
    if (!o.funded) throw new Error(`order ${o.id} is not funded (status ${o.status})`);
    const q = o.quote!;
    const pay = o.payment === 'btc-signet'
      ? { to: q.shopper_btc_address, amount: formatAmount(o.payment, parseUnits(q.lock_amount!) - parseUnits(q.payout_fee_reserve ?? '0')), network_fee: formatAmount(o.payment, q.payout_fee_reserve ?? '0') }
      : { to: q.shopper_evm_address, amount: formatAmount(o.payment, q.lock_amount!) };
    const warn = o.status === 'delivered' ? [] : [`The shopper has not reported delivery (status ${o.status}). Release only if you have the items.`];
    if (!p.confirm) {
      return {
        text: [`Not signed. confirm_receipt with confirm: true signs the escrow payout of ${pay.amount} to the shopper (${pay.to}); the shopper co-signs and broadcasts it. This cannot be undone.`, ...warn].join('\n'),
        data: { done: false, would_pay: pay, status: o.status, warnings: warn },
      };
    }
    await this.user.release(p.order_id);
    const after = await this.waitStatus(p.order_id, ['completed'], p.wait_seconds ?? 20);
    const v = orderView(after, { timeline: 4 });
    return {
      text: [`Released order ${after.id}: status ${after.status}.${after.completedTxid ? ` Payout ${after.completedTxid} confirmed on chain.` : ' Waiting for the shopper to broadcast and the chain to confirm.'}`, ...v.next_steps].join('\n'),
      data: { done: true, payout: pay, order: v },
    };
  }

  async openDispute(p: { order_id: string; claim: DisputeOpen['claim']; text: string; requested_split?: { user: string; shopper: string }; confirm?: boolean }): Promise<ToolResult> {
    const o = await this.order(p.order_id);
    if (!p.confirm) {
      return {
        text: [
          `Not sent. open_dispute with confirm: true sends a ${p.claim} dispute to escrow ${o.escrowProfile?.name ?? short(o.escrow)} (copy to the shopper) with all signed messages of this order as evidence,`,
          'including the key that lets the escrow decrypt your delivery address. The escrow rules a split before T1; you then review and countersign it.',
        ].join(' '),
        data: { done: false, would_send: { to: o.escrow, claim: p.claim, text: p.text, requested_split: p.requested_split }, status: o.status },
      };
    }
    const after = await this.user.openDispute(p.order_id, { claim: p.claim, text: p.text, requestedSplit: p.requested_split });
    const v = orderView(after, { timeline: 3 });
    return { text: [`Dispute opened for order ${after.id} (${after.status}).`, ...v.next_steps].join('\n'), data: { done: true, order: v } };
  }

  async reviewRuling(p: { order_id: string }): Promise<ToolResult> {
    const o = await this.order(p.order_id);
    if (!o.ruling) {
      return {
        text: o.pendingRuling ? 'A ruling arrived but the dispute is not confirmed yet; it is held until it is.' : `No ruling yet (status ${o.status}).`,
        data: { ruling: null, status: o.status },
      };
    }
    const problems = await this.user.reviewRuling(p.order_id);
    const r = o.ruling;
    const split = { user: formatAmount(o.payment, r.split.user), shopper: formatAmount(o.payment, r.split.shopper), escrow_fee: formatAmount(o.payment, r.split.escrow_fee) };
    return {
      text: [
        `Ruling: you ${split.user}, shopper ${split.shopper}, escrow fee ${split.escrow_fee}. Reason: ${r.reason}`,
        problems.length ? `The transaction does NOT match the split: ${problems.join('; ')}. Do not countersign; consider report.` : 'The transaction matches the split. countersign_ruling with confirm: true executes it.',
      ].join('\n'),
      data: { ruling: { split, raw_split: r.split, reason: r.reason, no_obligation: r.no_obligation }, problems, matches: problems.length === 0 },
    };
  }

  async countersignRuling(p: { order_id: string; confirm?: boolean }): Promise<ToolResult> {
    if (!p.confirm) {
      const review = await this.reviewRuling(p);
      return { text: `Not signed. ${review.text}`, data: { done: false, ...review.data } };
    }
    const after = await this.user.countersignRuling(p.order_id);
    const v = orderView(after, { timeline: 3 });
    return { text: [`Countersigned and broadcast the ruling of order ${after.id} (${after.status}).`, ...v.next_steps].join('\n'), data: { done: true, order: v } };
  }

  async acceptRefundOffer(p: { order_id: string; confirm?: boolean }): Promise<ToolResult> {
    const o = await this.order(p.order_id);
    if (!o.refundOffer) throw new Error(`no refund offer for order ${o.id}`);
    const problems = await this.user.reviewRefundOffer(p.order_id);
    if (!p.confirm) {
      return {
        text: problems.length
          ? `Not signed. The refund offer does not match the template: ${problems.join('; ')}. Do not accept it.`
          : `Not signed. accept_refund_offer with confirm: true co-signs and broadcasts the shopper's refund of ${o.refundOffer.amount ?? '?'} to ${o.refundOffer.recipient ?? 'your wallet'}.`,
        data: { done: false, offer: { amount: o.refundOffer.amount, recipient: o.refundOffer.recipient }, problems },
      };
    }
    const after = await this.user.acceptRefundOffer(p.order_id);
    const v = orderView(after, { timeline: 3 });
    return { text: [`Accepted the refund of order ${after.id}: tx ${after.refundTxid} (${after.status}).`, ...v.next_steps].join('\n'), data: { done: true, order: v } };
  }

  async refundAfterTimelock(p: { order_id: string; confirm?: boolean }): Promise<ToolResult> {
    const o = await this.order(p.order_id);
    const t2 = o.quote?.timelock?.t2;
    if (!t2 || !(o.funded || o.fundingProgress)) throw new Error(`order ${o.id} has no funded escrow (status ${o.status})`);
    let now: number | undefined;
    try {
      now = o.payment === 'btc-signet' ? await this.rt.session.chain!.tipHeight() : Number(await this.rt.session.evm!.blockTimestamp());
    } catch {
      now = undefined;
    }
    const reached = now !== undefined && now >= t2;
    const lock = parseUnits(o.quote!.lock_amount!);
    const reserve = parseUnits(o.quote!.payout_fee_reserve ?? '0');
    const amount = o.payment === 'btc-signet' ? lock - (reserve > 0n ? reserve : 500n) : lock;
    const to = o.payment === 'btc-signet' ? o.request.user_btc_address : o.request.user_evm_address;
    if (!p.confirm) {
      return {
        text: `Not sent. refund_after_timelock with confirm: true takes ${formatAmount(o.payment, amount)} back to ${to} alone. T2 is ${o.payment === 'btc-signet' ? `block ${t2}, now ${now ?? '?'}` : `${iso(t2)}, chain time ${iso(now)}`}: ${reached ? 'reached' : 'NOT reached yet'}.`,
        data: { done: false, t2, now, reached, would_refund: { to, amount: formatAmount(o.payment, amount) } },
      };
    }
    const after = await this.user.refundAfterTimelock(p.order_id);
    const v = orderView(after, { timeline: 3 });
    return { text: [`Broadcast the T2 refund of order ${after.id}: tx ${after.refundTxid} (${after.status}).`, ...v.next_steps].join('\n'), data: { done: true, order: v } };
  }

  async cancelOrder(p: { order_id: string; reason?: string }): Promise<ToolResult> {
    const o = await this.user.cancel(p.order_id, p.reason);
    return { text: `Order ${o.id} cancelled.`, data: { order: orderView(o, { timeline: 3 }) } };
  }

  async report(p: { order_id: string; subject: 'shopper' | 'escrow'; text: string }): Promise<ToolResult> {
    const o = await this.user.report(p.order_id, { subject: p.subject, text: p.text });
    const operator = this.rt.session.directory.current?.lists.get(o.entry.provenance.operator);
    return {
      text: `Reported the ${p.subject} of order ${o.id} to operator ${operator?.content.name ?? short(o.entry.provenance.operator)}, with the order's signed messages as evidence.`,
      data: { done: true, operator: o.entry.provenance.operator, subject: p.subject === 'shopper' ? o.shopper : o.escrow },
    };
  }

  async exportBackup(p: { confirm?: boolean }): Promise<ToolResult> {
    if (!this.rt.exportMnemonic) throw new Error('this server has no data dir');
    if (!p.confirm) {
      return {
        text: 'Not shown. export_backup with confirm: true returns the 12-word mnemonic that controls this identity and every order escrow key. Anyone who sees it can take the funds; the text will stay in this conversation.',
        data: { done: false },
      };
    }
    const mnemonic = await this.rt.exportMnemonic();
    return {
      text: `Mnemonic (keep offline, never share): ${mnemonic}`,
      data: { done: true, mnemonic, data_dir: this.rt.dataDir, restore: 'Put the words in <PS_DATA_DIR>/mnemonic (mode 0600) of a new data dir, or restore them in the proxy-shopping web app.' },
    };
  }

  async becomeShopper(p: { name?: string; regions?: string[]; cash_regions?: string[]; fee_bps?: number }): Promise<ToolResult> {
    const plan = becomeShopperPlan({ name: p.name, regions: p.regions, cashRegions: p.cash_regions, feeBps: p.fee_bps, identityPubkey: await this.rt.session.pubkey() });
    return {
      text: [plan.summary, plan.honest_status, 'Requirements:', ...plan.requirements.map((r) => `- ${r}`), 'Steps:', ...plan.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n'),
      data: plan,
    };
  }

  async registryEntry(p: {
    role: RegistryRole; name: string; contact: string; description: string; pubkey?: string;
    regions?: string[]; payments?: string[]; escrows?: string[]; sla_days?: number; url?: string; bundle?: string;
  }): Promise<ToolResult> {
    const pubkey = p.pubkey ?? (await this.rt.session.pubkey());
    const e = registryEntry({
      role: p.role, name: p.name, contact: p.contact, description: p.description, pubkey,
      regions: p.regions, payments: p.payments, escrows: p.escrows, slaDays: p.sla_days, url: p.url, bundle: p.bundle,
    });
    return {
      text: [`Add ${e.path} to ${REGISTRY_REPO} in a pull request:`, e.json, ...e.pull_request.steps.map((s) => `- ${s}`),
        ...(p.pubkey ? [] : ['(pubkey: this MCP data dir\'s identity; pass pubkey for a node that runs with its own mnemonic)'])].join('\n'),
      data: e,
    };
  }
}
