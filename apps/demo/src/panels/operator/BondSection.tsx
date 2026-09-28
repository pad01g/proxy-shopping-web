import { useState } from 'react';
import { ActionButton, Explain, Field, Section } from '../../components/ui';
import { useT } from '../../i18n';
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
  const o = useT().operator;
  return (
    <Section title={o.bond} testid="operator-bond">
      <Explain>{o.bondExplain}</Explain>
      <p data-testid="operator-bond-amount" data-amount={bond?.toString() ?? ''}>{o.bondAmount(bond === undefined ? '…' : formatAsset(bond, 'usdc-evm'))}</p>
      <div className="row">
        <Field label={o.slashAmount}>
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
          {o.slash}
        </ActionButton>
      </div>
    </Section>
  );
}
