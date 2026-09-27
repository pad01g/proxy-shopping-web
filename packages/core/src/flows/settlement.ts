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
 *   USDC: the Safe holds less than lock_amount and the claimed transaction has a successful receipt with a
 *   USDC Transfer out of the Safe. Anyone can send dust to a Safe, so its balance need not reach 0.
 */
export async function escrowSpent(p: { chain?: ChainApi; evm?: EvmClient; funded: OrderFunded; lock: bigint; claimedTx?: string }): Promise<SpendCheck> {
  if (p.funded.asset === 'btc-signet') {
    if (!p.chain) return { spent: false, detail: 'no BTC chain API' };
    const o = await p.chain.outspend(p.funded.txid, p.funded.vout ?? 0);
    if (!o.spent) return { spent: false, detail: 'escrow output is still unspent' };
    const note = o.txid && p.claimedTx && o.txid !== p.claimedTx ? ` (claimed ${p.claimedTx})` : '';
    return { spent: true, txid: o.txid ?? p.claimedTx, detail: `escrow output spent by ${o.txid ?? 'unknown tx'}${note}` };
  }
  if (!p.evm) return { spent: false, detail: 'no EVM client' };
  const safe = p.funded.safe as `0x${string}`;
  const balance = await p.evm.usdcBalance(safe);
  if (balance >= p.lock) return { spent: false, detail: `Safe still holds ${balance} (lock_amount ${p.lock})` };
  if (!p.claimedTx || !/^0x[0-9a-fA-F]{64}$/.test(p.claimedTx)) return { spent: false, detail: 'Safe was paid out but there is no transaction to check' };
  const out = await p.evm.usdcTransferredFrom(p.claimedTx as Hex, safe).catch(() => 0n);
  if (out === 0n) return { spent: false, detail: `${p.claimedTx} has no successful USDC transfer out of the Safe` };
  return { spent: true, txid: p.claimedTx, detail: `Safe paid out ${out} in ${p.claimedTx}` };
}
