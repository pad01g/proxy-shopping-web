import { verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { KIND, tagValue, tagValues } from '../nostr/kinds.js';
import { plainEvent } from '../nostr/giftwrap.js';
import { nowSeconds } from '../util/time.js';
import type {
  Delegation, EscrowProfileContent, OperatorList, OperatorListContent, ShopperProfileContent,
} from './types.js';
import { tryParse, type Check } from '../util/validate.js';
import { escrowProfileContent, operatorListContent, shopperProfileContent } from './schema.js';
import { eventVersion } from './versions.js';

const isHexKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export function verified(e: NostrEvent): boolean {
  try {
    return verifyEvent(plainEvent(e));
  } catch {
    return false;
  }
}

/** §2.2 list_url: an absolute https URL without credentials (the lab's internal CA still uses https). */
export function isListUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 512) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
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
    listUrls: tagValues(e.tags, 'list_url').slice(0, 4).filter(isListUrl), // §2.2: the first 4, bad ones ignored
    eventId: e.id,
  };
}

export function parseOperatorList(e: NostrEvent): OperatorList | undefined {
  if (e.kind !== KIND.operatorList || !verified(e)) return undefined;
  const version = eventVersion(e);
  const d = tagValue(e.tags, 'd');
  if (version < 0 || !d) return undefined;
  const content = parseJson(e.content, operatorListContent);
  // §2.3: d is the network name and the content must say the same.
  if (!content || content.network !== d) return undefined;
  return { operator: e.pubkey, version, network: d, content, eventId: e.id };
}

export interface Profile<T> {
  pubkey: string;
  version: number;
  content: T;
  event: NostrEvent;
}

function parseJson<T>(json: string, check: Check<T>): T | undefined {
  try {
    return tryParse(check, JSON.parse(json));
  } catch {
    return undefined;
  }
}

/** A profile whose content does not fit its schema is ignored, so pages never see malformed fields. */
function parseProfile<T>(e: NostrEvent, kind: number, check: Check<T>): Profile<T> | undefined {
  if (e.kind !== kind || !verified(e)) return undefined;
  const content = parseJson(e.content, check);
  return content ? { pubkey: e.pubkey, version: eventVersion(e), content, event: e } : undefined;
}

export const parseShopperProfile = (e: NostrEvent) => parseProfile(e, KIND.shopperProfile, shopperProfileContent);
export const parseEscrowProfile = (e: NostrEvent) => parseProfile(e, KIND.escrowProfile, escrowProfileContent);

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
  /** §2.2: where the operator puts its list bundle; left out of revoked delegations. */
  listUrls?: string[];
}): EventTemplate {
  const listUrls = p.revoked ? [] : (p.listUrls ?? []);
  return {
    kind: KIND.delegation,
    created_at: nowSeconds(),
    tags: [
      ...versioned(p.operator, p.version, p.network), ['p', p.operator], ['revoked', p.revoked ? 'true' : 'false'],
      ...listUrls.map((u) => ['list_url', u]),
    ],
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
