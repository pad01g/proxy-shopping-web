/** Second review: disputes and rulings on the user side (§4.7–§4.9). */
import { describe, expect, it } from 'vitest';
import { giftWrap, innerMeta, signInner } from '../nostr/giftwrap.js';
import { MAX_INNER_BYTES, MSG, type DisputeOpen } from '../nostr/messages.js';
import { caseIn, placeFundedOrder, RELAYS, setupWorld, waitFor, waitStatus, type TestWorld } from '../testing/flow-helpers.js';
import { sleep } from '../util/time.js';

/** The shopper's dispute.open to `to`, published straight to the relays. */
async function shopperOpens(w: TestWorld, id: string, to: string, text: string) {
  const shopper = w.sessions['shopper-1'].signer;
  const o = (await w.user.getOrder(id))!;
  const body: DisputeOpen = { claim: 'other', text, evidence: { messages: [o.requestInner], tracking: [], purchase_evidence: [] } };
  await w.net.transport().publish(RELAYS, await giftWrap(shopper, await signInner(shopper, { recipient: to, orderId: id, type: MSG.disputeOpen, body }), to));
}

describe('item 3: the escrow fee is dispute_fee_bps of what is split', () => {
  it('rulingTerms gives the fee and rule() refuses any other split', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.user.openDispute(id, { claim: 'wrong_item', text: 'x' });
    await caseIn(w, id, 'open');
    expect(await w.escrow.rulingTerms(id)).toEqual({ asset: 'btc-signet', distributable: 28667n, fee: 573n, bps: 200 });
    // user + shopper = 28000 would leave 667 (> 2 %) for the escrow
    await expect(w.escrow.rule(id, { user: '28000', shopper: '0' }, 'x')).rejects.toThrow(/add up to 28094/);
    expect((await w.escrow.getCase(id))!.ruling).toBeUndefined();
    // a BTC share between 1 and 545 sats would be an output no node relays
    await expect(w.escrow.rule(id, { user: '28000', shopper: '94' }, 'x')).rejects.toThrow(/at least 546/);
    w.stop();
  });
});

describe('item 4: evidence of a long order is split over several messages (§4.9)', () => {
  it('opens a dispute with ~20 large messages and the escrow receives all of them', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const shopper = w.sessions['shopper-1'].messenger;
    const userPk = w.keys['user-1'].nostrPublicKey;
    for (let i = 0; i < 20; i++) await shopper.send(userPk, id, MSG.chat, { text: `${i} ${'あ'.repeat(1300)}` });
    const o = await waitFor(get, (x) => (x?.messages.filter((m) => innerMeta(m).type === MSG.chat).length ?? 0) === 20, 'chats');
    // one body with everything would be far over the limit
    expect(new TextEncoder().encode(JSON.stringify(o.messages)).length).toBeGreaterThan(MAX_INNER_BYTES * 2);
    await w.user.openDispute(id, { claim: 'wrong_item', text: 'long order' });
    const sent = (await get())!.messages.filter((m) => [MSG.disputeOpen, MSG.evidence].includes(innerMeta(m).type as never) && innerMeta(m).recipient === w.keys['escrow-1'].nostrPublicKey);
    expect(sent.length).toBeGreaterThan(2);
    for (const m of sent) expect(new TextEncoder().encode(JSON.stringify(m)).length).toBeLessThanOrEqual(MAX_INNER_BYTES);
    const c = await waitFor(() => w.escrow.getCase(id), (x) => (x?.messages.filter((m) => innerMeta(m).type === MSG.chat).length ?? 0) === 20, 'all chats at the escrow');
    expect(c.status).toBe('open');
    expect(c.deliveryKeyForEscrow).toBeDefined();
    w.stop();
  });
});

