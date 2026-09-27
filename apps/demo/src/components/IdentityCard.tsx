import type { ReactNode } from 'react';
import { btcBalance, erc20Balance, ethBalance } from '../lib/lab-api';
import { formatAsset, formatEth, short } from '../lib/format';
import type { SessionRole } from '../lib/roles';
import { every, useApp, useLive } from '../state';
import { Copyable, Section } from './ui';

export interface WalletBalances {
  btc?: bigint;
  usdc?: bigint;
  eth?: bigint;
}

/** Balances of a role's wallets, read straight from the chain APIs (works for roles of other windows too). */
export function useBalances(role: SessionRole, ms = 5000): [WalletBalances | undefined, () => void] {
  const app = useApp();
  const id = app.ids[role];
  const { urls } = app.config;
  const usdc = app.deployments?.usdc;
  return useLive(async () => {
    const [btc, eth, u] = await Promise.allSettled([
      btcBalance(urls.esplora, id.btcAddress),
      ethBalance(urls.evm, id.evmAddress),
      usdc ? erc20Balance(urls.evm, usdc, id.evmAddress) : Promise.reject(new Error('no usdc')),
    ]);
    const v = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : undefined);
    return { btc: v(btc), eth: v(eth), usdc: v(u) };
  }, every(ms), [id.pubkey]);
}

/** A role's keys (kept in this browser) and balances. */
export function IdentityCard({ role, title, children }: { role: SessionRole; title: string; children?: ReactNode }) {
  const app = useApp();
  const id = app.ids[role];
  const [bal] = useBalances(role);
  return (
    <Section title={title} testid={`identity-${role}`}>
      <div className="identity" data-pubkey={id.pubkey}>
        <p>公開鍵（Nostr）: <Copyable value={id.pubkey} display={short(id.pubkey, 10)} testid={`identity-${role}-pubkey`} /></p>
        <p>BTC アドレス: <Copyable value={id.btcAddress} testid={`identity-${role}-btc`} /> ・ <span data-testid={`identity-${role}-btc-balance`}>{bal?.btc === undefined ? '…' : formatAsset(bal.btc, 'btc-signet')}</span></p>
        <p>EVM アドレス: <Copyable value={id.evmAddress} testid={`identity-${role}-evm`} /> ・ {bal?.usdc === undefined ? '…' : formatAsset(bal.usdc, 'usdc-evm')} ・ {formatEth(bal?.eth)}</p>
      </div>
      <p className="muted small">
        {role === 'coordinator'
          ? '鍵は lab の固定のデモ用 coordinator（lab/keys/coordinator-demo.mnemonic）です。lab のノードはこの公開鍵を信頼するよう設定されています。'
          : '鍵はこのブラウザの localStorage に平文で置いています（lab 専用）。「デモを初期化」で消えます。'}
      </p>
      {children}
    </Section>
  );
}
