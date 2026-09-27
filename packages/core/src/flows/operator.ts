import type { IncomingMessage } from '../nostr/messenger.js';
import type { Inner } from '../nostr/giftwrap.js';
import { isValidInner } from '../nostr/giftwrap.js';
import { KIND } from '../nostr/kinds.js';
import { MSG, type Report } from '../nostr/messages.js';
import { operatorListTemplate, parseOperatorList } from '../trust/events.js';
import type { ListEntry, OperatorList, OperatorListContent } from '../trust/types.js';
import { Emitter } from '../util/emitter.js';
import { nowSeconds } from '../util/time.js';
import type { Session } from './session.js';

export interface ReceivedReport {
  id: string;
  from: string;
  at: number;
  report: Report;
  /** How many of the attached inners verify. */
  validEvidence: number;
}

type Events = { report: ReceivedReport; list: OperatorList };

/** Operator role: maintain the signed kind 30501 list and read reports. */
export class OperatorClient extends Emitter<Events> {
  private unsubscribe?: () => void;

  constructor(private readonly s: Session) {
    super();
  }

  attach(): this {
    this.unsubscribe ??= this.s.messenger.on('message', (m) => void this.onMessage(m));
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Our latest published list for this network, if any. */
  async currentList(): Promise<OperatorList | undefined> {
    const ev = await this.s.ownLatest(KIND.operatorList, this.s.network);
    return ev ? parseOperatorList(ev) : undefined;
  }

  /** An empty list skeleton for a first publish. */
  async draft(name: string): Promise<OperatorListContent> {
    return {
      network: this.s.network,
      name,
      regions: [],
      relays: this.s.config.relays.map((url) => ({ url, retention_days: 30 })),
      entries: [],
      report_to: await this.s.pubkey(),
    };
  }

  /** Sign and publish `content` as the next version (§2.1). */
  async publish(content: OperatorListContent): Promise<OperatorList> {
    const v = await this.s.nextVersion(KIND.operatorList, this.s.network);
    const { event } = await this.s.publishOwn(operatorListTemplate({ ...content, network: this.s.network }, v));
    const list = parseOperatorList(event)!;
    this.emit('list', list);
    return list;
  }

  /** Publish a new version without entries matching `pred` (e.g. after a report). */
  async removeEntries(pred: (e: ListEntry) => boolean): Promise<OperatorList> {
    const cur = await this.currentList();
    if (!cur) throw new Error('no list published yet');
    return this.publish({ ...cur.content, entries: cur.content.entries.filter((e) => !pred(e)) });
  }

  async addEntry(entry: ListEntry): Promise<OperatorList> {
    const cur = await this.currentList();
    const content = cur?.content ?? (await this.draft('operator'));
    const key = (e: ListEntry) => `${e.region}|${e.shopper}|${e.escrow}`;
    return this.publish({ ...content, entries: [...content.entries.filter((e) => key(e) !== key(entry)), entry] });
  }

  async reports(): Promise<ReceivedReport[]> {
    const rows = await this.s.storage.list<ReceivedReport>('operator/reports/');
    return rows.map(([, r]) => r).sort((a, b) => b.at - a.at);
  }

  private async onMessage(m: IncomingMessage): Promise<void> {
    if (m.type !== MSG.report) return;
    const report = m.body as Report;
    const evidence: Inner[] = Array.isArray(report?.evidence) ? report.evidence : [];
    const r: ReceivedReport = {
      id: m.inner.id,
      from: m.from,
      at: nowSeconds(),
      report,
      validEvidence: evidence.filter(isValidInner).length,
    };
    await this.s.storage.put(`operator/reports/${r.id}`, r);
    this.emit('report', r);
  }
}
