/**
 * §4.7 (second review): an escrow case is keyed by the order.request whose request + quote recompute to the
 * funded output on chain, and the escrow's own terms decide its obligation.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { buildFundingTx } from '../btc/funding.js';
import { p2wshAddress, witnessScript } from '../btc/script.js';
import { signKeyProofBtc } from '../keys/proof.js';
import { LocalSigner } from '../keys/signer.js';
import { giftWrap, signInner, type Inner } from '../nostr/giftwrap.js';
import { MSG, type OrderQuote, type OrderRequest } from '../nostr/messages.js';
import { caseIn, quotedOrder, RELAYS, setupWorld, waitFor, waitStatus, type TestWorld } from '../testing/flow-helpers.js';
import { fromHex, toHex } from '../util/bytes.js';
import { sleep } from '../util/time.js';

/** A request for the real order id, signed by a throwaway identity with its own chain key and a valid key_proof. */
async function sockpuppet(w: TestWorld, id: string, request: OrderRequest) {
  const puppet = new LocalSigner(generateSecretKey());
  const pk = await puppet.getPublicKey();
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, true);
  const body: OrderRequest = { ...request, key_proof: signKeyProofBtc(priv, id, pk), user_btc_pubkey: toHex(pub) };
  const inner = await signInner(puppet, { recipient: w.keys['shopper-1'].nostrPublicKey, orderId: id, type: MSG.request, body });
  return { puppet, pk, pub, inner };
}

/** The shopper's dispute.open to the escrow carrying `messages`, published straight to the relays. */
async function shopperDispute(w: TestWorld, id: string, messages: Inner[], text = 'x') {
  const shopper = w.sessions['shopper-1'].signer;
  const escrowPk = w.keys['escrow-1'].nostrPublicKey;
  const open = await signInner(shopper, {
    recipient: escrowPk, orderId: id, type: MSG.disputeOpen,
    body: { claim: 'other', text, evidence: { messages, tracking: [], purchase_evidence: [] } },
  });
  await w.net.transport().publish(RELAYS, await giftWrap(shopper, open, escrowPk));
}

