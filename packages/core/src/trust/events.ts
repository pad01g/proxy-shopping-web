import { verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { KIND, tagValue } from '../nostr/kinds.js';
import { plainEvent } from '../nostr/giftwrap.js';
import { nowSeconds } from '../util/time.js';
import type {
  Delegation, EscrowProfileContent, OperatorList, OperatorListContent, ShopperProfileContent,
} from './types.js';
import { eventVersion } from './versions.js';

const isHexKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export function verified(e: NostrEvent): boolean {
  try {
    return verifyEvent(plainEvent(e));
  } catch {
    return false;
  }
}

export function parseDelegation(e: NostrEvent): Delegation | undefined {
  if (e.kind !== KIND.delegation || !verified(e)) return undefined;
  const operator = tagValue(e.tags, 'd');
  const version = eventVersion(e);
  if (!isHexKey(operator) || version < 0 || tagValue(e.tags, 'p') !== operator) return undefined;
  let note: string | undefined;
  try {
    note = (JSON.parse(e.content || '{}') as { note?: string }).note;
  } catch {
    /* content is informational only */
  }
  return {
    coordinator: e.pubkey,
    operator,
    version,
    network: tagValue(e.tags, 'network') ?? '',
    revoked: tagValue(e.tags, 'revoked') === 'true',
    note,
    eventId: e.id,
  };
}

export function parseOperatorList(e: NostrEvent): OperatorList | undefined {
  if (e.kind !== KIND.operatorList || !verified(e)) return undefined;
  const version = eventVersion(e);
  const d = tagValue(e.tags, 'd');
  if (version < 0 || !d) return undefined;
  let content: OperatorListContent;
  try {
    content = JSON.parse(e.content) as OperatorListContent;
  } catch {
    return undefined;
  }
  if (!Array.isArray(content.entries) || content.network !== d) return undefined;
  const entries = content.entries.filter(
    (x) => x && typeof x.region === 'string' && isHexKey(x.shopper) && isHexKey(x.escrow),
  ).map((x) => ({
    ...x,
    shops: Array.isArray(x.shops) ? x.shops : ['*'],
    payments: Array.isArray(x.payments) ? x.payments : [],
    tags: Array.isArray(x.tags) ? x.tags : [],
  }));
  return { operator: e.pubkey, version, network: d, content: { ...content, entries }, eventId: e.id };
}

export interface Profile<T> {
  pubkey: string;
  version: number;
  content: T;
  event: NostrEvent;
}

function parseProfile<T>(e: NostrEvent, kind: number): Profile<T> | undefined {
  if (e.kind !== kind || !verified(e)) return undefined;
  try {
    return { pubkey: e.pubkey, version: eventVersion(e), content: JSON.parse(e.content) as T, event: e };
  } catch {
    return undefined;
  }
}

export const parseShopperProfile = (e: NostrEvent) => parseProfile<ShopperProfileContent>(e, KIND.shopperProfile);
export const parseEscrowProfile = (e: NostrEvent) => parseProfile<EscrowProfileContent>(e, KIND.escrowProfile);

// ---- builders (unsigned templates; sign with an IdentitySigner) ----

const versioned = (d: string, v: number, network: string): string[][] => [
  ['d', d],
  ['v', String(v)],
  ['network', network],
];

export function delegationTemplate(p: {
  operator: string;
  version: number;
  network: string;
  revoked?: boolean;
  note?: string;
}): EventTemplate {
  return {
    kind: KIND.delegation,
    created_at: nowSeconds(),
    tags: [...versioned(p.operator, p.version, p.network), ['p', p.operator], ['revoked', p.revoked ? 'true' : 'false']],
    content: JSON.stringify(p.note ? { note: p.note } : {}),
  };
}

export function operatorListTemplate(content: OperatorListContent, version: number): EventTemplate {
  return {
    kind: KIND.operatorList,
    created_at: nowSeconds(),
    tags: versioned(content.network, version, content.network),
    content: JSON.stringify(content),
  };
}

export function shopperProfileTemplate(content: ShopperProfileContent, network: string, version: number): EventTemplate {
  return {
    kind: KIND.shopperProfile,
    created_at: nowSeconds(),
    tags: versioned(network, version, network),
    content: JSON.stringify(content),
  };
}

export function escrowProfileTemplate(content: EscrowProfileContent, network: string, version: number): EventTemplate {
  return {
    kind: KIND.escrowProfile,
    created_at: nowSeconds(),
    tags: versioned(network, version, network),
    content: JSON.stringify(content),
  };
}

export function inboxRelaysTemplate(relays: string[]): EventTemplate {
  return { kind: KIND.inboxRelays, created_at: nowSeconds(), tags: relays.map((r) => ['relay', r]), content: '' };
}
