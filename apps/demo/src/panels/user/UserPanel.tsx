import { useEffect, useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { ActionButton, Explain } from '../../components/ui';
import { useDemoState, useRuntime } from '../../state';
import { NewOrderForm } from './NewOrderForm';
import { OrderDetail } from './OrderDetail';
import { OrderList } from './OrderList';

export function UserPanel() {
  const { scenarioOrderId } = useDemoState();
  const [picked, setPicked] = useState<string>();
  // A new order of the scenario takes the detail view.
  useEffect(() => setPicked(undefined), [scenarioOrderId]);
  const selected = picked ?? scenarioOrderId;
  return (
    <div data-testid="panel-user">
      <IdentityCard role="user" title="利用者の財布">
        <WalletActions />
      </IdentityCard>
      <NewOrderForm onCreated={setPicked} />
      <OrderList selected={selected} onSelect={setPicked} />
      {selected && <OrderDetail key={selected} id={selected} />}
    </div>
  );
}

function WalletActions() {
  const rt = useRuntime('user');
  return (
    <>
      <Explain>lab の蛇口（faucet）から、注文に使う BTC（signet）と USDC・ガス代の ETH を受け取れます。</Explain>
      <div className="row">
        <ActionButton testid="wallet-faucet-btc" kind="plain" onClick={async () => {
          await rt.faucet.btc(rt.keys.btcWallet.address);
          await rt.refreshBalances();
        }}>
          BTC を受け取る（1,000,000 sats）
        </ActionButton>
        <ActionButton testid="wallet-faucet-evm" kind="plain" onClick={async () => {
          await rt.faucet.evm(rt.keys.evmAddress);
          await rt.refreshBalances();
        }}>
          USDC 1000 と ETH 1 を受け取る
        </ActionButton>
      </div>
    </>
  );
}
