import type { ListEntry, OperatorListContent, Payment } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ActionButton, Field, Mono, Section, StringList } from '../components/ui';
import { formatTime, short } from '../lib/format';
import { useLive, useRuntime } from '../state';

const EMPTY_ENTRY: ListEntry = { region: '', shopper: '', escrow: '', shops: ['*'], payments: ['btc-signet', 'usdc-evm'], tags: [], escrow_sla_days: 14 };

export function OperatorPage() {
  const rt = useRuntime();
  const [content, setContent] = useState<OperatorListContent>();
  const [version, setVersion] = useState<number>();
  const [entry, setEntry] = useState<ListEntry>(EMPTY_ENTRY);
  const [published, setPublished] = useState<string>();
  const [reports] = useLive(() => rt.operator.reports(), (cb) => rt.operator.on('report', cb), [rt]);

  useEffect(() => {
    void (async () => {
      const cur = await rt.operator.currentList();
      if (cur) {
        setContent(cur.content);
        setVersion(cur.version);
        return;
      }
      const d = rt.deployments;
      const draft = await rt.operator.draft('operator');
      setContent({
        ...draft,
        chain: {
          btc: { network: 'signet', esplora: rt.config.esplora ? [rt.config.esplora] : [] },
          ...(d ? { evm: { chain_id: d.chain_id, rpc: rt.config.evm_rpc ? [rt.config.evm_rpc] : [], usdc: d.usdc, safe: { ...d.safe, module: d.module, setup: d.setup } } } : {}),
        },
      });
    })();
  }, [rt]);

  if (!content) return <p className="muted">読み込み中…</p>;
  const set = (patch: Partial<OperatorListContent>) => setContent({ ...content, ...patch });
  const togglePayment = (p: Payment) =>
    setEntry({ ...entry, payments: entry.payments.includes(p) ? entry.payments.filter((x) => x !== p) : [...entry.payments, p] });

  return (
    <div data-testid="operator">
      <h1>オペレータの一覧（kind 30501）</h1>
      <p className="muted" data-testid="operator-version" data-version={version ?? 0}>
        公開済みの版: {version ? `v${version}` : 'まだありません'} ・ network {rt.config.network}
      </p>
      <Section title="基本">
        <div className="grid2">
          <Field label="名前"><input data-testid="operator-name" value={content.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="通報の受け手（公開鍵）"><input data-testid="operator-report-to" value={content.report_to ?? ''} onChange={(e) => set({ report_to: e.target.value })} /></Field>
        </div>
        <Field label="地域">
          <StringList testid="operator-regions" values={content.regions} placeholder="JP-13" onChange={(regions) => set({ regions })} />
        </Field>
        <Field label="リレー">
          <StringList testid="operator-relays" values={content.relays.map((r) => r.url)} placeholder="wss://…" onChange={(urls) => set({ relays: urls.map((url) => ({ url, retention_days: content.relays.find((r) => r.url === url)?.retention_days ?? 30 })) })} />
        </Field>
      </Section>
      <Section title="チェーン（推奨の接続先）">
        <Field label="JSON">
          <textarea
            data-testid="operator-chain"
            defaultValue={JSON.stringify(content.chain ?? {}, null, 2)}
            onBlur={(e) => {
              try {
                set({ chain: JSON.parse(e.target.value) as OperatorListContent['chain'] });
              } catch {
                /* keep previous value until the JSON is valid */
              }
            }}
          />
        </Field>
      </Section>
      <Section title="組み合わせ" testid="operator-entries">
        <table>
          <thead><tr><th>地域</th><th>shopper</th><th>escrow</th><th>店</th><th>支払い</th><th>SLA</th><th /></tr></thead>
          <tbody>
            {content.entries.map((e, i) => (
              <tr key={`${e.region}${e.shopper}${e.escrow}`} data-testid="operator-entry">
                <td>{e.region}</td>
                <td><Mono>{short(e.shopper)}</Mono></td>
                <td><Mono>{short(e.escrow)}</Mono></td>
                <td>{e.shops.join(',')}</td>
                <td>{e.payments.join(',')}</td>
                <td>{e.escrow_sla_days} 日</td>
                <td><button type="button" className="plain small" data-testid={`operator-entry-remove-${i}`} onClick={() => set({ entries: content.entries.filter((_, j) => j !== i) })}>外す</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid2">
          <Field label="地域"><input data-testid="operator-entry-region" value={entry.region} onChange={(e) => setEntry({ ...entry, region: e.target.value })} /></Field>
          <Field label="SLA（日）"><input data-testid="operator-entry-sla" type="number" value={entry.escrow_sla_days} onChange={(e) => setEntry({ ...entry, escrow_sla_days: Number(e.target.value) })} /></Field>
          <Field label="shopper 公開鍵"><input data-testid="operator-entry-shopper" value={entry.shopper} onChange={(e) => setEntry({ ...entry, shopper: e.target.value.trim() })} /></Field>
          <Field label="escrow 公開鍵"><input data-testid="operator-entry-escrow" value={entry.escrow} onChange={(e) => setEntry({ ...entry, escrow: e.target.value.trim() })} /></Field>
          <Field label="店（カンマ区切り, * はすべて）"><input data-testid="operator-entry-shops" value={entry.shops.join(',')} onChange={(e) => setEntry({ ...entry, shops: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
          <div className="row">
            {(['btc-signet', 'usdc-evm'] as Payment[]).map((p) => (
              <label key={p} className="row"><input type="checkbox" style={{ width: 'auto' }} data-testid={`operator-entry-payment-${p}`} checked={entry.payments.includes(p)} onChange={() => togglePayment(p)} />{p}</label>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="plain"
          data-testid="operator-entry-add"
          disabled={!entry.region || !/^[0-9a-f]{64}$/.test(entry.shopper) || !/^[0-9a-f]{64}$/.test(entry.escrow)}
          onClick={() => {
            set({ entries: [...content.entries, entry] });
            setEntry(EMPTY_ENTRY);
          }}
        >
          組み合わせを追加
        </button>
      </Section>
      <Section title="寄付（任意）">
        <div className="grid2">
          <Field label="BTC アドレス"><input data-testid="operator-donation-btc" value={content.donation?.btc_address ?? ''} onChange={(e) => set({ donation: { bps: 0, ...content.donation, btc_address: e.target.value } })} /></Field>
          <Field label="EVM アドレス"><input data-testid="operator-donation-evm" value={content.donation?.evm_address ?? ''} onChange={(e) => set({ donation: { bps: 0, ...content.donation, evm_address: e.target.value } })} /></Field>
          <Field label="bps"><input data-testid="operator-donation-bps" type="number" value={content.donation?.bps ?? 0} onChange={(e) => set({ donation: { ...content.donation, bps: Number(e.target.value) } })} /></Field>
        </div>
      </Section>
      <ActionButton
        testid="operator-publish"
        onClick={async () => {
          const l = await rt.operator.publish(content);
          setVersion(l.version);
          setPublished(`v${l.version} を公開しました`);
          void rt.session.directory.refresh();
        }}
      >
        署名して公開（版を上げる）
      </ActionButton>
      {published && <p className="muted" data-testid="operator-published">{published}</p>}

      <Section title="通報" testid="operator-reports">
        {!reports?.length && <p className="muted">通報はありません。</p>}
        <table>
          <tbody>
            {reports?.map((r) => (
              <tr key={r.id} data-testid="operator-report">
                <td>{formatTime(r.at)}</td>
                <td>from <Mono>{short(r.from)}</Mono></td>
                <td>対象 <Mono>{short(r.report.subject)}</Mono></td>
                <td>注文 {r.report.order_id?.slice(0, 8)}</td>
                <td>{r.report.text}</td>
                <td>証拠 {r.validEvidence}/{r.report.evidence?.length ?? 0} 件が署名 OK</td>
                <td>
                  <button type="button" className="plain small" data-testid="operator-report-remove-subject" onClick={() => set({ entries: content.entries.filter((e) => e.shopper !== r.report.subject && e.escrow !== r.report.subject) })}>
                    一覧から外す（未公開）
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
