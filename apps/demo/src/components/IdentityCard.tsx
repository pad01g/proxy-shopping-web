import type { ReactNode } from 'react';
import { formatAsset, formatEth, short } from '../lib/format';
import type { SessionRole } from '../lib/roles';
import { useT } from '../i18n';
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
  const b = app.backend.balances;
  const usdc = app.deployments?.usdc;
  return useLive(async () => {
    const [btc, eth, u] = await Promise.allSettled([
      b.btc(id.btcAddress),
      b.eth(id.evmAddress),
      usdc ? b.erc20(usdc, id.evmAddress) : Promise.reject(new Error('no usdc')),
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
  const m = useT();
  const sep = m.common.sep;
  return (
    <Section title={title} testid={`identity-${role}`}>
      <div className="identity" data-pubkey={id.pubkey}>
        <p>{m.identity.pubkey}<Copyable value={id.pubkey} display={short(id.pubkey, 10)} testid={`identity-${role}-pubkey`} /></p>
        <p>{m.identity.btc}<Copyable value={id.btcAddress} testid={`identity-${role}-btc`} />{sep}<span data-testid={`identity-${role}-btc-balance`}>{bal?.btc === undefined ? '…' : formatAsset(bal.btc, 'btc-signet')}</span></p>
        <p>{m.identity.evm}<Copyable value={id.evmAddress} testid={`identity-${role}-evm`} />{sep}{bal?.usdc === undefined ? '…' : formatAsset(bal.usdc, 'usdc-evm')}{sep}{formatEth(bal?.eth)}</p>
      </div>
      <p className="muted small">
        {role === 'coordinator' ? m.identity.coordinatorNote : app.mock ? m.mock.identityNote : m.identity.localNote}
      </p>
      {children}
    </Section>
  );
}
