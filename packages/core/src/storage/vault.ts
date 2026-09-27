/**
 * Passphrase encryption for secrets at rest (the browser's mnemonic): PBKDF2-SHA256 → AES-256-GCM,
 * via WebCrypto (browsers and Node 22). The iteration count is stored so it can be raised later.
 */
import { fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from '../util/bytes.js';

export interface EncryptedSecret {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  /** base64 AES-GCM ciphertext + tag. */
  ct: string;
}

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

// WebCrypto's typings want ArrayBuffer-backed views; ours always are.
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
type AesKey = Awaited<ReturnType<SubtleCrypto['deriveKey']>>;
type SubtleCrypto = typeof globalThis.crypto.subtle;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<AesKey> {
  const subtle = globalThis.crypto?.subtle;
  // Browsers only expose WebCrypto on https:// (secure contexts).
  if (!subtle) throw new Error('WebCrypto is unavailable: open the app over https');
  const base = await subtle.importKey('raw', buf(utf8(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptWithPassphrase(plaintext: string, passphrase: string, iterations = DEFAULT_PBKDF2_ITERATIONS): Promise<EncryptedSecret> {
  if (!passphrase) throw new Error('empty passphrase');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(utf8(plaintext))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct) };
}

/** Throws 'wrong passphrase' when the key does not authenticate the ciphertext. */
export async function decryptWithPassphrase(secret: EncryptedSecret, passphrase: string): Promise<string> {
  if (secret.v !== 1 || secret.kdf !== 'PBKDF2-SHA256') throw new Error('unsupported encrypted secret');
  const key = await deriveKey(passphrase, fromBase64(secret.salt), secret.iterations);
  try {
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromBase64(secret.iv)) }, key, buf(fromBase64(secret.ct)));
    return fromUtf8(new Uint8Array(pt));
  } catch {
    throw new Error('wrong passphrase');
  }
}
