import { useEffect, useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { ActionButton, Explain } from '../../components/ui';
import { useT } from '../../i18n';
import { useDemoState, useRuntime } from '../../state';
import { NewOrderForm } from './NewOrderForm';
import { OrderDetail } from './OrderDetail';
import { OrderList } from './OrderList';

export function UserPanel() {
  const { scenarioOrderId } = useDemoState();
  const m = useT();
  const [picked, setPicked] = useState<string>();
  // A new order of the scenario takes the detail view.
  useEffect(() => setPicked(undefined), [scenarioOrderId]);
  const selected = picked ?? scenarioOrderId;
  return (
    <div data-testid="panel-user">
      <IdentityCard role="user" title={m.user.wallet}>
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
  const m = useT();
  const u = m.user;
  return (
    <>
      <Explain>{rt.deps.backend.mock ? m.mock.faucetExplain : u.faucetExplain}</Explain>
      <div className="row">
        <ActionButton testid="wallet-faucet-btc" kind="plain" onClick={async () => {
          await rt.faucet.btc(rt.keys.btcWallet.address);
          await rt.refreshBalances();
        }}>
          {u.faucetBtc}
        </ActionButton>
        <ActionButton testid="wallet-faucet-evm" kind="plain" onClick={async () => {
          await rt.faucet.evm(rt.keys.evmAddress);
          await rt.refreshBalances();
        }}>
          {u.faucetEvm}
        </ActionButton>
      </div>
    </>
  );
}
