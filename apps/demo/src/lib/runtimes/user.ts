import { UserClient, type IndexedDBStorage, type Offer, type Payment, type Session, type UserOrder } from '@proxy-shopping/core/browser';
import { faucetApi } from '../lab-api';
import type { OrderSnap, UserSnap } from '../snapshots';
import { createSession, RoleRuntime, type RuntimeDeps } from './base';

export interface Balances {
  btcSats?: bigint;
  usdc?: bigint;
  eth?: bigint;
}

/** Orders kept in the snapshot (newest first). */
const SNAPSHOT_ORDERS = 30;

export function orderSnap(o: UserOrder, me: string): OrderSnap {
  return {
    id: o.id,
    status: o.status,
    createdAt: o.createdAt,
    shopUrl: o.request.shop_url,
    region: o.request.shop_region,
    sku: o.request.items[0]?.sku ?? '',
    payment: o.payment,
    shopper: o.shopper,
    escrow: o.escrow,
    rejectReason: o.quote && !o.quote.accept ? o.quote.reject_reason ?? '' : undefined,
    quoteOk: o.quoteCheck?.ok,
    ackRequired: !!o.quoteCheck?.ackRequired?.length,
    lockAmount: o.quote?.lock_amount,
    payoutFeeReserve: o.quote?.payout_fee_reserve,
    t2: o.quote?.timelock?.t2,
    funded: !!o.funded,
    dispute: o.dispute?.open.claim,
    ruling: o.ruling && { user: o.ruling.split.user, shopper: o.ruling.split.shopper, fee: o.ruling.split.escrow_fee },
    refundOffer: o.refundOffer && { problems: o.refundOffer.problems.length },
    pendingSettlement: o.pendingSettlement && { kind: o.pendingSettlement.kind, mine: o.pendingSettlement.from === me },
    completedTxid: o.completedTxid,
    settledTxid: o.settledTxid,
    refundTxid: o.refundTxid,
    reported: o.timeline.some((t) => t.kind === 'report'),
    lastError: o.lastError,
  };
}

/** The user role: UserClient plus the wallet balances and the last offer search, which the guide looks at. */
export class UserRuntime extends RoleRuntime<'user'> {
  readonly client: UserClient;
  balances: Balances = {};
  lastOffers?: { at: number; offers: Offer[] };

  private constructor(session: Session, storage: IndexedDBStorage, deps: RuntimeDeps) {
    super('user', session, storage, deps, 4000);
    this.client = new UserClient(this.session, { deployments: this.deps.deployments });
  }

  static async create(d: RuntimeDeps): Promise<UserRuntime> {
    const { session, storage } = await createSession('user', d);
    return new UserRuntime(session, storage, d);
  }

  protected async begin(): Promise<void> {
    this.client.attach();
    this.cleanups.push(() => this.client.detach(), this.client.on('order', () => this.changed()));
    await this.session.start();
    void this.session.publishInboxRelays().catch((e) => console.warn('user: publishing 10050 failed', e));
    void this.session.directory.refresh().catch(() => undefined);
  }

  get faucet() {
    return faucetApi(this.deps.config.urls.faucet);
  }

  async refreshBalances(): Promise<Balances> {
    this.balances = await this.client.balances();
    this.changed();
    return this.balances;
  }

  /** Candidates for an order, remembered for the guide (the fraud scenario checks that a removed escrow is gone). */
  async searchOffers(q: { shopUrl: string; region: string; payment: Payment }): Promise<Offer[]> {
    const offers = await this.client.discoverOffers({ ...q, refresh: true });
    this.lastOffers = { at: Date.now(), offers };
    this.changed();
    return offers;
  }

  protected async snapshot(): Promise<UserSnap> {
    await this.client.balances().then((b) => (this.balances = b), () => undefined);
    const orders = (await this.client.listOrders()).slice(0, SNAPSHOT_ORDERS).map((o) => orderSnap(o, this.pubkey));
    const b = this.balances;
    return {
      at: Date.now(),
      btcSats: b.btcSats?.toString(),
      usdc: b.usdc?.toString(),
      eth: b.eth?.toString(),
      orders,
      offers: this.lastOffers && {
        at: this.lastOffers.at,
        list: this.lastOffers.offers.map((o) => ({
          region: o.entry.region, shopper: o.entry.shopper, escrow: o.entry.escrow, operator: o.entry.provenance.operator, listVersion: o.entry.provenance.listVersion,
        })),
      },
    };
  }
}
