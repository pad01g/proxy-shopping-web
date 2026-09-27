import { sha256 } from '@noble/hashes/sha2';
import { orderIdBytes } from '../util/bytes.js';

/** Spec §1.1: idx = uint32_be(SHA-256(order_id bytes)[0..4]) & 0x7fffffff. */
export function orderIndex(orderId: string): number {
  const h = sha256(orderIdBytes(orderId));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) & 0x7fffffff;
}
