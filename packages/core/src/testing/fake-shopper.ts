import type { Hex } from 'viem';
import { p2wshAddress, witnessScript } from '../btc/script.js';
import { extractTx, finalizeEscrowInput, psbtFromBase64, signEscrowInput } from '../btc/spend.js';
import { decryptAddress, unwrapDeliveryKey } from '../delivery/delivery.js';
import { orderSafeAddress } from '../evm/safe.js';
import { recoverSafeTxSigner, safeTxFromJson, signSafeTx } from '../evm/safetx.js';
import type { Session } from '../flows/session.js';
import { escrowPubkeyFromXpub } from '../keys/derive.js';
import type { IncomingMessage } from '../nostr/messenger.js';
import {
  MSG, type Address, type OrderFunded, type OrderQuote, type OrderRequest, type SignedPayout,
} from '../nostr/messages.js';
import { fromHex, toHex } from '../util/bytes.js';
import { computeLockAmount } from '../util/decimal.js';
import { nowSeconds } from '../util/time.js';

export interface FakeShopperOptions {
  catalog: Record<string, number>; // sku -> JPY
  shippingJpy: number;
  feeBps?: number;
  feeMinJpy?: number;
  /** JPY per coin. */
  rates: { 'btc-signet': number; 'usdc-evm': number };
  payoutFeeReserve?: bigint;
  escrowUpfrontFee: { 'btc-signet': bigint; 'usdc-evm': bigint };
  btcTimelocks?: { t1: number; t2: number };
  evmTimelockSeconds?: { t1: number; t2: number };
  /** Delay between shipping updates (ms). */
  shippingDelayMs?: number;
}

interface ShopperOrder {
  request: OrderRequest;
  user: string;
  quote?: OrderQuote;
  quoteId?: string;
  address?: Address;
  funded?: OrderFunded;
  completedTxid?: string;
}

/**
 * Minimal shopper written in TS for tests only: quotes with fixed prices,
 * "purchases" instantly and co-signs releases. The real shopper is the Go node.
 */
export class FakeShopper {
  readonly orders = new Map<string, ShopperOrder>();
  readonly errors: Error[] = [];

  constructor(
    private readonly s: Session,
    private readonly o: FakeShopperOptions,
  ) {
    s.messenger.on('message', (m) => void this.handle(m).catch((e) => this.errors.push(e as Error)));
  }

  private async handle(m: IncomingMessage): Promise<void> {
    switch (m.type) {
      case MSG.request:
        return this.onRequest(m);
      case MSG.accept: {
        const ord = this.orders.get(m.orderId);
        if (ord && m.from === ord.user) ord.quoteId = (m.body as { quote_id: string }).quote_id;
        return;
      }
      case MSG.funded:
        return this.onFunded(m);
      case MSG.release:
        return this.onRelease(m);
    }
  }

