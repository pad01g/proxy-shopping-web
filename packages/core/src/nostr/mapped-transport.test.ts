import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { MappedTransport } from './mapped-transport.js';

const MAP = { 'wss://relay-1.test': 'ws://localhost:8888/relay-1', 'wss://relay-2.test/': 'ws://localhost:8888/relay-2' };

function event(content: string) {
  return finalizeEvent({ kind: 1, created_at: 1790000000, tags: [], content }, generateSecretKey());
}

describe('MappedTransport', () => {
  it('publishes to the physical relays and reports logical URLs', async () => {
    const net = new MemoryRelayNetwork();
    const t = new MappedTransport(net.transport(), MAP);
    const res = await t.publish(['wss://relay-1.test', 'wss://relay-2.test', 'wss://elsewhere.test'], event('a'));
    expect(res.ok.sort()).toEqual(['wss://relay-1.test', 'wss://relay-2.test']);
    expect(res.failed).toEqual([{ relay: 'wss://elsewhere.test', reason: 'no route to this relay from here' }]);
    expect([...net.relays.keys()].sort()).toEqual(['ws://localhost:8888/relay-1', 'ws://localhost:8888/relay-2']);
  });

  it('maps physical failures back to the logical relay', async () => {
    const net = new MemoryRelayNetwork();
    net.down.add('ws://localhost:8888/relay-2');
    const res = await new MappedTransport(net.transport(), MAP).publish(['wss://relay-1.test', 'wss://relay-2.test'], event('b'));
    expect(res.ok).toEqual(['wss://relay-1.test']);
    expect(res.failed).toEqual([{ relay: 'wss://relay-2.test', reason: 'down' }]);
  });

  it('queries and subscribes through the mapping, skipping unmapped relays', async () => {
    const net = new MemoryRelayNetwork();
    const t = new MappedTransport(net.transport(), MAP);
    const e = event('c');
    await t.publish(['wss://relay-1.test'], e);
    expect(await t.query(['wss://relay-1.test'], { kinds: [1] })).toEqual([e]);
    expect(await t.query(['wss://elsewhere.test'], { kinds: [1] })).toEqual([]);

    const got: string[] = [];
    let eose = 0;
    const sub = t.subscribe(['wss://relay-1.test'], { kinds: [1] }, (x) => got.push(x.id), () => eose++);
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([e.id]);
    sub.close();
    t.subscribe(['wss://elsewhere.test'], { kinds: [1] }, () => got.push('never'), () => eose++);
    await new Promise((r) => setTimeout(r, 0));
    expect(eose).toBe(2);
    expect(got).toEqual([e.id]);
  });
});
