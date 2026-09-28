import { type Offer, type Payment } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ActionButton, Explain, Field, Mono, Section } from '../../components/ui';
import { PAYMENT_LABEL, short } from '../../lib/format';
import { messagesFor, useLang, useT } from '../../i18n';
import { REGION_PRESETS, SHOP_PRESETS, type PresetId } from '../../scenarios/presets';
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
  const m = useT();
  const u = m.user;
  const lang = useLang();
  const rt = useRuntime('user');
  const [form, setForm] = useOrderForm();
  const [qty, setQty] = useState(1);
  const [address, setAddress] = useState(m.presets.address);
  // The prefilled demo address follows the language.
  useEffect(() => setAddress(messagesFor(lang).presets.address), [lang]);
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
    if (!offer) throw new Error(u.noDemoOffer);
    if (!form.sku.trim() || qty < 1) throw new Error(u.needItem);
    const order = await rt.client.createOrder({
      offer, shopUrl: form.shopUrl, region: form.region, items: [{ sku: form.sku.trim(), qty }], payment: form.payment, address,
    });
    onCreated(order.id);
  };

  const selected = offers && pick(offers);
  return (
    <Section title={u.newOrder} testid="new-order">
      <Explain>{u.newOrderExplain}</Explain>
      <div className="row presets">
        {SHOP_PRESETS.map((p) => (
          <button key={p.id} type="button" className={`plain small${p.id === form.id ? ' selected' : ''}`} data-testid={`order-preset-${p.id}`} onClick={() => setForm(p)}>
            {m.presets.shop[p.id as PresetId]}
          </button>
        ))}
      </div>
      <div className="grid2">
        <Field label={u.shopUrl}>
          <input data-testid="order-shop-url" value={form.shopUrl} onChange={(e) => setForm({ ...form, id: 'custom', shopUrl: e.target.value })} />
        </Field>
        <Field label={u.skuQty}>
          <div className="row">
            <input data-testid="order-sku" value={form.sku} onChange={(e) => setForm({ ...form, id: 'custom', sku: e.target.value })} />
            <input data-testid="order-qty" type="number" min={1} max={99} style={{ maxWidth: 80 }} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </div>
        </Field>
        <Field label={u.region}>
          <div className="row">
            <input data-testid="order-region" value={form.region} onChange={(e) => setForm({ ...form, id: 'custom', region: e.target.value })} />
            <select data-testid="order-region-preset" value="" onChange={(e) => e.target.value && setForm({ ...form, id: 'custom', region: e.target.value })}>
              <option value="">{u.regionPreset}</option>
              {REGION_PRESETS.map((r) => <option key={r} value={r}>{u.regionOption(r, m.presets.region[r])}</option>)}
            </select>
          </div>
        </Field>
        <Field label={u.payment}>
          <select data-testid="order-payment" value={form.payment} onChange={(e) => setForm({ ...form, id: 'custom', payment: e.target.value as Payment })}>
            {Object.entries(PAYMENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>

      <h3>{u.offers}</h3>
      <div className="row">
        <ActionButton testid="order-search" kind="plain" onClick={search}>{u.search}</ActionButton>
      </div>
      <div data-testid="offers" data-count={offers?.length ?? 0}>
        {offers?.length === 0 && <p className="muted" data-testid="offers-empty">{u.offersEmpty}</p>}
        {offers?.map((o) => {
          const k = offerKey(o);
          const isDemo = o.entry.shopper === app.shopper.pubkey && o.entry.escrow === app.ids.escrow.pubkey;
          return (
            <label key={k} className={`offer${selected && offerKey(selected) === k ? ' selected' : ''}`} data-testid="offer" data-escrow={o.entry.escrow} data-shopper={o.entry.shopper}>
              <input type="radio" name="offer" checked={!!selected && offerKey(selected) === k} onChange={() => setChosen(k)} />
              <span>
                {/* Profile names are what the shopper and the escrow published (in their own language). */}
                <strong data-i18n-exempt="profile name">{o.shopper?.content.name ?? short(o.entry.shopper)}</strong> × <strong data-i18n-exempt="profile name">{o.escrow?.content.name ?? short(o.entry.escrow)}</strong>
                <span className="badge">{o.entry.region}</span>
                {isDemo && <span className="badge ok">{u.demoEscrow}</span>}
                <span className="muted small">
                  {' '}{u.provenance}coordinator <Mono>{short(o.entry.provenance.coordinator)}</Mono> → operator <Mono>{short(o.entry.provenance.operator)}</Mono>{u.listVersion(o.entry.provenance.listVersion)}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <h3>{u.addressTitle}</h3>
      <div className="grid2">
        <Field label={u.name}><input data-testid="address-name" value={address.name} onChange={(e) => setAddress({ ...address, name: e.target.value })} /></Field>
        <Field label={u.postalCode}><input data-testid="address-postal-code" value={address.postal_code} onChange={(e) => setAddress({ ...address, postal_code: e.target.value })} /></Field>
        <Field label={u.address}><input data-testid="address-address" value={address.address} onChange={(e) => setAddress({ ...address, address: e.target.value })} /></Field>
        <Field label={u.phone}><input data-testid="address-phone" value={address.phone} onChange={(e) => setAddress({ ...address, phone: e.target.value })} /></Field>
      </div>
      <ActionButton testid="order-submit" onClick={submit}>{u.submit}</ActionButton>
    </Section>
  );
}
