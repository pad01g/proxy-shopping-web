import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { LocalSigner } from '../../src/keys/signer.js';
import { Messenger, type IncomingMessage } from '../../src/nostr/messenger.js';
import { PoolTransport } from '../../src/nostr/transport.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { sleep } from '../../src/util/time.js';
import { ENV, skipReason } from './env.js';

const skip = skipReason(['relay']);
if (skip) console.warn(`[nostr.it] skipped: ${skip}`);

describe.skipIf(!!skip)('messaging through a real relay (§4)', () => {
  it('gift-wrapped message is delivered once and acked', async () => {
    const mk = () => new Messenger({
      signer: new LocalSigner(generateSecretKey()),
      transport: new PoolTransport(),
      storage: new MemoryStorage(),
      relays: [ENV.relay!],
      k: 1,
      retryIntervalMs: 1000,
    });
    const alice = mk();
    const bob = mk();
    const got: IncomingMessage[] = [];
    bob.on('message', (m) => got.push(m));
    await bob.publishInboxRelays();
    await alice.start();
    // Bob comes online after the message was sent: the relay stores the wrap.
    const inner = await alice.send(await bob.pubkey(), 'ab'.repeat(16), 'chat', { text: 'こんにちは' });
    await bob.start();
    const end = Date.now() + 15_000;
    while (!(await alice.isAcked(inner.id))) {
      if (Date.now() > end) throw new Error('no ack');
      await sleep(100);
    }
    expect(got).toHaveLength(1);
    expect(got[0].body).toEqual({ text: 'こんにちは' });
    expect(got[0].from).toBe(await alice.pubkey());
    alice.stop();
    bob.stop();
  });
});