describe('item 6: a dispute.open after the ruling keeps the countersignature reachable (review PoC)', () => {
  it('status stays ruled after a second shopper dispute.open', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const userPk = w.keys['user-1'].nostrPublicKey;
    const escrowPk = w.keys['escrow-1'].nostrPublicKey;
    await shopperOpens(w, id, escrowPk, 's1');
    await shopperOpens(w, id, userPk, 's1');
    await caseIn(w, id, 'open');
    await waitStatus(get, 'disputed');
    await w.escrow.rule(id, { user: '27494', shopper: '600' }, 'user wins');
    await waitStatus(get, 'ruled');
    await shopperOpens(w, id, userPk, 's2');
    await sleep(300);
    expect((await get())!.status).toBe('ruled');
    // our own dispute after the ruling does not hide it either
    await w.user.openDispute(id, { claim: 'other', text: 'me too' });
    expect((await get())!.status).toBe('ruled');
    expect(await w.user.reviewRuling(id)).toEqual([]);
    await w.user.countersignRuling(id);
    await waitStatus(get, 'settled');
    w.stop();
  });
});

describe('item 7: a ruling that arrives before the dispute is known is kept', () => {
  it('is adopted when the shopper\'s copy of dispute.open arrives', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    // The shopper disputes with the escrow only; its copy to us is delayed.
    await shopperOpens(w, id, w.keys['escrow-1'].nostrPublicKey, 'late copy');
    await caseIn(w, id, 'open');
    await w.escrow.rule(id, { user: '10000', shopper: '18094' }, 'split');
    const held = await waitFor(get, (o) => !!o?.pendingRuling, 'held ruling');
    expect(held.ruling).toBeUndefined();
    expect(held.status).toBe('delivered');
    await shopperOpens(w, id, w.keys['user-1'].nostrPublicKey, 'late copy');
    const ruled = await waitStatus(get, 'ruled');
    expect(ruled.ruling!.split.user).toBe('10000');
    expect(ruled.pendingRuling).toBeUndefined();
    expect(await w.user.reviewRuling(id)).toEqual([]);
    w.stop();
  });

  it('is adopted when the escrow asks us for evidence', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await shopperOpens(w, id, w.keys['escrow-1'].nostrPublicKey, 'x');
    await caseIn(w, id, 'open');
    await w.escrow.rule(id, { user: '10000', shopper: '18094' }, 'split');
    await waitFor(get, (o) => !!o?.pendingRuling, 'held ruling');
    await w.escrow.requestEvidence(id, ['tracking'], 'user');
    await waitStatus(get, 'ruled');
    w.stop();
  });
});

describe('item 15: our own broadcast is not a spend', () => {
  it('countersigning waits for the outspend before settled', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.user.openDispute(id, { claim: 'wrong_item', text: 'x' });
    await caseIn(w, id, 'open');
    await w.escrow.rule(id, { user: '20000', shopper: '8094' }, 'r');
    await waitStatus(get, 'ruled');
    // An Esplora that accepted the broadcast but does not (yet) show the escrow output spent.
    const outspend = w.chain.outspend.bind(w.chain);
    w.chain.outspend = async () => ({ spent: false });
    const o = await w.user.countersignRuling(id);
    expect(o.status).toBe('ruled');
    expect(o.escrowSpent).toBeUndefined();
    expect(o.pendingSettlement?.kind).toBe('settled');
    w.chain.outspend = outspend;
    const settled = await waitStatus(get, 'settled');
    expect(settled.escrowSpent?.txid).toBe(o.pendingSettlement!.txid);
    w.stop();
  });

  it('the T2 refund waits for the outspend before refunded', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    w.chain.mine(150);
    const outspend = w.chain.outspend.bind(w.chain);
    w.chain.outspend = async () => ({ spent: false });
    const o = await w.user.refundAfterTimelock(id);
    expect(o.status).toBe('delivered');
    expect(o.pendingSettlement?.kind).toBe('refunded');
    w.chain.outspend = outspend;
    await waitStatus(get, 'refunded');
    w.stop();
  });
});
