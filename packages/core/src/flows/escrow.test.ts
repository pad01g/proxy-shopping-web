import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import { toBase64, toHex, utf8 } from '../util/bytes.js';
import { evidenceIntegrity } from './escrow.js';

describe('evidence integrity (item 16)', () => {
  it('checks inline data against its sha256', () => {
    const data = utf8('{"receipt":1}');
    const e = { kind: 'json' as const, sha256: toHex(sha256(data)), mime: 'application/json' };
    expect(evidenceIntegrity({ ...e, data_b64: toBase64(data) })).toBe('ok');
    expect(evidenceIntegrity({ ...e, data_b64: toBase64(utf8('forged')) })).toBe('mismatch');
    expect(evidenceIntegrity(e)).toBe('no-data');
  });
});
