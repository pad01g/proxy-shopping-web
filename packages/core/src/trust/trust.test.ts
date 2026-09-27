import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { TrustDirectory } from './directory.js';
import { effectiveCombinations, matchingEntries } from './effective.js';
import { delegationTemplate, operatorListTemplate, parseOperatorList, shopperProfileTemplate } from './events.js';
import { covers, shopAllowed } from './region.js';
import type { ListEntry, OperatorListContent } from './types.js';
import { latestByAddress } from './versions.js';

const NET = 'ps-lab';
const key = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};
const pk = (c: string) => c.repeat(64);

function list(entries: Partial<ListEntry>[]): OperatorListContent {
  return {
    network: NET,
    name: 'op',
    regions: ['JP-13'],
    relays: [{ url: 'wss://relay-1.test' }],
    entries: entries.map((e) => ({
      region: 'JP-13', shopper: pk('a'), escrow: pk('e'), shops: ['*'], payments: ['btc-signet'], tags: [], escrow_sla_days: 14, ...e,
    })),
  };
}

describe('regions (§2.5)', () => {
  it('matches by prefix at segment boundaries', () => {
    expect(covers('JP-13', 'JP-13-13104')).toBe(true);
    expect(covers('JP-13', 'JP-13')).toBe(true);
    expect(covers('JP', 'JP-13')).toBe(true);
    expect(covers('JP-1', 'JP-13')).toBe(false);
    expect(covers('JP-13-13104', 'JP-13')).toBe(false);
  });
  it('matches shops', () => {
    expect(shopAllowed(['*'], 'https://x.test/')).toBe(true);
    expect(shopAllowed(['safe-shop.test'], 'https://safe-shop.test/item')).toBe(true);
    expect(shopAllowed(['safe-shop.test'], 'https://risky-shop.test/')).toBe(false);
  });
});

describe('versions (§2.1)', () => {
  it('picks max v, then smallest id', () => {
    const c = key();
    const ev = (v: number, at: number) => finalizeEvent({ ...delegationTemplate({ operator: pk('1'), version: v, network: NET }), created_at: at }, c.sk);
    const v2 = ev(2, 100);
    const v3old = ev(3, 50); // older created_at but higher v wins
    expect(latestByAddress([v2, v3old])).toEqual([v3old]);
    const a = ev(4, 1);
    const b = ev(4, 2);
    const smaller = a.id < b.id ? a : b;
    expect(latestByAddress([a, b])[0].id).toBe(smaller.id);
  });
});

describe('effective combinations (§2.4)', () => {
  it('applies coordinator priority, revocation and provenance', () => {
    const c1 = key();
    const c2 = key();
    const op1 = key();
    const op2 = key();
    const events: NostrEvent[] = [
      finalizeEvent(delegationTemplate({ operator: op1.pk, version: 1, network: NET }), c1.sk),
      finalizeEvent(delegationTemplate({ operator: op2.pk, version: 1, network: NET }), c2.sk),
      finalizeEvent(delegationTemplate({ operator: op1.pk, version: 1, network: NET }), c2.sk),
      finalizeEvent(operatorListTemplate(list([{ shopper: pk('a') }, { shopper: pk('b') }]), 5), op1.sk),
      finalizeEvent(operatorListTemplate(list([{ shopper: pk('a') }, { shopper: pk('c'), region: 'JP-27' }]), 2), op2.sk),
    ];
    let r = effectiveCombinations({ coordinators: [c1.pk, c2.pk], network: NET, events });
    expect(r.entries.map((e) => [e.shopper[0], e.provenance.coordinator === c1.pk ? 'c1' : 'c2'])).toEqual([
      ['a', 'c1'], ['b', 'c1'], ['c', 'c2'],
    ]);
    expect(r.entries[0].provenance).toEqual({ coordinator: c1.pk, operator: op1.pk, listVersion: 5 });

    // c1 revokes op1 (v2): its entries now come via c2
    events.push(finalizeEvent(delegationTemplate({ operator: op1.pk, version: 2, network: NET, revoked: true }), c1.sk));
    r = effectiveCombinations({ coordinators: [c1.pk, c2.pk], network: NET, events });
    expect(r.entries.every((e) => e.provenance.coordinator === c2.pk)).toBe(true);

    // dismissing c2 leaves nothing; empty coordinator list trusts nothing
    expect(effectiveCombinations({ coordinators: [c1.pk], network: NET, events }).entries).toEqual([]);
    expect(effectiveCombinations({ coordinators: [], network: NET, events }).entries).toEqual([]);

    // matching by region/shop/payment
    r = effectiveCombinations({ coordinators: [c2.pk], network: NET, events });
    expect(matchingEntries(r.entries, { shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet' })).toHaveLength(2);
    expect(matchingEntries(r.entries, { shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'usdc-evm' })).toHaveLength(0);
  });

  it('ignores forged, other-network and unversioned events', () => {
    const c = key();
    const op = key();
    const good = finalizeEvent(delegationTemplate({ operator: op.pk, version: 1, network: NET }), c.sk);
    const forged = { ...good, tags: [...good.tags.slice(0, 1), ['v', '9'], ...good.tags.slice(2)] };
    const lst = finalizeEvent(operatorListTemplate(list([{}]), 1), op.sk);
    const otherNet = finalizeEvent(operatorListTemplate({ ...list([{ shopper: pk('f') }]), network: 'ps-main' }, 7), op.sk);
    const r = effectiveCombinations({ coordinators: [c.pk], network: NET, events: [forged, good, lst, otherNet] });
    expect(r.entries).toHaveLength(1);
    expect(parseOperatorList({ ...lst, content: '{"entries":[]}' })).toBeUndefined();
  });
});

describe('TrustDirectory', () => {
  it('fetches delegations, lists and profiles from relays', async () => {
    const net = new MemoryRelayNetwork();
    const t = net.transport();
    const relays = ['wss://relay-1.test'];
    const c = key();
    const op = key();
    const shopper = key();
    await t.publish(relays, finalizeEvent(delegationTemplate({ operator: op.pk, version: 1, network: NET }), c.sk));
    await t.publish(relays, finalizeEvent(operatorListTemplate(list([{ shopper: shopper.pk, payments: ['btc-signet', 'usdc-evm'] }]), 1), op.sk));
    await t.publish(relays, finalizeEvent(shopperProfileTemplate({
      name: 'shopper-1', payments: ['btc-signet'], currencies: ['JPY'], cash_regions: [], fee: { bps: 500 }, delivery_days: 5,
    }, NET, 1), shopper.sk));
    const dir = new TrustDirectory({ transport: t, storage: new MemoryStorage(), network: NET, relays: () => relays, coordinators: () => [c.pk] });
    await dir.refresh();
    const q = { shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104' };
    expect(dir.offers({ ...q, payment: 'btc-signet' })).toHaveLength(1);
    expect(dir.offers({ ...q, payment: 'btc-signet' })[0].shopper?.content.name).toBe('shopper-1');
    // the list allows usdc but the shopper profile does not
    expect(dir.offers({ ...q, payment: 'usdc-evm' })).toHaveLength(0);
  });
});
