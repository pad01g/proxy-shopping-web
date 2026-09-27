import type { Payment, ShopperProfileContent } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ActionButton, Field, Section, StringList } from '../components/ui';
import { useRuntime } from '../state';

export function ShopperPage() {
  const rt = useRuntime();
  const [p, setP] = useState<ShopperProfileContent>(() => rt.shopper.withOwnAddresses({
    name: 'shopper', payments: ['btc-signet', 'usdc-evm'], currencies: ['JPY'], cash_regions: [],
    fee: { bps: 500, min: { amount: '300', currency: 'JPY' } }, max_order: { amount: '200000', currency: 'JPY' }, delivery_days: 5,
  }));
  const [done, setDone] = useState<string>();
  useEffect(() => {
    void rt.shopper.current().then((cur) => cur && setP(cur));
  }, [rt]);
  const toggle = (x: Payment) => setP({ ...p, payments: p.payments.includes(x) ? p.payments.filter((y) => y !== x) : [...p.payments, x] });
  return (
    <div data-testid="shopper">
      <h1>ショッパーのプロフィール（kind 30502）</h1>
      <p className="muted">買い物の代行そのものは Go ノードと shopper-bot が行います。ここではプロフィールを署名して公開できます。</p>
      <Section title="プロフィール">
        <div className="grid2">
          <Field label="名前"><input data-testid="shopper-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <Field label="配送日数"><input data-testid="shopper-delivery-days" type="number" value={p.delivery_days} onChange={(e) => setP({ ...p, delivery_days: Number(e.target.value) })} /></Field>
          <Field label="手数料 bps"><input data-testid="shopper-fee-bps" type="number" value={p.fee.bps} onChange={(e) => setP({ ...p, fee: { ...p.fee, bps: Number(e.target.value) } })} /></Field>
          <Field label="最低手数料（JPY）"><input data-testid="shopper-fee-min" value={p.fee.min?.amount ?? ''} onChange={(e) => setP({ ...p, fee: { ...p.fee, min: { amount: e.target.value, currency: 'JPY' } } })} /></Field>
          <Field label="上限（JPY）"><input data-testid="shopper-max-order" value={p.max_order?.amount ?? ''} onChange={(e) => setP({ ...p, max_order: { amount: e.target.value, currency: 'JPY' } })} /></Field>
          <Field label="通貨（カンマ区切り）"><input data-testid="shopper-currencies" value={p.currencies.join(',')} onChange={(e) => setP({ ...p, currencies: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
          <Field label="BTC 受取アドレス"><input data-testid="shopper-btc-address" value={p.btc_address ?? ''} onChange={(e) => setP({ ...p, btc_address: e.target.value })} /></Field>
          <Field label="EVM 受取アドレス"><input data-testid="shopper-evm-address" value={p.evm_address ?? ''} onChange={(e) => setP({ ...p, evm_address: e.target.value })} /></Field>
        </div>
        <div className="row">
          {(['btc-signet', 'usdc-evm'] as Payment[]).map((x) => (
            <label key={x} className="row"><input type="checkbox" style={{ width: 'auto' }} data-testid={`shopper-payment-${x}`} checked={p.payments.includes(x)} onChange={() => toggle(x)} />{x}</label>
          ))}
        </div>
        <Field label="現金の店に行ける地域">
          <StringList testid="shopper-cash-regions" values={p.cash_regions} placeholder="JP-13" onChange={(cash_regions) => setP({ ...p, cash_regions })} />
        </Field>
      </Section>
      <ActionButton
        testid="shopper-publish"
        onClick={async () => {
          const { event, result } = await rt.shopper.publish(p);
          setDone(`v${event.tags.find((t) => t[0] === 'v')?.[1]} を ${result.ok.length} 個のリレーに公開しました`);
        }}
      >
        署名して公開
      </ActionButton>
      {done && <p className="muted" data-testid="shopper-published">{done}</p>}
    </div>
  );
}
