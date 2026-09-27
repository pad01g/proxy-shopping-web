import type { NostrEvent } from 'nostr-tools/pure';
import type { Payment } from '../nostr/messages.js';
import { parseDelegation, parseOperatorList, verified } from './events.js';
import { covers, shopAllowed } from './region.js';
import type { Delegation, EffectiveEntry, OperatorList } from './types.js';
import { latestByAddress } from './versions.js';

export interface EffectiveResult {
  entries: EffectiveEntry[];
  /** Latest valid list per operator that was reachable through some coordinator. */
  lists: Map<string, OperatorList>;
  /** Latest delegation per (coordinator, operator), including revoked ones. */
  delegations: Delegation[];
}

/**
 * Spec §2.4. `coordinators` is in priority order. Events may be unverified
 * and in any order; invalid or foreign-network events are ignored.
 */
export function effectiveCombinations(p: {
  coordinators: string[];
  network: string;
  events: NostrEvent[];
}): EffectiveResult {
  // Verify before picking the latest, so a forged high `v` cannot shadow a real one.
  const latest = latestByAddress(p.events.filter(verified));
  const delegations = latest.map(parseDelegation).filter((d): d is Delegation => !!d && d.network === p.network);
  const lists = new Map<string, OperatorList>();
  for (const l of latest.map(parseOperatorList)) {
    if (l && l.network === p.network) lists.set(l.operator, l);
  }

  const entries: EffectiveEntry[] = [];
  const seen = new Set<string>();
  const usedLists = new Map<string, OperatorList>();
  for (const coordinator of p.coordinators) {
    const operators = delegations
      .filter((d) => d.coordinator === coordinator && !d.revoked)
      .map((d) => d.operator)
      .sort();
    for (const operator of operators) {
      const list = lists.get(operator);
      if (!list) continue;
      usedLists.set(operator, list);
      for (const e of list.content.entries) {
        const key = `${e.region}|${e.shopper}|${e.escrow}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ...e, provenance: { coordinator, operator, listVersion: list.version } });
      }
    }
  }
  return { entries, lists: usedLists, delegations };
}

/** Rows usable for an order at `shopUrl` in `region` paid with `payment`. */
export function matchingEntries(
  entries: EffectiveEntry[],
  q: { shopUrl: string; region: string; payment?: Payment },
): EffectiveEntry[] {
  return entries.filter(
    (e) =>
      covers(e.region, q.region) &&
      shopAllowed(e.shops, q.shopUrl) &&
      (!q.payment || e.payments.includes(q.payment)),
  );
}
