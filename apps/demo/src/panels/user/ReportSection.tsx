import type { UserOrder } from '@proxy-shopping/core/browser';
import { useState } from 'react';
import { ActionButton, Explain, Section } from '../../components/ui';
import { useApplyPrefill, useRuntime } from '../../state';

export function ReportSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const [subject, setSubject] = useState<'shopper' | 'escrow'>('escrow');
  const [text, setText] = useState('');
  useApplyPrefill('report-send', (p) => {
    if (p.subject === 'shopper' || p.subject === 'escrow') setSubject(p.subject);
    if (typeof p.text === 'string') setText(p.text);
  });
  const sent = o.timeline.some((t) => t.kind === 'report');
  return (
    <Section title="operator への通報" testid="report">
      <Explain>不正な shopper や escrow は、一覧を作っている operator に通報できます。この注文の署名付きメッセージがそのまま証拠として付きます。</Explain>
      <div className="row">
        <select data-testid="report-subject" value={subject} onChange={(e) => setSubject(e.target.value as 'shopper' | 'escrow')}>
          <option value="escrow">escrow</option>
          <option value="shopper">shopper</option>
        </select>
        <input data-testid="report-text" placeholder="何が起きたか" value={text} onChange={(e) => setText(e.target.value)} />
        <ActionButton testid="report-send" kind="plain" disabled={!text.trim()} onClick={() => rt.client.report(o.id, { subject, text })}>通報する</ActionButton>
      </div>
      {sent && <p className="muted" data-testid="report-sent">通報しました（署名付きのメッセージを証拠として添付）。</p>}
    </Section>
  );
}
