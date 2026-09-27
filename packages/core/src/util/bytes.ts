import { base64, hex } from '@scure/base';

export const toHex = (b: Uint8Array): string => hex.encode(b);

export function fromHex(s: string): Uint8Array {
  const clean = s.startsWith('0x') ? s.slice(2) : s;
  return hex.decode(clean.toLowerCase());
}

export const toBase64 = (b: Uint8Array): string => base64.encode(b);
export const fromBase64 = (s: string): Uint8Array => base64.decode(s);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** 16 random bytes as 32 lowercase hex chars (spec §1.1). */
export const newOrderId = (): string => toHex(randomBytes(16));

export function orderIdBytes(orderId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(orderId)) throw new Error(`invalid order_id: ${orderId}`);
  return fromHex(orderId);
}
