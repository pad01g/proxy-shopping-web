import { useState } from 'react';
import { ActionButton, Explain, Field, Section } from '../../components/ui';
import { useT } from '../../i18n';
import { formatEth, formatTime } from '../../lib/format';
import { every, useApp, useApplyPrefill, useDemoState, useLive, usePrefill } from '../../state';

export function LabPanel() {
  const app = useApp();
  const m = useT();
  return (
    <div data-testid="panel-lab">
      <p className="banner warn">{app.mock ? m.mock.labWarning : m.lab.warning}</p>
      {app.mock && <MockSection />}
      <ChainSection />
      <ShopperNodeSection />
      <RatesSection />
    </div>
  );
}

/** Mock mode: what runs in the page instead of the lab. */
function MockSection() {
  const m = useT();
  return (
    <Section title={m.mock.whatTitle} testid="lab-mock-info">
      <ul className="mock-list">
        {m.mock.what.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </Section>
  );
}

function ChainSection() {
  const app = useApp();
  const { lab } = useDemoState();
  const m = useT();
  const faucet = app.backend.faucet;
  const minePrefill = usePrefill('lab-mine');
  const [blocks, setBlocks] = useState(() => Number(minePrefill?.blocks ?? 1));
  const [seconds, setSeconds] = useState(3600);
  useApplyPrefill('lab-mine', (p) => typeof p.blocks === 'number' && setBlocks(p.blocks));
  return (
    <Section title={m.lab.chain} testid="lab-chain">
      <Explain>{app.mock ? m.mock.chainExplain : m.lab.chainExplain}</Explain>
      <p data-testid="lab-heights" data-btc={lab.heights?.btc ?? ''} data-evm-time={lab.heights?.evm_time ?? ''}>
        {m.lab.btcHeight}<strong>{lab.heights?.btc ?? '…'}</strong>{m.common.sep}{m.lab.evmTime}{lab.heights ? formatTime(lab.heights.evm_time) : '…'}
        {lab.heightsError && <span className="error"> {lab.heightsError}</span>}
      </p>
      <div className="row">
        <Field label={m.lab.mineBlocks}>
          <input data-testid="lab-mine-blocks" type="number" min={1} max={1000} value={blocks} onChange={(e) => setBlocks(Number(e.target.value))} />
        </Field>
        <ActionButton testid="lab-mine" kind="plain" disabled={!(blocks >= 1)} onClick={async () => {
          await faucet.mine(blocks);
          await app.lab.refresh();
        }}>
          {m.lab.mine}
        </ActionButton>
      </div>
      <div className="row">
        <Field label={m.lab.evmSeconds}>
          <input data-testid="lab-evm-seconds" type="number" min={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </Field>
        <ActionButton testid="lab-evm-time" kind="plain" disabled={!(seconds >= 1)} onClick={async () => {
          await faucet.evmTime(seconds);
          await app.lab.refresh();
        }}>
          {m.lab.evmTimeButton}
        </ActionButton>
      </div>
    </Section>
  );
}

function ShopperNodeSection() {
  const app = useApp();
  const { lab } = useDemoState();
  const m = useT();
  const faucet = app.backend.faucet;
  const paused = (lab.shopper.status?.paused_until ?? 0) > Date.now() / 1000;
  return (
    <Section title={m.lab.node(app.shopper.name)} testid="lab-shopper">
      <Explain>{m.lab.nodeExplain}</Explain>
      <p data-testid="lab-shopper-state" data-paused={paused ? 'true' : 'false'}>
        {paused ? m.lab.pausedUntil(formatTime(lab.shopper.status!.paused_until!)) : m.lab.running}{m.common.sep}{m.lab.gas}{formatEth(lab.shopper.eth)}
      </p>
      <div className="row">
        <ActionButton testid="lab-pause-shopper" kind="danger" disabled={paused} onClick={async () => {
          await app.lab.node.pause(1800);
          await app.lab.refresh();
        }}>
          {m.lab.pause}
        </ActionButton>
        <ActionButton testid="lab-resume-shopper" kind="plain" disabled={!paused} onClick={async () => {
          await app.lab.node.resume();
          await app.lab.refresh();
        }}>
          {m.lab.resume}
        </ActionButton>
        <ActionButton testid="lab-shopper-gas" kind="plain" disabled={!app.shopper.evm_address} onClick={async () => {
          await faucet.evm(app.shopper.evm_address!, { eth: '10', usdc: '0' });
          await app.lab.refresh();
        }}>
          {m.lab.sendGas}
        </ActionButton>
      </div>
    </Section>
  );
}

function RatesSection() {
  const app = useApp();
  const m = useT();
  const rates = app.backend.rates;
  const [current, refresh] = useLive(() => rates.get(), every(10_000), []);
  const [pair, setPair] = useState('BTC/USD');
  const [value, setValue] = useState('');
  return (
    <Section title={m.lab.rates} testid="lab-rates">
      <Explain>{m.lab.ratesExplain}</Explain>
      <p data-testid="lab-rates-current">{current ? Object.entries(current).map(([k, v]) => `${k} = ${v}`).join(m.common.sep) : '…'}</p>
      <div className="row">
        <select data-testid="lab-rates-pair" value={pair} onChange={(e) => setPair(e.target.value)}>
          {Object.keys(current ?? { 'BTC/USD': '', 'USD/JPY': '', 'USDC/USD': '' }).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input data-testid="lab-rates-value" placeholder={m.lab.ratePlaceholder} value={value} onChange={(e) => setValue(e.target.value)} />
        <ActionButton testid="lab-rates-set" kind="plain" disabled={!/^\d+(\.\d+)?$/.test(value)} onClick={async () => {
          await rates.set({ [pair]: value });
          refresh();
        }}>
          {m.lab.setRate}
        </ActionButton>
        <ActionButton testid="lab-rates-reset" kind="plain" onClick={async () => {
          await rates.set({ 'BTC/USD': '100000', 'USD/JPY': '150', 'USDC/USD': '1' });
          refresh();
        }}>
          {m.lab.resetRates}
        </ActionButton>
      </div>
    </Section>
  );
}
