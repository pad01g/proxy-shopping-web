import { useState } from 'react';
import { ActionButton, Explain, Field, Section } from '../../components/ui';
import { formatAsset } from '../../lib/format';
import { every, useApp, useLive, useRuntime } from '../../state';

/**
 * The reference bond contract (contracts/examples/bond): outside the protocol, an escrow may deposit a bond
 * with its operator, which the operator can slash to compensate a user. The demo escrow deposits nothing, so
 * this usually shows 0.
 */
export function BondSection() {
  const app = useApp();
  const rt = useRuntime('operator');
  const escrow = app.ids.escrow.evmAddress as `0x${string}`;
  const [bond, refresh] = useLive(() => rt.session.evm!.bondOf(escrow), every(10_000), [rt]);
  const [amount, setAmount] = useState('');
  return (
    <Section title="bond（任意の規約）" testid="operator-bond">
      <Explain>掲載料や bond（預かり金）はプロトコルの外の、operator と escrow の間の規約です。lab には参考実装のコントラクトがあります。</Explain>
      <p data-testid="operator-bond-amount" data-amount={bond?.toString() ?? ''}>このデモの escrow の bond: {bond === undefined ? '…' : formatAsset(bond, 'usdc-evm')}</p>
      <div className="row">
        <Field label="没収して利用者に送る額（USDC の基本単位）">
          <input data-testid="operator-bond-slash-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <ActionButton
          testid="operator-bond-slash"
          kind="danger"
          disabled={!bond || !/^\d+$/.test(amount) || BigInt(amount || '0') > bond}
          onClick={async () => {
            await rt.session.evm!.bondSlash(escrow, app.ids.user.evmAddress as `0x${string}`, BigInt(amount));
            refresh();
          }}
        >
          bond を没収する
        </ActionButton>
      </div>
    </Section>
  );
}
