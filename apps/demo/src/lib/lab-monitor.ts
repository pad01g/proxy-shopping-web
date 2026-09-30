import { KIND } from '@proxy-shopping/core/browser';
import type { Backend } from './backend';
import type { ShopperNode } from './config';
import type { Heights, NodeOrderSummary, NodeStatus } from './lab-api';

/** What the lab (or the mock world) tells every window (no keys needed): chain heights and the shopper node's state. */
export interface LabSnap {
  at: number;
  heights?: Heights;
  heightsError?: string;
  shopper: {
    name: string;
    status?: NodeStatus;
    statusError?: string;
    orders: NodeOrderSummary[];
    /** Effective combinations the node derived (§2.4). */
    effective: Array<{ region: string; shopper: string; escrow: string; operator: string }>;
    /** Authors of the escrow profiles (kind 30503) the node holds. */
    escrowProfiles: string[];
    /** ETH of the node's EVM account (it pays the gas of USDC payouts), wei. */
    eth?: string;
  };
}

const TRUST_EVERY = 2;

/** Polls the lab (or the mock world) every few seconds; runs in every window. */
export class LabMonitor {
  private snap: LabSnap;
  private timer?: ReturnType<typeof setInterval>;
  private tick = 0;
  private busy = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly backend: Backend,
    readonly shopper: ShopperNode,
    private readonly everyMs = 2500,
  ) {
    this.snap = { at: 0, shopper: { name: shopper.name, orders: [], effective: [], escrowProfiles: [] } };
  }

  get current(): LabSnap {
    return this.snap;
  }

  get node() {
    return this.backend.node(this.shopper);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Poll now (after a lab action, so the guide does not wait for the next tick). */
  refresh(): Promise<void> {
    return this.poll(true);
  }

  private async poll(force = false): Promise<void> {
    if (this.busy && !force) return;
    this.busy = true;
    const withTrust = force || this.tick++ % TRUST_EVERY === 0;
    try {
      const faucet = this.backend.faucet;
      const node = this.node;
      const [heights, status, orders, trust, eth] = await Promise.allSettled([
        faucet.height(),
        node.status(),
        node.orders(),
        withTrust ? node.trust() : Promise.reject(new Error('skipped')),
        this.shopper.evm_address ? this.backend.balances.eth(this.shopper.evm_address) : Promise.reject(new Error('no address')),
      ]);
      const prev = this.snap.shopper;
      this.snap = {
        at: Date.now(),
        heights: heights.status === 'fulfilled' ? heights.value : this.snap.heights,
        heightsError: heights.status === 'rejected' ? String(heights.reason?.message ?? heights.reason) : undefined,
        shopper: {
          name: this.shopper.name,
          status: status.status === 'fulfilled' ? status.value : undefined,
          statusError: status.status === 'rejected' ? String(status.reason?.message ?? status.reason) : undefined,
          orders: orders.status === 'fulfilled' ? orders.value : prev.orders,
          effective: trust.status === 'fulfilled'
            ? trust.value.effective.map((e) => ({ region: e.region, shopper: e.shopper, escrow: e.escrow, operator: e.operator }))
            : prev.effective,
          escrowProfiles: trust.status === 'fulfilled'
            ? [...new Set(trust.value.events.filter((e) => e.kind === KIND.escrowProfile).map((e) => e.pubkey))]
            : prev.escrowProfiles,
          eth: eth.status === 'fulfilled' ? eth.value.toString() : prev.eth,
        },
      };
      for (const fn of this.listeners) fn();
    } finally {
      this.busy = false;
    }
  }
}
