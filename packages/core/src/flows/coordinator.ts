import type { NostrEvent } from 'nostr-tools/pure';
import { KIND } from '../nostr/kinds.js';
import { delegationTemplate, parseDelegation } from '../trust/events.js';
import type { Delegation } from '../trust/types.js';
import { latestByAddress } from '../trust/versions.js';
import type { Session } from './session.js';

/** Coordinator role: delegate / revoke operators with kind 30500 (§2.2). */
export class CoordinatorClient {
  constructor(private readonly s: Session) {}

  /** Latest delegation per operator signed by us (including revoked ones). */
  async delegations(): Promise<Delegation[]> {
    const me = await this.s.pubkey();
    const remote = await this.s.transport.query(this.s.config.relays, { kinds: [KIND.delegation], authors: [me] });
    const local = (await this.s.storage.list<NostrEvent[]>(`own/${KIND.delegation}/`)).flatMap(([, v]) => v);
    return latestByAddress([...remote, ...local])
      .map(parseDelegation)
      .filter((d): d is Delegation => !!d && d.network === this.s.network)
      .sort((a, b) => (a.operator < b.operator ? -1 : 1));
  }

  async delegate(operator: string, note?: string): Promise<Delegation> {
    return this.write(operator, false, note);
  }

  async revoke(operator: string, note?: string): Promise<Delegation> {
    return this.write(operator, true, note);
  }

  private async write(operator: string, revoked: boolean, note?: string): Promise<Delegation> {
    if (!/^[0-9a-f]{64}$/.test(operator)) throw new Error('operator must be a 64-char hex pubkey');
    const version = await this.s.nextVersion(KIND.delegation, operator);
    const { event } = await this.s.publishOwn(delegationTemplate({ operator, version, network: this.s.network, revoked, note }));
    return parseDelegation(event)!;
  }
}
