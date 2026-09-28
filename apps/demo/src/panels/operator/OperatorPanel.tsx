import type { OperatorListContent } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { useT } from '../../i18n';
import { formatTime, short } from '../../lib/format';
import { useApp, useApplyPrefill, useDemoState, useLive, usePrefill, useRuntime } from '../../state';
import { BondSection } from './BondSection';

export function OperatorPanel() {
  const app = useApp();
  const o = useT().operator;
  const { snapshots } = useDemoState();
  const delegated = snapshots.coordinator?.delegations.find((d) => d.operator === app.ids.operator.pubkey);
  return (
    <div data-testid="panel-operator">
      <IdentityCard role="operator" title={o.identity}>
        <p className={`banner ${delegated && !delegated.revoked ? 'ok' : 'warn'}`} data-testid="operator-delegated" data-delegated={delegated && !delegated.revoked ? 'true' : 'false'}>
          {delegated && !delegated.revoked
            ? o.delegated(delegated.version)
            : o.notDelegated}
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
  const m = useT();
  const o = m.operator;
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
    <Section title={o.list} testid="operator-list">
      <Explain>{o.listExplain}</Explain>
      <p className="muted" data-testid="operator-version" data-version={list?.version ?? 0}>
        {o.version}{list ? o.versionValue(list.version, list.content.entries.length) : o.noVersion}
      </p>
      {draft && (
        <>
          <p>{o.regions}{draft.regions.join(', ') || '-'}{m.common.sep}{o.relays}{draft.relays.map((r) => r.url).join(', ')}</p>
          <p className="muted small">
            {o.chain}BTC {draft.chain?.btc?.network ?? '-'}{m.common.sep}{o.evmChain} {draft.chain?.evm?.chain_id ?? '-'}{o.usdc}<Mono>{short(draft.chain?.evm?.usdc)}</Mono>
            {o.safeModule}<Mono>{short(draft.chain?.evm?.safe.module)}</Mono>{o.setup}<Mono>{short(draft.chain?.evm?.safe.setup)}</Mono>{o.close}
          </p>
          <table data-testid="operator-entries">
            <thead><tr><th>{o.colRegion}</th><th>shopper</th><th>escrow</th><th>{o.colPayments}</th><th /></tr></thead>
            <tbody>
              {draft.entries.map((e, i) => (
                <tr key={`${e.region}${e.shopper}${e.escrow}`} data-testid="operator-entry" data-escrow={e.escrow}>
                  <td>{e.region}</td>
                  <td>{e.shopper === app.shopper.pubkey ? app.shopper.name : <Mono>{short(e.shopper)}</Mono>}</td>
                  <td>{e.escrow === app.ids.escrow.pubkey ? o.demoEscrow : <Mono>{short(e.escrow)}</Mono>}</td>
                  <td>{e.payments.join(', ')}</td>
                  <td>
                    <button type="button" className="plain small" data-testid={`operator-entry-remove-${i}`} onClick={() => setDraft({ ...draft, entries: draft.entries.filter((_, j) => j !== i) })}>
                      {o.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="row">
        <button type="button" className="plain" data-testid="operator-fill-demo" onClick={() => void loadDemo()}>{o.fillDemo}</button>
        <ActionButton
          testid="operator-publish"
          disabled={!draft || loading}
          onClick={async () => {
            const l = await rt.publish(draft!);
            setPublished({ version: l.version });
            reload();
          }}
        >
          {o.publish}
        </ActionButton>
      </div>
      {published && <p className="muted" data-testid="operator-published">{o.published(published.version)}</p>}
    </Section>
  );
}

function Reports() {
  const app = useApp();
  const o = useT().operator;
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
    <Section title={o.reports} testid="operator-reports">
      <Explain>{o.reportsExplain}</Explain>
      {!reports?.length && <p className="muted" data-testid="operator-reports-empty">{o.noReports}</p>}
      <table>
        <tbody>
          {reports?.map((r) => (
            <tr key={r.id} data-testid="operator-report" data-subject={r.report.subject} data-order-id={r.report.order_id}>
              <td>{formatTime(r.at)}</td>
              <td>{o.subject}{r.report.subject === app.ids.escrow.pubkey ? o.demoEscrow : <Mono>{short(r.report.subject)}</Mono>}</td>
              <td>{o.order}{r.report.order_id?.slice(0, 8)}</td>
              {/* The reporter's own words. */}
              <td data-i18n-exempt="report text">{r.report.text}</td>
              <td>{o.evidenceOk(r.validEvidence, r.report.evidence?.length ?? 0)}</td>
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
            {o.removeEscrow(subject === app.ids.escrow.pubkey ? o.demoEscrow : short(subject))}
          </ActionButton>
          {!listed && <span className="muted">{o.notListed}</span>}
        </div>
      )}
      {removed && <p className="muted" data-testid="operator-removed">{o.removed(removed)}</p>}
    </Section>
  );
}
