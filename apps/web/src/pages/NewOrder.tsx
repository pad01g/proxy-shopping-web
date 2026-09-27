import type { Offer, Payment } from '@proxy-shopping/core/browser';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionButton, ErrorText, Field, Mono, Section } from '../components/ui';
import { PAYMENT_LABEL, short } from '../lib/format';
import { useRuntime } from '../state';

interface Item {
  sku: string;
  qty: number;
}

export function NewOrderPage() {
  const rt = useRuntime();
  const navigate = useNavigate();
  const [shopUrl, setShopUrl] = useState('https://safe-shop.test/');
  const [region, setRegion] = useState('JP-13-13104');
  const [payment, setPayment] = useState<Payment>('btc-signet');
  const [items, setItems] = useState<Item[]>([{ sku: '', qty: 1 }]);
  const [offers, setOffers] = useState<Offer[]>();
  const [selected, setSelected] = useState(0);
  const [address, setAddress] = useState({ name: '', postal_code: '', address: '', phone: '' });
  const [error, setError] = useState<string>();

  const search = async () => {
    setOffers(await rt.user.discoverOffers({ shopUrl, region, payment }));
    setSelected(0);
  };

  const submit = async () => {
    const offer = offers?.[selected];
    if (!offer) throw new Error('組み合わせを選んでください');
    const clean = items.filter((i) => i.sku.trim() && i.qty > 0).map((i) => ({ sku: i.sku.trim(), qty: i.qty }));
    if (!clean.length) throw new Error('商品を入れてください');
    if (!address.name || !address.address) throw new Error('届け先を入れてください');
    const order = await rt.user.createOrder({ offer, shopUrl, region, items: clean, payment, address });
    navigate(`/user/orders/${order.id}`);
  };

  return (
    <div data-testid="new-order">
      <h1>注文する</h1>
      <Section title="店と商品">
        <div className="grid2">
          <Field label="店の URL">
            <input data-testid="order-shop-url" value={shopUrl} onChange={(e) => setShopUrl(e.target.value)} />
          </Field>
          <Field label="店の地域コード（例 JP-13-13104）">
            <input data-testid="order-region" value={region} onChange={(e) => setRegion(e.target.value)} />
          </Field>
          <Field label="支払い">
            <select data-testid="order-payment" value={payment} onChange={(e) => setPayment(e.target.value as Payment)}>
              {Object.entries(PAYMENT_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
        </div>
        {items.map((it, i) => (
          <div className="row" key={i} data-testid="order-item-row">
            <input data-testid={`order-item-sku-${i}`} placeholder="SKU（例 A-100）" value={it.sku} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))} />
            <input data-testid={`order-item-qty-${i}`} type="number" min={1} style={{ maxWidth: 90 }} value={it.qty} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
            {items.length > 1 && (
              <button type="button" className="plain small" onClick={() => setItems(items.filter((_, j) => j !== i))}>削除</button>
            )}
          </div>
        ))}
        <button type="button" className="plain" data-testid="order-item-add" onClick={() => setItems([...items, { sku: '', qty: 1 }])}>
          商品を追加
        </button>
      </Section>

      <Section title="shopper × escrow の候補">
        <ActionButton testid="order-search" onClick={search}>候補を探す</ActionButton>
        {offers && offers.length === 0 && <p className="muted" data-testid="offers-empty">条件に合う組み合わせがありません。設定の coordinator を確かめてください。</p>}
        <div data-testid="offers" data-count={offers?.length ?? 0}>
          {offers?.map((o, i) => (
            <div key={`${o.entry.shopper}${o.entry.escrow}${o.entry.region}`} className={`offer${i === selected ? ' selected' : ''}`} data-testid={`offer-${i}`}>
              <div className="row">
                <input type="radio" style={{ width: 'auto' }} name="offer" data-testid={`offer-select-${i}`} checked={i === selected} onChange={() => setSelected(i)} />
                <strong>{o.shopper?.content.name ?? short(o.entry.shopper)}</strong>
                <span>×</span>
                <strong>{o.escrow?.content.name ?? short(o.entry.escrow)}</strong>
                <span className="badge">{o.entry.region}</span>
              </div>
              <p className="muted">
                手数料 {o.shopper ? `${o.shopper.content.fee.bps / 100}%` : '?'}
                {o.shopper?.content.fee.min ? `（最低 ${o.shopper.content.fee.min.amount} ${o.shopper.content.fee.min.currency}）` : ''}
                ・ 配送 {o.shopper?.content.delivery_days ?? '?'} 日 ・ escrow 前払い {o.escrow ? `${o.escrow.content.upfront_fee.bps / 100}%` : '?'}
                ・ 紛争手数料 {o.escrow ? `${o.escrow.content.dispute_fee_bps / 100}%` : '?'} ・ SLA {o.entry.escrow_sla_days} 日
              </p>
              <p className="muted" data-testid={`offer-provenance-${i}`}>
                出所: coordinator <Mono>{short(o.entry.provenance.coordinator)}</Mono> → operator <Mono>{short(o.entry.provenance.operator)}</Mono>（一覧 v{o.entry.provenance.listVersion}）
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="届け先（暗号化して shopper と escrow にだけ渡します）">
        <div className="grid2">
          <Field label="氏名"><input data-testid="address-name" value={address.name} onChange={(e) => setAddress({ ...address, name: e.target.value })} /></Field>
          <Field label="郵便番号"><input data-testid="address-postal-code" value={address.postal_code} onChange={(e) => setAddress({ ...address, postal_code: e.target.value })} /></Field>
          <Field label="住所"><input data-testid="address-address" value={address.address} onChange={(e) => setAddress({ ...address, address: e.target.value })} /></Field>
          <Field label="電話"><input data-testid="address-phone" value={address.phone} onChange={(e) => setAddress({ ...address, phone: e.target.value })} /></Field>
        </div>
      </Section>
      <ActionButton testid="order-submit" disabled={!offers?.length} onClick={submit} onError={setError}>
        見積を依頼する
      </ActionButton>
      <ErrorText error={error} testid="order-submit-error" />
    </div>
  );
}