describe('item 1: the escrow case follows the funded request (§4.7)', () => {
  it('a sockpuppet request opened first does not lock the real user out (review PoC)', async () => {
    const w = await setupWorld();
    const { id, get, quoted } = await quotedOrder(w);
    // Before the user funds, the shopper files a dispute carrying a request of its own sockpuppet.
    const fake = await sockpuppet(w, id, quoted.request);
    await shopperDispute(w, id, [fake.inner]);
    await sleep(200);
    expect(await w.escrow.getCase(id)).toBeUndefined(); // nothing on chain matches that request
    await w.user.acceptQuote(id);
    await w.user.fund(id);
    w.chain.mine();
    const c = await waitFor(() => w.escrow.getCase(id), (x) => !!x?.noticeIds, 'case from the notice');
    expect(c.user).toBe(w.keys['user-1'].nostrPublicKey);
    expect(c.requestId).toBe((await get())!.requestInner.id);
    // The shopper's early dispute is kept, and the sockpuppet request is recorded as a conflict.
    expect(c.status).toBe('open');
    expect(c.conflicts!.join()).toMatch(new RegExp(`order.request ${fake.inner.id.slice(0, 12)}`));
    await w.user.openDispute(id, { claim: 'not_delivered', text: 'real user' });
    await waitFor(() => w.escrow.getCase(id), (x) => x?.disputes.some((d) => d.from === w.keys['user-1'].nostrPublicKey) ?? false, 'user dispute');
    const ruled = await w.escrow.rule(id, { user: '28094', shopper: '0' }, 'refund');
    expect(ruled.ruling!.split.user).toBe('28094');
    await waitStatus(get, 'ruled');
    expect(await w.user.reviewRuling(id)).toEqual([]);
    w.stop();
  });

  it('a self-funded sockpuppet case is replaced by the notice of the real request signer', async () => {
    const w = await setupWorld();
    const { id, get, quoted } = await quotedOrder(w);
    const q = quoted.quote!;
    const shopperKeys = w.keys['shopper-1'];
    // The shopper builds a complete order of its sockpuppet with the same id and funds it itself.
    const fake = await sockpuppet(w, id, quoted.request);
    const script = witnessScript({ user: fake.pub, shopper: fromHex(q.shopper_btc_pubkey!), escrow: fromHex(q.escrow_btc_pubkey!) }, q.timelock!.t1, q.timelock!.t2);
    const fakeQuote: OrderQuote = { ...q, escrow_address: p2wshAddress(script) };
    const quoteInner = await signInner(w.sessions['shopper-1'].signer, { recipient: fake.pk, orderId: id, type: MSG.quote, body: fakeQuote });
    const accept = await signInner(fake.puppet, { recipient: shopperKeys.nostrPublicKey, orderId: id, type: MSG.accept, body: { quote_id: quoteInner.id } });
    w.chain.fund(shopperKeys.btcWallet.address, 100_000);
    const tx = buildFundingTx({
      wallet: shopperKeys.btcWallet, utxos: await w.chain.utxos(shopperKeys.btcWallet.address), feeRate: 1,
      outputs: [{ address: fakeQuote.escrow_address!, amount: BigInt(q.lock_amount!) }, { address: q.escrow_btc_fee_address!, amount: BigInt(q.escrow_upfront_fee!) }],
    });
    await w.chain.broadcast(tx.hex);
    const funded = await signInner(fake.puppet, {
      recipient: shopperKeys.nostrPublicKey, orderId: id, type: MSG.funded,
      body: { asset: 'btc-signet', txid: tx.txid, vout: 0, amount: q.lock_amount, fee_txid: tx.txid },
    });
    await shopperDispute(w, id, [fake.inner, quoteInner, accept, funded]);
    const early = await caseIn(w, id, 'open');
    expect(early.user).toBe(fake.pk); // it does match the chain: its own funding
    // The real user funds; its notice (from the signer of its request, matching the chain) takes the case over.
    await w.user.acceptQuote(id);
    await w.user.fund(id);
    const c = await waitFor(() => w.escrow.getCase(id), (x) => x?.user === w.keys['user-1'].nostrPublicKey, 'replaced case');
    expect(c.requestId).toBe((await get())!.requestInner.id);
    expect(c.noticeIds?.request).toBe(c.requestId);
    expect(c.conflicts!.join()).toMatch(/replaced by the notice/);
    expect((c.funded as { txid: string }).txid).toBe(((await get())!.funded as { txid: string }).txid);
    w.stop();
  });
});

describe('items 10, 11: the escrow keeps to its own terms', () => {
  it('owes no ruling for an upfront fee below its profile minimum, even if paid', async () => {
    // 600 sats: above dust, below the escrow's max(0.5 % of lock, 1000 sats).
    const w = await setupWorld({ escrowUpfrontFee: { 'btc-signet': 600n, 'usdc-evm': 500_000n } });
    const { id, quoted } = await quotedOrder(w);
    expect(quoted.quoteCheck!.warnings.join()).toMatch(/below the escrow's minimum/);
    await w.user.acceptQuote(id);
    await w.user.fund(id);
    await caseIn(w, id, 'notice');
    const ob = await w.escrow.checkObligation(id);
    expect(ob.paid).toBe(false);
    expect(ob.detail).toMatch(/below our minimum 1000/);
    w.stop();
  });

  it('refuses a case whose quote names another address for its upfront fee', async () => {
    const w = await setupWorld();
    const shopper = w.sessions['shopper-1'].messenger;
    const send = shopper.send.bind(shopper);
    shopper.send = (to, oid, type, body) =>
      send(to, oid, type, type === MSG.quote ? { ...(body as OrderQuote), escrow_btc_fee_address: w.keys['shopper-1'].btcWallet.address } : body);
    const { id, quoted } = await quotedOrder(w);
    expect(quoted.quoteCheck!.errors.join()).toMatch(/fee address/);
    // A user client that funded it anyway (its check overridden): the escrow does not take the case.
    const store = w.sessions['user-1'].storage;
    await store.put(`user/orders/${id}`, { ...quoted, quoteCheck: { ...quoted.quoteCheck!, ok: true, errors: [] } });
    await w.user.acceptQuote(id);
    await w.user.fund(id);
    await sleep(300);
    expect(await w.escrow.getCase(id)).toBeUndefined();
    w.stop();
  });
});
