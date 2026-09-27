import type { OperatorListContent } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { formatTime, short } from '../../lib/format';
import { useApp, useApplyPrefill, useDemoState, useLive, usePrefill, useRuntime } from '../../state';
import { BondSection } from './BondSection';

export function OperatorPanel() {
  const app = useApp();
  const { snapshots } = useDemoState();
  const delegated = snapshots.coordinator?.delegations.find((d) => d.operator === app.ids.operator.pubkey);
  return (
    <div data-testid="panel-operator">
      <IdentityCard role="operator" title="operator の鍵">
        <p className={`banner ${delegated && !delegated.revoked ? 'ok' : 'warn'}`} data-testid="operator-delegated" data-delegated={delegated && !delegated.revoked ? 'true' : 'false'}>
          {delegated && !delegated.revoked
            ? `coordinator から委任されています（委任書 v${delegated.version}）。この operator の一覧は、coordinator を信頼する全員に有効です。`
            : 'まだ coordinator から委任されていません。委任されるまで、一覧を公開しても誰も使いません。'}
        </p>
      </IdentityCard>
      <ListEditor />
      <Reports />
      {app.deployments?.bond && <BondSection />}
    </div>
  );
}

function ListEditor() {
  const app = useApp();
  const rt = useRuntime('operator');
  const wantsDemo = !!usePrefill('operator-publish')?.demo;
  const [draft, setDraft] = useState<OperatorListContent>();
  // While the demo's combinations load, publishing would sign the old draft: the button waits.
  const [loading, setLoading] = useState(true);
  const [published, setPublished] = useState<{ version: number } | undefined>();
  const [list, reload] = useLive(() => rt.currentList(), (cb) => rt.client.on('list', cb), [rt]);
  const loadDemo = async () => {
    setLoading(true);
    try {
      setDraft(await rt.demoContent(app.shopper.pubkey, app.ids.escrow.pubkey));
    } finally {
      setLoading(false);
    }
  };
  // Start from the published list; with none yet (or when the guide's publish step asks), from the demo's combinations.
  useEffect(() => {
    void (async () => {
      const l = await rt.currentList().catch(() => undefined);
      if (l && !wantsDemo) {
        setDraft(l.content);
        setLoading(false);
      } else await loadDemo();
    })();
  }, [rt, wantsDemo]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section title="組み合わせの一覧（kind 30501）" testid="operator-list">
      <Explain>
        一覧には「地域 × shopper × escrow」の組み合わせを載せます。利用者は、信頼する coordinator が委任した operator の一覧に載った組み合わせだけを候補にし、
        shopper ノードも一覧に無い組み合わせの注文を断ります。公開するたびに版（v）が上がり、新しい版が古い版を置き換えます。
      </Explain>
      <p className="muted" data-testid="operator-version" data-version={list?.version ?? 0}>
        公開済みの版: {list ? `v${list.version}（${list.content.entries.length} 件）` : 'まだありません'}
      </p>
      {draft && (
        <>
          <p>地域: {draft.regions.join(', ') || '-'} ・ リレー: {draft.relays.map((r) => r.url).join(', ')}</p>
          <p className="muted small">
            チェーン: BTC {draft.chain?.btc?.network ?? '-'} ・ EVM chain {draft.chain?.evm?.chain_id ?? '-'}（USDC <Mono>{short(draft.chain?.evm?.usdc)}</Mono>、
            Safe モジュール <Mono>{short(draft.chain?.evm?.safe.module)}</Mono>、setup <Mono>{short(draft.chain?.evm?.safe.setup)}</Mono>）
          </p>
          <table data-testid="operator-entries">
            <thead><tr><th>地域</th><th>shopper</th><th>escrow</th><th>支払い</th><th /></tr></thead>
            <tbody>
              {draft.entries.map((e, i) => (
                <tr key={`${e.region}${e.shopper}${e.escrow}`} data-testid="operator-entry" data-escrow={e.escrow}>
                  <td>{e.region}</td>
                  <td>{e.shopper === app.shopper.pubkey ? app.shopper.name : <Mono>{short(e.shopper)}</Mono>}</td>
                  <td>{e.escrow === app.ids.escrow.pubkey ? 'このデモの escrow' : <Mono>{short(e.escrow)}</Mono>}</td>
                  <td>{e.payments.join(', ')}</td>
                  <td>
                    <button type="button" className="plain small" data-testid={`operator-entry-remove-${i}`} onClick={() => setDraft({ ...draft, entries: draft.entries.filter((_, j) => j !== i) })}>
                      外す
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="row">
        <button type="button" className="plain" data-testid="operator-fill-demo" onClick={() => void loadDemo()}>デモの組み合わせを入れる</button>
        <ActionButton
          testid="operator-publish"
          disabled={!draft || loading}
          onClick={async () => {
            const l = await rt.publish(draft!);
            setPublished({ version: l.version });
            reload();
          }}
        >
          署名して公開（版を上げる）
        </ActionButton>
      </div>
      {published && <p className="muted" data-testid="operator-published">v{published.version} を公開しました</p>}
    </Section>
  );
}

function Reports() {
  const app = useApp();
  const rt = useRuntime('operator');
  const [reports] = useLive(() => rt.client.reports(), (cb) => rt.client.on('report', cb), [rt]);
  const [list, reload] = useLive(() => rt.currentList(), (cb) => rt.client.on('list', cb), [rt]);
  const [removed, setRemoved] = useState<number>();
  // The escrow to remove: the guide's, else the subject of the latest report.
  const [target, setTarget] = useState<string>();
  useApplyPrefill('operator-remove-escrow', (p) => typeof p.escrow === 'string' && setTarget(p.escrow));
  const subject = target ?? reports?.[0]?.report.subject;
  const listed = !!subject && !!list?.content.entries.some((e) => e.escrow === subject);
  return (
    <Section title="通報" testid="operator-reports">
      <Explain>利用者などからの通報が届きます。証拠は当事者の署名付きメッセージなので、operator は誰が何をしたかを自分で確かめられます。</Explain>
      {!reports?.length && <p className="muted" data-testid="operator-reports-empty">通報はありません。</p>}
      <table>
        <tbody>
          {reports?.map((r) => (
            <tr key={r.id} data-testid="operator-report" data-subject={r.report.subject} data-order-id={r.report.order_id}>
              <td>{formatTime(r.at)}</td>
              <td>対象 {r.report.subject === app.ids.escrow.pubkey ? 'このデモの escrow' : <Mono>{short(r.report.subject)}</Mono>}</td>
              <td>注文 {r.report.order_id?.slice(0, 8)}</td>
              <td>{r.report.text}</td>
              <td>証拠 {r.validEvidence}/{r.report.evidence?.length ?? 0} 件が署名 OK</td>
            </tr>
          ))}
        </tbody>
      </table>
      {subject && (
        <div className="row">
          <ActionButton
            testid="operator-remove-escrow"
            kind="danger"
            disabled={!listed}
            onClick={async () => {
              const l = await rt.removeEscrow(subject);
              setRemoved(l.version);
              reload();
            }}
          >
            {subject === app.ids.escrow.pubkey ? 'このデモの escrow' : short(subject)} を一覧から外す（新しい版を公開）
          </ActionButton>
          {!listed && <span className="muted">（いまの一覧には載っていません）</span>}
        </div>
      )}
      {removed && <p className="muted" data-testid="operator-removed">v{removed} を公開しました（escrow の組み合わせを外しました）</p>}
    </Section>
  );
}
