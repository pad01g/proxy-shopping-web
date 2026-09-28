import {
  OperatorClient, type IndexedDBStorage, type ListEntry, type OperatorList, type OperatorListContent, type Session,
} from '@proxy-shopping/core/browser';
import { msg } from '../../i18n';
import type { OperatorSnap } from '../snapshots';
import { createSession, RoleRuntime, type RuntimeDeps } from './base';

/** The combinations this demo needs: shopper-1 × the demo escrow in Tokyo (JP-13) and the US. */
export function demoEntries(shopper: string, escrow: string): ListEntry[] {
  return ['JP-13', 'US'].map((region) => ({
    region, shopper, escrow, shops: ['*'], payments: ['btc-signet', 'usdc-evm'], tags: [], escrow_sla_days: 14,
  }));
}

/** The operator role: maintains the kind 30501 list and reads reports. */
export class OperatorRuntime extends RoleRuntime<'operator'> {
  readonly client: OperatorClient;
  private list?: OperatorList;

  private constructor(session: Session, storage: IndexedDBStorage, deps: RuntimeDeps) {
    super('operator', session, storage, deps, 5000);
    this.client = new OperatorClient(this.session);
  }

  static async create(d: RuntimeDeps): Promise<OperatorRuntime> {
    const { session, storage } = await createSession('operator', d);
    return new OperatorRuntime(session, storage, d);
  }

  protected async begin(): Promise<void> {
    this.client.attach();
    this.cleanups.push(
      () => this.client.detach(),
      this.client.on('report', () => this.changed()),
      this.client.on('list', (l) => {
        this.list = l;
        this.changed();
      }),
    );
    await this.session.start();
    void this.session.publishInboxRelays().catch((e) => console.warn('operator: publishing 10050 failed', e));
  }

  /** The list as published (relays and our own copy), refreshed on every call. */
  async currentList(): Promise<OperatorList | undefined> {
    const l = await this.client.currentList();
    if (l && (!this.list || l.version >= this.list.version)) this.list = l;
    return this.list;
  }

  /** The list this demo starts from: our current one with the demo combinations added. */
  async demoContent(shopper: string, escrow: string): Promise<OperatorListContent> {
    const cur = (await this.currentList())?.content ?? (await this.client.draft(msg().operator.draftName));
    const d = this.deps.deployments;
    const ep = this.deps.config.list_endpoints;
    const key = (e: ListEntry) => `${e.region}|${e.shopper}|${e.escrow}`;
    const wanted = demoEntries(shopper, escrow);
    return {
      ...cur,
      regions: [...new Set([...cur.regions, 'JP-13', 'US'])],
      relays: this.deps.config.relays.map((url) => ({ url, retention_days: 30 })),
      chain: {
        btc: { network: 'signet', esplora: ep ? [ep.esplora] : [] },
        // The user's app cross-checks its deployments (Safe contracts, module, setup) against this signed copy.
        ...(d ? { evm: { chain_id: d.chain_id, rpc: ep ? [ep.evm_rpc] : [], usdc: d.usdc, safe: { ...d.safe, module: d.module, setup: d.setup } } } : {}),
      },
      entries: [...cur.entries.filter((e) => !wanted.some((w) => key(w) === key(e))), ...wanted],
      report_to: this.pubkey,
    };
  }

  async publish(content: OperatorListContent): Promise<OperatorList> {
    const l = await this.client.publish(content);
    this.list = l;
    this.changed();
    return l;
  }

  /** New version of the list without any combination of `escrow` (after a report). */
  async removeEscrow(escrow: string): Promise<OperatorList> {
    const l = await this.client.removeEntries((e) => e.escrow === escrow);
    this.list = l;
    this.changed();
    return l;
  }

  protected async snapshot(): Promise<OperatorSnap> {
    const list = await this.currentList().catch(() => this.list);
    const reports = await this.client.reports();
    return {
      at: Date.now(),
      list: list && {
        version: list.version,
        entries: list.content.entries.map((e) => ({ region: e.region, shopper: e.shopper, escrow: e.escrow, payments: e.payments })),
      },
      reports: reports.slice(0, 30).map((r) => ({ id: r.id, subject: r.report.subject, orderId: r.report.order_id, at: r.at })),
    };
  }
}
