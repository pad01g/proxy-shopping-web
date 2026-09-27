import type { NostrEvent } from 'nostr-tools/pure';
import { tagValue } from '../nostr/kinds.js';

/** The `v` tag, or -1 when absent/invalid. */
export function eventVersion(e: NostrEvent): number {
  const v = tagValue(e.tags, 'v');
  if (v === undefined || !/^\d+$/.test(v)) return -1;
  return Number(v);
}

/**
 * Version used to order replaceable events that may lack `v` (profiles, 10050):
 * `v` when present, else created_at — the same rule as the Go node.
 */
export function looseVersion(e: NostrEvent): number {
  return tagValue(e.tags, 'v') === undefined ? e.created_at : eventVersion(e);
}

/** Does `a` supersede `b`? Higher version wins; equal → lexicographically smaller id (§2.1). */
export function supersedes(a: NostrEvent, b: NostrEvent, version: (e: NostrEvent) => number = eventVersion): boolean {
  const va = version(a);
  const vb = version(b);
  if (va !== vb) return va > vb;
  return a.id < b.id;
}

/**
 * Keep only the latest event per (kind, pubkey, d). By default events without
 * a valid `v` are dropped, as required for trust events (§2.1); with
 * `requireVersion: false` they are ordered by created_at instead.
 */
export function latestByAddress(events: NostrEvent[], opts: { requireVersion?: boolean } = {}): NostrEvent[] {
  const strict = opts.requireVersion ?? true;
  const version = strict ? eventVersion : looseVersion;
  const best = new Map<string, NostrEvent>();
  for (const e of events) {
    if (version(e) < 0) continue;
    const d = e.kind >= 30000 && e.kind < 40000 ? (tagValue(e.tags, 'd') ?? '') : '';
    const key = `${e.kind}:${e.pubkey}:${d}`;
    const cur = best.get(key);
    if (!cur || supersedes(e, cur, version)) best.set(key, e);
  }
  return [...best.values()];
}
