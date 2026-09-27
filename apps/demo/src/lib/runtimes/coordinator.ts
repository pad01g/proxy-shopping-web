import { CoordinatorClient, type Delegation, type IndexedDBStorage, type Session } from '@proxy-shopping/core/browser';
import type { CoordinatorSnap } from '../snapshots';
import { createSession, RoleRuntime, type RuntimeDeps } from './base';

/**
 * The coordinator role: signs kind 30500 delegations. It sends no 1:1 messages, so its messenger is never
 * started (it would otherwise read and acknowledge anything addressed to this key).
 */
export class CoordinatorRuntime extends RoleRuntime<'coordinator'> {
  readonly client: CoordinatorClient;
  private cached: Delegation[] = [];

  private constructor(session: Session, storage: IndexedDBStorage, deps: RuntimeDeps) {
    super('coordinator', session, storage, deps, 5000);
    this.client = new CoordinatorClient(this.session);
  }

  static async create(d: RuntimeDeps): Promise<CoordinatorRuntime> {
    const { session, storage } = await createSession('coordinator', d);
    return new CoordinatorRuntime(session, storage, d);
  }

  protected async begin(): Promise<void> {
    // Nothing to attach: delegations are plain signed events.
  }

  async delegations(): Promise<Delegation[]> {
    this.cached = await this.client.delegations();
    return this.cached;
  }

  async delegate(operator: string, note?: string): Promise<Delegation> {
    const d = await this.client.delegate(operator, note);
    this.changed();
    return d;
  }

  async revoke(operator: string, note?: string): Promise<Delegation> {
    const d = await this.client.revoke(operator, note);
    this.changed();
    return d;
  }

  protected async snapshot(): Promise<CoordinatorSnap> {
    const list = await this.delegations().catch(() => this.cached);
    return { at: Date.now(), delegations: list.map((d) => ({ operator: d.operator, version: d.version, revoked: d.revoked })) };
  }
}
