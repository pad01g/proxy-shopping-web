import { useState } from 'react';
import { ActionButton, Explain, Field, Section } from '../../components/ui';
import { faucetApi, ratesApi } from '../../lib/lab-api';
import { formatEth, formatTime } from '../../lib/format';
import { every, useApp, useApplyPrefill, useDemoState, useLive, usePrefill } from '../../state';

export function LabPanel() {
  return (
    <div data-testid="panel-lab">
      <p className="banner warn">
        ここの操作は lab（docker compose の閉じた網）専用です。本物の網では、誰もブロックを掘らせたり時刻を進めたり、shopper を止めたりはできません。
      </p>
      <ChainSection />
      <ShopperNodeSection />
      <RatesSection />
    </div>
  );
}

function ChainSection() {
  const app = useApp();
  const { lab } = useDemoState();
  const faucet = faucetApi(app.config.urls.faucet);
  const minePrefill = usePrefill('lab-mine');
  const [blocks, setBlocks] = useState(() => Number(minePrefill?.blocks ?? 1));
  const [seconds, setSeconds] = useState(3600);
  useApplyPrefill('lab-mine', (p) => typeof p.blocks === 'number' && setBlocks(p.blocks));
  return (
    <Section title="チェーン" testid="lab-chain">
      <Explain>BTC は OP_TRUE の独自 signet（bitcoind）、EVM は anvil（chain id 31337）です。faucet は mempool に取引があると 1 秒ごとに 1 ブロック掘ります。</Explain>
      <p data-testid="lab-heights" data-btc={lab.heights?.btc ?? ''} data-evm-time={lab.heights?.evm_time ?? ''}>
        BTC の高さ <strong>{lab.heights?.btc ?? '…'}</strong> ・ EVM の時刻 {lab.heights ? formatTime(lab.heights.evm_time) : '…'}
        {lab.heightsError && <span className="error"> {lab.heightsError}</span>}
      </p>
      <div className="row">
        <Field label="掘るブロック数">
          <input data-testid="lab-mine-blocks" type="number" min={1} max={1000} value={blocks} onChange={(e) => setBlocks(Number(e.target.value))} />
        </Field>
        <ActionButton testid="lab-mine" kind="plain" disabled={!(blocks >= 1)} onClick={async () => {
          await faucet.mine(blocks);
          await app.lab.refresh();
        }}>
          ブロックを掘る
        </ActionButton>
      </div>
      <div className="row">
        <Field label="EVM の時刻を進める（秒）">
          <input data-testid="lab-evm-seconds" type="number" min={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </Field>
        <ActionButton testid="lab-evm-time" kind="plain" disabled={!(seconds >= 1)} onClick={async () => {
          await faucet.evmTime(seconds);
          await app.lab.refresh();
        }}>
          時刻を進める
        </ActionButton>
      </div>
    </Section>
  );
}

function ShopperNodeSection() {
  const app = useApp();
  const { lab } = useDemoState();
  const faucet = faucetApi(app.config.urls.faucet);
  const paused = (lab.shopper.status?.paused_until ?? 0) > Date.now() / 1000;
  return (
    <Section title={`${app.shopper.name} ノード`} testid="lab-shopper">
      <Explain>
        一時停止すると、ノードはメッセージの送受信と定期処理（入金の確認・購入・支払い）を止めます。「shopper が消えた」ときの T2 の返金を試すのに使います。
        止めている間に送られたメッセージはリレーに残り、再開すると読みます。
      </Explain>
      <p data-testid="lab-shopper-state" data-paused={paused ? 'true' : 'false'}>
        {paused ? `一時停止中（${formatTime(lab.shopper.status!.paused_until!)} まで）` : '動いています'} ・ ガス代 {formatEth(lab.shopper.eth)}
      </p>
      <div className="row">
        <ActionButton testid="lab-pause-shopper" kind="danger" disabled={paused} onClick={async () => {
          await app.lab.node.pause(1800);
          await app.lab.refresh();
        }}>
          一時停止する（30 分）
        </ActionButton>
        <ActionButton testid="lab-resume-shopper" kind="plain" disabled={!paused} onClick={async () => {
          await app.lab.node.resume();
          await app.lab.refresh();
        }}>
          再開する
        </ActionButton>
        <ActionButton testid="lab-shopper-gas" kind="plain" disabled={!app.shopper.evm_address} onClick={async () => {
          await faucet.evm(app.shopper.evm_address!, { eth: '10', usdc: '0' });
          await app.lab.refresh();
        }}>
          ガス代（ETH 10）を送る
        </ActionButton>
      </div>
    </Section>
  );
}

function RatesSection() {
  const app = useApp();
  const rates = ratesApi(app.config.urls.ratesAdmin);
  const [current, refresh] = useLive(() => rates.get(), every(10_000), []);
  const [pair, setPair] = useState('BTC/USD');
  const [value, setValue] = useState('');
  return (
    <Section title="レート（模擬）" testid="lab-rates">
      <Explain>
        shopper も利用者のアプリも、このレートの模擬（CoinGecko と Frankfurter の互換 API）から換算します。変えると両者が同じ新しい値を使います
        （利用者だけが別の取得元を使えば、見積とのずれが警告になります）。
      </Explain>
      <p data-testid="lab-rates-current">{current ? Object.entries(current).map(([k, v]) => `${k} = ${v}`).join(' ・ ') : '…'}</p>
      <div className="row">
        <select data-testid="lab-rates-pair" value={pair} onChange={(e) => setPair(e.target.value)}>
          {Object.keys(current ?? { 'BTC/USD': '', 'USD/JPY': '', 'USDC/USD': '' }).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input data-testid="lab-rates-value" placeholder="例 100000" value={value} onChange={(e) => setValue(e.target.value)} />
        <ActionButton testid="lab-rates-set" kind="plain" disabled={!/^\d+(\.\d+)?$/.test(value)} onClick={async () => {
          await rates.set({ [pair]: value });
          refresh();
        }}>
          レートを変える
        </ActionButton>
        <ActionButton testid="lab-rates-reset" kind="plain" onClick={async () => {
          await rates.set({ 'BTC/USD': '100000', 'USD/JPY': '150', 'USDC/USD': '1' });
          refresh();
        }}>
          既定値に戻す
        </ActionButton>
      </div>
    </Section>
  );
}
