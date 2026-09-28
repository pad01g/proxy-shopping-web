import type { UserOrder } from '@proxy-shopping/core/browser';
import { useState } from 'react';
import { ActionButton, Explain, Section } from '../../components/ui';
import { useT } from '../../i18n';
import { useApplyPrefill, useRuntime } from '../../state';

export function ReportSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const u = useT().user;
  const [subject, setSubject] = useState<'shopper' | 'escrow'>('escrow');
  const [text, setText] = useState('');
  useApplyPrefill('report-send', (p) => {
    if (p.subject === 'shopper' || p.subject === 'escrow') setSubject(p.subject);
    if (typeof p.text === 'string') setText(p.text);
  });
  const sent = o.timeline.some((t) => t.kind === 'report');
  return (
    <Section title={u.report} testid="report">
      <Explain>{u.reportExplain}</Explain>
      <div className="row">
        <select data-testid="report-subject" value={subject} onChange={(e) => setSubject(e.target.value as 'shopper' | 'escrow')}>
          <option value="escrow">escrow</option>
          <option value="shopper">shopper</option>
        </select>
        <input data-testid="report-text" placeholder={u.reportPlaceholder} value={text} onChange={(e) => setText(e.target.value)} />
        <ActionButton testid="report-send" kind="plain" disabled={!text.trim()} onClick={() => rt.client.report(o.id, { subject, text })}>{u.reportSend}</ActionButton>
      </div>
      {sent && <p className="muted" data-testid="report-sent">{u.reportSent}</p>}
    </Section>
  );
}
