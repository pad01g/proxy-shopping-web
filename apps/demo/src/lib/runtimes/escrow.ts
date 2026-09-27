import { EscrowClient, type Address, type EscrowProfileContent, type IndexedDBStorage, type Session } from '@proxy-shopping/core/browser';
import type { EscrowSnap } from '../snapshots';
import { createSession, RoleRuntime, type RuntimeDeps } from './base';

/** The terms the demo escrow publishes (the same as the lab's Go escrows, docs/lab.md). */
export const DEMO_ESCROW_TERMS: Pick<EscrowProfileContent, 'name' | 'upfront_fee' | 'dispute_fee_bps'> = {
  name: 'デモの escrow',
  upfront_fee: { bps: 50, min_sats: '1000', min_usdc: '0.50' },
  dispute_fee_bps: 200,
};

const DECRYPTED = 'demo/decrypted/';

/** The escrow role: EscrowClient plus the delivery addresses it decrypted (kept so the guide can see the review). */
export class EscrowRuntime extends RoleRuntime<'escrow'> {
  readonly client: EscrowClient;

  private constructor(session: Session, storage: IndexedDBStorage, deps: RuntimeDeps) {
    super('escrow', session, storage, deps, 5000);
    this.client = new EscrowClient(this.session, { deployments: this.deps.deployments });
  }

  static async create(d: RuntimeDeps): Promise<EscrowRuntime> {
    const { session, storage } = await createSession('escrow', d);
    return new EscrowRuntime(session, storage, d);
  }

  protected async begin(): Promise<void> {
    this.client.attach();
    this.cleanups.push(() => this.client.detach(), this.client.on('case', () => this.changed()));
    await this.session.start();
    void this.session.publishInboxRelays().catch((e) => console.warn('escrow: publishing 10050 failed', e));
  }

  async publishProfile(terms = DEMO_ESCROW_TERMS) {
    const res = await this.client.publishProfile(terms);
    this.changed();
    return res;
  }

  /** Decrypt the delivery address with the key the dispute handed over (§4.4), and remember that we did. */
  async decryptAddress(orderId: string): Promise<Address> {
    const address = await this.client.decryptAddress(orderId);
    await this.session.storage.put(DECRYPTED + orderId, address);
    this.changed();
    return address;
  }

  decryptedAddress(orderId: string): Promise<Address | undefined> {
    return this.session.storage.get<Address>(DECRYPTED + orderId);
  }

  protected async snapshot(): Promise<EscrowSnap> {
    const terms = await this.client.terms().catch(() => undefined);
    const cases = await this.client.listCases();
    const decrypted = new Set((await this.session.storage.list<Address>(DECRYPTED)).map(([k]) => k.slice(DECRYPTED.length)));
    return {
      at: Date.now(),
      profile: terms && { bps: terms.upfront_fee.bps, disputeBps: terms.dispute_fee_bps },
      cases: cases.slice(0, 30).map((c) => ({
        orderId: c.orderId,
        status: c.status,
        disputes: c.disputes.length,
        decrypted: decrypted.has(c.orderId),
        ruling: c.ruling && { user: c.ruling.split.user, shopper: c.ruling.split.shopper, fee: c.ruling.split.escrow_fee },
        settledTxid: c.settledTxid,
      })),
    };
  }
}
