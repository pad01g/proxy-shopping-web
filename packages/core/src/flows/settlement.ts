import type { Hex } from 'viem';
import type { ChainApi } from '../btc/esplora.js';
import type { EvmClient } from '../evm/chain.js';
import type { OrderFunded } from '../nostr/messages.js';

export interface SpendCheck {
  spent: boolean;
  /** The transaction that spent the escrow output, as seen on chain (BTC) or the claimed hash (USDC). */
  txid?: string;
  detail: string;
}

/**
 * Has the escrow output of `funded` really been paid out (§4.8)? A peer's order.completed or
 * dispute.countersigned is only a claim; terminal states wait for this.
 *   BTC: /tx/{txid}/outspend/{vout} says the funded outpoint is spent.
 *   USDC: the Safe's USDC balance is 0 and the claimed transaction has a successful receipt.
 */
export async function escrowSpent(p: { chain?: ChainApi; evm?: EvmClient; funded: OrderFunded; claimedTx?: string }): Promise<SpendCheck> {
  if (p.funded.asset === 'btc-signet') {
    if (!p.chain) return { spent: false, detail: 'no BTC chain API' };
    const o = await p.chain.outspend(p.funded.txid, p.funded.vout ?? 0);
    if (!o.spent) return { spent: false, detail: 'escrow output is still unspent' };
    const note = o.txid && p.claimedTx && o.txid !== p.claimedTx ? ` (claimed ${p.claimedTx})` : '';
    return { spent: true, txid: o.txid ?? p.claimedTx, detail: `escrow output spent by ${o.txid ?? 'unknown tx'}${note}` };
  }
  if (!p.evm) return { spent: false, detail: 'no EVM client' };
  const balance = await p.evm.usdcBalance(p.funded.safe as `0x${string}`);
  if (balance !== 0n) return { spent: false, detail: `Safe still holds ${balance}` };
  if (!p.claimedTx || !/^0x[0-9a-fA-F]{64}$/.test(p.claimedTx)) return { spent: false, detail: 'Safe is empty but no transaction to check' };
  const ok = await p.evm.receiptOk(p.claimedTx as Hex);
  if (!ok) return { spent: false, detail: `no successful receipt for ${p.claimedTx}` };
  return { spent: true, txid: p.claimedTx, detail: `Safe emptied by ${p.claimedTx}` };
}
