import { formatUnits } from '@proxy-shopping/core/browser';
import { ActionButton, Copyable, Section } from '../components/ui';
import { faucet } from '../lib/faucet';
import { useLive, useRuntime } from '../state';

export function WalletPage() {
  const rt = useRuntime();
  const [bal, refresh] = useLive(() => rt.user.balances(), (cb) => {
    const t = setInterval(cb, 5000);
    return () => clearInterval(t);
  }, [rt]);
  const f = rt.config.faucet_url;
  return (
    <div data-testid="wallet">
      <h1>財布</h1>
      <Section title="BTC（signet, P2WPKH）">
        <p>アドレス: <Copyable value={rt.keys.btcWallet.address} testid="wallet-btc-address" /></p>
        <p data-testid="wallet-btc-balance" data-sats={bal?.btcSats?.toString() ?? ''}>
          残高: {bal?.btcSats === undefined ? '…' : `${bal.btcSats.toLocaleString()} sats（${formatUnits(bal.btcSats, 8)} sBTC, 承認済み）`}
        </p>
        {f && (
          <ActionButton testid="wallet-faucet-btc" kind="plain" onClick={async () => { await faucet.btc(f, rt.keys.btcWallet.address); refresh(); }}>
            蛇口から 0.01 sBTC（lab）
          </ActionButton>
        )}
      </Section>
      <Section title="EVM">
        <p>アドレス: <Copyable value={rt.keys.evmAddress} testid="wallet-evm-address" /></p>
        {!rt.session.evm && <p className="banner warn">EVM に接続していません（deployments / RPC を設定してください）。</p>}
        <p data-testid="wallet-eth-balance">ETH: {bal?.eth === undefined ? '…' : formatUnits(bal.eth, 18)}</p>
        <p data-testid="wallet-usdc-balance" data-units={bal?.usdc?.toString() ?? ''}>USDC: {bal?.usdc === undefined ? '…' : formatUnits(bal.usdc, 6)}</p>
        {f && (
          <ActionButton testid="wallet-faucet-evm" kind="plain" onClick={async () => { await faucet.evm(f, rt.keys.evmAddress); refresh(); }}>
            蛇口から 1 ETH + 1000 USDC（lab）
          </ActionButton>
        )}
      </Section>
      <Section title="Nostr の身元">
        <p><Copyable value={rt.pubkey} testid="wallet-nostr-pubkey" /></p>
      </Section>
      <button type="button" className="plain" data-testid="wallet-refresh" onClick={refresh}>残高を更新</button>
    </div>
  );
}
