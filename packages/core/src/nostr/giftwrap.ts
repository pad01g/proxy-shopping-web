import { finalizeEvent, generateSecretKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import type { IdentitySigner } from '../keys/signer.js';
import { nowSeconds } from '../util/time.js';
import { KIND, tagValue } from './kinds.js';

/** A signed kind-5400 inner message (spec §4.1). */
export type Inner = NostrEvent;

export interface InnerFields {
  recipient: string;
  orderId: string;
  type: string;
  body: unknown;
  createdAt?: number;
}

/** Types that may be sent outside an order; Go omits the `o` tag when the order id is empty. */
export const ORDERLESS_TYPES: readonly string[] = ['ack'];

export async function signInner(signer: IdentitySigner, f: InnerFields): Promise<Inner> {
  const ev = await signer.signEvent({
    kind: KIND.inner,
    created_at: f.createdAt ?? nowSeconds(),
    tags: [
      ['p', f.recipient],
      ...(f.orderId || !ORDERLESS_TYPES.includes(f.type) ? [['o', f.orderId]] : []),
      ['t', f.type],
    ],
    content: JSON.stringify(f.body),
  });
  return plainEvent(ev);
}

/** Seal (kind 13) and wrap (kind 1059) a signed inner for `recipient`. */
export async function giftWrap(signer: IdentitySigner, inner: Inner, recipient: string): Promise<NostrEvent> {
  const seal = await signer.signEvent({
    kind: KIND.seal,
    created_at: inner.created_at,
    tags: [],
    content: await signer.nip44Encrypt(recipient, JSON.stringify(inner)),
  });
  const ephemeral = generateSecretKey();
  const conv = nip44.getConversationKey(ephemeral, recipient);
  return finalizeEvent(
    {
      kind: KIND.giftWrap,
      created_at: inner.created_at,
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), conv),
    },
    ephemeral,
  );
}

/** Strip the non-JSON verification cache nostr-tools attaches, keeping wire fields only. */
export function plainEvent(e: NostrEvent): NostrEvent {
  return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
}

/** Verify a signed inner in isolation (as an escrow does with evidence). */
export function isValidInner(e: unknown): e is Inner {
  if (!e || typeof e !== 'object') return false;
  const ev = e as NostrEvent;
  if (ev.kind !== KIND.inner || !Array.isArray(ev.tags)) return false;
  const type = tagValue(ev.tags, 't');
  if (!type || !tagValue(ev.tags, 'p')) return false;
  // Order messages need their order id; acks for order-less messages may leave it out.
  if (!tagValue(ev.tags, 'o') && !ORDERLESS_TYPES.includes(type)) return false;
  try {
    return verifyEvent(plainEvent(ev));
  } catch {
    return false;
  }
}

export function innerMeta(inner: Inner): { orderId: string; type: string; recipient: string } {
  return {
    orderId: tagValue(inner.tags, 'o') ?? '',
    type: tagValue(inner.tags, 't') ?? '',
    recipient: tagValue(inner.tags, 'p') ?? '',
  };
}

export function innerBody<T = unknown>(inner: Inner): T {
  return JSON.parse(inner.content) as T;
}

/**
 * Open a gift wrap addressed to us. Throws on any structural or signature error;
 * enforces seal.pubkey == inner.pubkey (spec §4.1).
 */
export async function unwrap(signer: IdentitySigner, wrap: NostrEvent): Promise<Inner> {
  if (wrap.kind !== KIND.giftWrap) throw new Error('not a gift wrap');
  if (!verifyEvent(plainEvent(wrap))) throw new Error('bad wrap signature');
  const me = await signer.getPublicKey();
  if (tagValue(wrap.tags, 'p') !== me) throw new Error('wrap not addressed to us');
  const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as NostrEvent;
  if (seal.kind !== KIND.seal || !verifyEvent(plainEvent(seal))) throw new Error('bad seal');
  const inner = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) as NostrEvent;
  if (!isValidInner(inner)) throw new Error('bad inner');
  if (inner.pubkey !== seal.pubkey) throw new Error('seal/inner pubkey mismatch');
  if (tagValue(inner.tags, 'p') !== me) throw new Error('inner not addressed to us');
  return plainEvent(inner);
}
