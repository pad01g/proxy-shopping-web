/**
 * The mock mode's Nostr relays (wss://relay-1.test, wss://relay-2.test), behaving like the lab's psrelay
 * (proxy-shopping-go docs/lab.md「psrelay のフラグと制限」): events must have a valid id and signature, only the
 * protocol's kinds are taken (5, 1059, 10050, 30500–30503), replaceable kinds keep the latest per address (by
 * the `v` tag, 10050 without `v` by created_at; equal versions → the smaller id), kind 5 deletes the author's
 * own events, and queries return the newest first up to `limit`. Every role's session publishes, queries and
 * subscribes here as it would over websockets; nothing is trusted because it came from inside the page.
 */
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { looseVersion, normalizeRelayUrl, supersedes, tagValue, type PublishResult } from '@proxy-shopping/core/browser';

const ACCEPTED_KINDS = (k: number) => k === 5 || k === 1059 || k === 10050 || (k >= 30500 && k <= 30503);
const MAX_EVENT_BYTES = 262_144;
const MAX_LIMIT = 1000;

interface Sub {
  relays: Set<string>;
  filter: Filter;
  onEvent: (e: NostrEvent) => void;
}

export interface RelayHooks {
  onAdd?(relay: string, e: NostrEvent): void;
  onRemove?(relay: string, id: string): void;
}

const addressOf = (e: NostrEvent): string | undefined => {
  if (e.kind === 10050) return `${e.kind}:${e.pubkey}`;
  if (e.kind >= 30000 && e.kind < 40000) return `${e.kind}:${e.pubkey}:${tagValue(e.tags, 'd') ?? ''}`;
  return undefined;
};

export class MockRelays {
  private readonly store = new Map<string, Map<string, NostrEvent>>();
  private readonly subs = new Set<Sub>();

  constructor(
    readonly urls: string[],
    private readonly hooks: RelayHooks = {},
  ) {
    for (const u of urls) this.store.set(normalizeRelayUrl(u), new Map());
  }

  /** Put back stored events (no checks beyond the relay's own rules, no hooks). */
  load(relay: string, events: NostrEvent[]): void {
    const m = this.store.get(normalizeRelayUrl(relay));
    if (!m) return;
    for (const e of events.sort((a, b) => a.created_at - b.created_at)) m.set(e.id, e);
  }

  count(): number {
    let n = 0;
    for (const m of this.store.values()) n += m.size;
    return n;
  }

  private relaysOf(urls: string[]): Array<[string, Map<string, NostrEvent>]> {
    const out: Array<[string, Map<string, NostrEvent>]> = [];
    for (const u of new Set(urls.map(normalizeRelayUrl))) {
      const m = this.store.get(u);
      if (m) out.push([u, m]);
    }
    return out;
  }

  publish(relays: string[], event: NostrEvent): PublishResult {
    const res: PublishResult = { ok: [], failed: [] };
    const wanted = [...new Set(relays.map(normalizeRelayUrl))];
    const problem = this.check(event);
    for (const url of wanted) {
      const m = this.store.get(url);
      if (!m) {
        res.failed.push({ relay: url, reason: 'no such relay in the mock network' });
        continue;
      }
      if (problem) {
        res.failed.push({ relay: url, reason: problem });
        continue;
      }
      const stored = this.put(url, m, event);
      res.ok.push(url);
      if (stored) {
        for (const s of this.subs) {
          if (s.relays.has(url) && matchFilter(s.filter, event)) queueMicrotask(() => s.onEvent(event));
        }
      }
    }
    return res;
  }

  private check(e: NostrEvent): string | undefined {
    if (!e || typeof e !== 'object') return 'invalid: not an event';
    if (!ACCEPTED_KINDS(e.kind)) return `blocked: kind ${e.kind} is not accepted`;
    if (JSON.stringify(e).length > MAX_EVENT_BYTES) return 'invalid: event too large';
    // verifyEvent checks the id (hash of the serialized event) and the Schnorr signature. A fresh object, so
    // nostr-tools' "already verified" mark on the sender's copy is not taken on trust.
    const { id, pubkey, created_at, kind, tags, content, sig } = e;
    if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) return 'invalid: bad id or signature';
    return undefined;
  }

  /** Store an event under the relay's rules; false when it adds nothing (duplicate, older version, deletion). */
  private put(url: string, m: Map<string, NostrEvent>, e: NostrEvent): boolean {
    if (m.has(e.id)) return false;
    if (e.kind === 5) {
      for (const id of e.tags.filter((t) => t[0] === 'e').map((t) => t[1])) {
        const target = m.get(id);
        if (target && target.pubkey === e.pubkey) {
          m.delete(id);
          this.hooks.onRemove?.(url, id);
        }
      }
      return false;
    }
    const addr = addressOf(e);
    if (addr) {
      for (const old of m.values()) {
        if (addressOf(old) !== addr) continue;
        if (!supersedes(e, old, looseVersion)) return false;
        m.delete(old.id);
        this.hooks.onRemove?.(url, old.id);
      }
    }
    m.set(e.id, e);
    this.hooks.onAdd?.(url, e);
    return true;
  }

  query(relays: string[], filter: Filter): NostrEvent[] {
    const seen = new Map<string, NostrEvent>();
    const limit = Math.min(filter.limit ?? MAX_LIMIT, MAX_LIMIT);
    for (const [, m] of this.relaysOf(relays)) {
      const hits = [...m.values()].filter((e) => matchFilter(filter, e)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
      for (const e of hits.slice(0, limit)) seen.set(e.id, e);
    }
    return [...seen.values()].sort((a, b) => b.created_at - a.created_at);
  }

  /** Stored matches first (then onEose), then live events until closed. */
  subscribe(relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void, onEose?: () => void): { close(): void } {
    const sub: Sub = { relays: new Set(this.relaysOf(relays).map(([u]) => u)), filter, onEvent };
    this.subs.add(sub);
    const stored = this.query(relays, filter);
    queueMicrotask(() => {
      if (!this.subs.has(sub)) return;
      for (const e of stored) onEvent(e);
      onEose?.();
    });
    return { close: () => this.subs.delete(sub) };
  }

  subscriptions(): number {
    return this.subs.size;
  }

  clear(): void {
    for (const m of this.store.values()) m.clear();
  }
}
