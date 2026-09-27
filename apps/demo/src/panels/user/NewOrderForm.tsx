import { type Offer, type Payment } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ActionButton, Explain, Field, Mono, Section } from '../../components/ui';
import { PAYMENT_LABEL, short } from '../../lib/format';
import { DEMO_ADDRESS, REGION_PRESETS, SHOP_PRESETS } from '../../scenarios/presets';
import type { OrderPreset } from '../../scenarios/types';
import { useApp, useDemoState, useRuntime } from '../../state';

const offerKey = (o: Offer) => `${o.entry.region}|${o.entry.shopper}|${o.entry.escrow}|${o.entry.provenance.operator}`;

/** The shop, item and payment of an order; starts as the scenario's preset. */
function useOrderForm() {
  const { guide } = useDemoState();
  const scenarioPreset = guide.scenario.preset ?? SHOP_PRESETS[0];
  const [form, setForm] = useState<OrderPreset>(scenarioPreset);
  // Switching scenarios switches the form to that scenario's shop and item.
  useEffect(() => setForm(scenarioPreset), [scenarioPreset.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return [form, setForm] as const;
}

export function NewOrderForm({ onCreated }: { onCreated: (id: string) => void }) {
  const app = useApp();
  const rt = useRuntime('user');
  const [form, setForm] = useOrderForm();
  const [qty, setQty] = useState(1);
  const [address, setAddress] = useState(DEMO_ADDRESS);
  const [offers, setOffers] = useState<Offer[]>();
  const [chosen, setChosen] = useState<string>();

  /** The combination the user picked, else the demo's own one (shopper-1 × this browser's escrow). */
  const pick = (list: Offer[]): Offer | undefined =>
    list.find((o) => offerKey(o) === chosen)
    ?? list.find((o) => o.entry.shopper === app.shopper.pubkey && o.entry.escrow === app.ids.escrow.pubkey);

  const search = async (): Promise<Offer[]> => {
    const list = await rt.searchOffers({ shopUrl: form.shopUrl, region: form.region, payment: form.payment });
    setOffers(list);
    return list;
  };

  // Look for candidates whenever the shop, region or payment changes (the guide only asks for the submit click).
  useEffect(() => {
    void search().catch(() => undefined);
  }, [form.shopUrl, form.region, form.payment]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    // The candidates may predate the operator's latest list: search again when ours is not among them.
    const offer = pick(offers ?? []) ?? pick(await search());
    if (!offer) throw new Error('このデモの escrow の組み合わせが候補にありません。ガイドの「準備」の手順（委任・一覧・escrow のプロフィール）を済ませるか、候補を選んでください');
    if (!form.sku.trim() || qty < 1) throw new Error('商品と数量を入れてください');
    const order = await rt.client.createOrder({
      offer, shopUrl: form.shopUrl, region: form.region, items: [{ sku: form.sku.trim(), qty }], payment: form.payment, address,
    });
    onCreated(order.id);
  };

  const selected = offers && pick(offers);
  return (
    <Section title="注文する" testid="new-order">
      <Explain>
        店と商品を選ぶと、信頼している coordinator → operator の一覧から、その地域を扱う shopper × escrow の組み合わせ（候補）を探します。
        注文すると、届け先を暗号化した依頼（order.request）が shopper に届き、shopper が見積を返します。
      </Explain>
      <div className="row presets">
        {SHOP_PRESETS.map((p) => (
          <button key={p.id} type="button" className={`plain small${p.id === form.id ? ' selected' : ''}`} data-testid={`order-preset-${p.id}`} onClick={() => setForm(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid2">
        <Field label="店の URL">
          <input data-testid="order-shop-url" value={form.shopUrl} onChange={(e) => setForm({ ...form, id: 'custom', shopUrl: e.target.value })} />
        </Field>
        <Field label="商品の SKU と数量">
          <div className="row">
            <input data-testid="order-sku" value={form.sku} onChange={(e) => setForm({ ...form, id: 'custom', sku: e.target.value })} />
            <input data-testid="order-qty" type="number" min={1} max={99} style={{ maxWidth: 80 }} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </div>
        </Field>
        <Field label="店の地域コード">
          <div className="row">
            <input data-testid="order-region" value={form.region} onChange={(e) => setForm({ ...form, id: 'custom', region: e.target.value })} />
            <select data-testid="order-region-preset" value="" onChange={(e) => e.target.value && setForm({ ...form, id: 'custom', region: e.target.value })}>
              <option value="">よく使う地域…</option>
              {REGION_PRESETS.map((r) => <option key={r.code} value={r.code}>{r.code}（{r.label}）</option>)}
            </select>
          </div>
        </Field>
        <Field label="支払い">
          <select data-testid="order-payment" value={form.payment} onChange={(e) => setForm({ ...form, id: 'custom', payment: e.target.value as Payment })}>
            {Object.entries(PAYMENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>

      <h3>shopper × escrow の候補</h3>
      <div className="row">
        <ActionButton testid="order-search" kind="plain" onClick={search}>候補を探し直す</ActionButton>
      </div>
      <div data-testid="offers" data-count={offers?.length ?? 0}>
        {offers?.length === 0 && <p className="muted" data-testid="offers-empty">条件に合う組み合わせはありません。</p>}
        {offers?.map((o) => {
          const k = offerKey(o);
          const isDemo = o.entry.shopper === app.shopper.pubkey && o.entry.escrow === app.ids.escrow.pubkey;
          return (
            <label key={k} className={`offer${selected && offerKey(selected) === k ? ' selected' : ''}`} data-testid="offer" data-escrow={o.entry.escrow} data-shopper={o.entry.shopper}>
              <input type="radio" name="offer" checked={!!selected && offerKey(selected) === k} onChange={() => setChosen(k)} />
              <span>
                <strong>{o.shopper?.content.name ?? short(o.entry.shopper)}</strong> × <strong>{o.escrow?.content.name ?? short(o.entry.escrow)}</strong>
                <span className="badge">{o.entry.region}</span>
                {isDemo && <span className="badge ok">このデモの escrow</span>}
                <span className="muted small">
                  {' '}出所: coordinator <Mono>{short(o.entry.provenance.coordinator)}</Mono> → operator <Mono>{short(o.entry.provenance.operator)}</Mono>（一覧 v{o.entry.provenance.listVersion}）
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <h3>届け先（暗号化して shopper と escrow にだけ渡します）</h3>
      <div className="grid2">
        <Field label="氏名"><input data-testid="address-name" value={address.name} onChange={(e) => setAddress({ ...address, name: e.target.value })} /></Field>
        <Field label="郵便番号"><input data-testid="address-postal-code" value={address.postal_code} onChange={(e) => setAddress({ ...address, postal_code: e.target.value })} /></Field>
        <Field label="住所"><input data-testid="address-address" value={address.address} onChange={(e) => setAddress({ ...address, address: e.target.value })} /></Field>
        <Field label="電話"><input data-testid="address-phone" value={address.phone} onChange={(e) => setAddress({ ...address, phone: e.target.value })} /></Field>
      </div>
      <ActionButton testid="order-submit" onClick={submit}>見積を依頼する</ActionButton>
    </Section>
  );
}