  private async onRequest(m: IncomingMessage): Promise<void> {
    const req = m.body as OrderRequest;
    const ord: ShopperOrder = { request: req, user: m.from };
    this.orders.set(m.orderId, ord);
    const key = await unwrapDeliveryKey(this.s.signer, m.from, req.delivery.key_for_shopper);
    ord.address = decryptAddress(key, m.orderId, req.delivery.ciphertext);

    const snap = this.s.directory.current ?? (await this.s.directory.refresh());
    const escrow = snap.escrows.get(req.escrow)?.content;
    if (!escrow) {
      await this.s.messenger.send(m.from, m.orderId, MSG.quote, { accept: false, reject_reason: 'unavailable', detail: 'unknown escrow' });
      return;
    }
    const items = req.items.reduce((sum, i) => sum + (this.o.catalog[i.sku] ?? 0) * i.qty, 0);
    const fee = Math.max(Math.ceil((items * (this.o.feeBps ?? 500)) / 10000), this.o.feeMinJpy ?? 300);
    const asset = req.payment;
    const rate = String(this.o.rates[asset]);
    const reserve = asset === 'btc-signet' ? (this.o.payoutFeeReserve ?? 1000n) : 0n;
    const lock = computeLockAmount([String(items), String(this.o.shippingJpy), String(fee)], rate, asset === 'btc-signet' ? 8 : 6, reserve);
    const pair = asset === 'btc-signet' ? 'BTC/JPY' : 'USDC/JPY';
    const quote: OrderQuote = {
      accept: true,
      detail: 'ok',
      expires_at: nowSeconds() + 900,
      price: {
        items: { amount: String(items), currency: 'JPY' },
        shipping: { amount: String(this.o.shippingJpy), currency: 'JPY' },
        shopper_fee: { amount: String(fee), currency: 'JPY' },
      },
      fx: { pair, rate, sources: [{ name: 'static', rate, at: nowSeconds() }], at: nowSeconds() },
      asset,
      lock_amount: lock.toString(),
      escrow_upfront_fee: this.o.escrowUpfrontFee[asset].toString(),
      payout_fee_reserve: reserve.toString(),
    };
    if (asset === 'btc-signet') {
      const tip = await this.s.chain!.tipHeight();
      const t = this.o.btcTimelocks ?? { t1: tip + 100, t2: tip + 150 };
      const shopperKey = this.s.keys.orderKey(m.orderId).publicKey;
      const escrowKey = escrowPubkeyFromXpub(escrow.btc_xpub, m.orderId);
      Object.assign(quote, {
        timelock: t,
        shopper_btc_pubkey: toHex(shopperKey),
        shopper_btc_address: this.s.keys.btcWallet.address,
        escrow_btc_pubkey: toHex(escrowKey),
        escrow_btc_fee_address: escrow.btc_fee_address,
        escrow_address: p2wshAddress(witnessScript({ user: fromHex(req.user_btc_pubkey!), shopper: shopperKey, escrow: escrowKey }, t.t1, t.t2)),
      });
    } else {
      const evm = this.s.evm!;
      const now = Number(await evm.blockTimestamp());
      const secs = this.o.evmTimelockSeconds ?? { t1: 3600, t2: 7200 };
      const t = { t1: now + secs.t1, t2: now + secs.t2 };
      Object.assign(quote, {
        timelock: t,
        shopper_evm_address: this.s.keys.evmAddress,
        escrow_evm_address: escrow.evm_address,
        escrow_address: orderSafeAddress(evm.deployments, {
          user: req.user_evm_address as `0x${string}`,
          shopper: this.s.keys.evmAddress,
          escrow: escrow.evm_address as `0x${string}`,
          t1: BigInt(t.t1),
          t2: BigInt(t.t2),
          orderId: m.orderId,
        }, await evm.proxyCreationCode()),
      });
    }
    ord.quote = quote;
    await this.s.messenger.send(m.from, m.orderId, MSG.quote, quote);
  }

  private async onFunded(m: IncomingMessage): Promise<void> {
    const ord = this.orders.get(m.orderId);
    if (!ord || m.from !== ord.user) return;
    ord.funded = m.body as OrderFunded;
    const delay = this.o.shippingDelayMs ?? 10;
    const tracking = (status: 'shipped' | 'delivered') => ({
      status, tracking: { status, carrier: 'lab-post', tracking_no: 'LAB123', updated_at: nowSeconds(), evidence: [] },
    });
    await this.s.messenger.send(m.from, m.orderId, MSG.purchased, {
      shop_order_id: `SHOP-${m.orderId.slice(0, 6)}`,
      total: { amount: ord.quote!.price!.items.amount, currency: 'JPY' },
      evidence: [{ kind: 'json', sha256: '00'.repeat(32), mime: 'application/json' }],
    });
    await new Promise((r) => setTimeout(r, delay));
    await this.s.messenger.send(m.from, m.orderId, MSG.shipping, tracking('shipped'));
    await new Promise((r) => setTimeout(r, delay));
    await this.s.messenger.send(m.from, m.orderId, MSG.shipping, tracking('delivered'));
  }

  private async onRelease(m: IncomingMessage): Promise<void> {
    const ord = this.orders.get(m.orderId);
    if (!ord || m.from !== ord.user || !ord.quote) return;
    const body = m.body as SignedPayout;
    const q = ord.quote;
    let txid: string;
    if (body.asset === 'btc-signet') {
      const tx = psbtFromBase64(body.psbt);
      signEscrowInput(tx, this.s.keys.orderKey(m.orderId).privateKey);
      finalizeEscrowInput(tx, {
        user: fromHex(ord.request.user_btc_pubkey!),
        shopper: fromHex(q.shopper_btc_pubkey!),
        escrow: fromHex(q.escrow_btc_pubkey!),
      }, 'multisig');
      txid = await this.s.chain!.broadcast(extractTx(tx).hex);
    } else {
      const evm = this.s.evm!;
      const safe = (ord.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>).safe as `0x${string}`;
      const tx = safeTxFromJson(body.safe_tx);
      const userSigner = await recoverSafeTxSigner(tx, evm.chainId, safe, body.signature as Hex);
      const mine = await signSafeTx(this.s.keys.evmAccount, tx, evm.chainId, safe);
      txid = await evm.execSafeTx(safe, tx, [
        { signer: userSigner, signature: body.signature as Hex },
        { signer: this.s.keys.evmAddress, signature: mine },
      ]);
    }
    ord.completedTxid = txid;
    await this.s.messenger.send(m.from, m.orderId, MSG.completed, { txid });
  }
}
