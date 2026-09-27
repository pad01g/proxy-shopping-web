/**
 * §4.9: a dispute's evidence must fit in messages of at most MAX_INNER_BYTES. The signed messages are spread
 * over several bodies (dispute.open, then dispute.evidence); inline evidence data is sent once, inside the
 * signed messages that carry it.
 */
import type { Inner } from '../nostr/giftwrap.js';
import { MAX_INNER_BYTES, type DisputeEvidence, type Evidence, type TrackingStatus } from '../nostr/messages.js';
import { utf8 } from '../util/bytes.js';

/** Room for the inner's id, pubkey, sig and tags and the dispute.open fields around the evidence. */
const OVERHEAD_BYTES = 2000;

/** Bytes `v` takes inside an inner's content (the body is a JSON string there, so it is escaped once more). */
const embeddedSize = (v: unknown): number => utf8(JSON.stringify(JSON.stringify(v))).length;

const withoutData = (e: Evidence): Evidence => ({ kind: e.kind, sha256: e.sha256, mime: e.mime });

/**
 * Drop the inline data of purchase and tracking evidence: the shopper's signed order.purchased / order.shipping
 * messages among `messages` carry it already (the escrow reads it from there), so it would only be duplicated.
 */
export function evidenceWithoutInlineData(ev: DisputeEvidence): DisputeEvidence {
  return {
    ...ev,
    tracking: ev.tracking.map((t): TrackingStatus => ({ ...t, evidence: t.evidence.map(withoutData) })),
    purchase_evidence: ev.purchase_evidence.map(withoutData),
  };
}

/**
 * Split `ev` into bodies that each stay under `limit` once signed (like the Go node's splitEvidence). The
 * first carries everything but the messages that do not fit; the others only messages. A message that alone
 * cannot fit is returned in `skipped`.
 */
export function splitEvidence(ev: DisputeEvidence, limit = MAX_INNER_BYTES): { parts: DisputeEvidence[]; skipped: Inner[] } {
  const budget = limit - OVERHEAD_BYTES;
  const empty = (): DisputeEvidence => ({ messages: [], tracking: [], purchase_evidence: [] });
  const parts: DisputeEvidence[] = [{ ...ev, messages: [] }];
  const skipped: Inner[] = [];
  let used = embeddedSize(parts[0]);
  for (const m of ev.messages) {
    const n = embeddedSize(m) + 1;
    if (n > budget - embeddedSize(empty())) {
      skipped.push(m);
      continue;
    }
    if (used + n > budget) {
      parts.push(empty());
      used = embeddedSize(parts[parts.length - 1]);
    }
    parts[parts.length - 1].messages.push(m);
    used += n;
  }
  return { parts, skipped };
}
