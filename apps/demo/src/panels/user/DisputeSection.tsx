import { provisionalFunding, type DisputeOpen, type UserOrder } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ActionButton, Explain, Field, Mono, Section } from '../../components/ui';
import { formatAsset } from '../../lib/format';
import { useApplyPrefill, useRuntime } from '../../state';

const CLAIMS: Array<[DisputeOpen['claim'], string]> = [
  ['not_delivered', '届かない'],
  ['wrong_item', '違う商品'],
  ['not_released', '支払われない'],
  ['other', 'その他'],
];

export function DisputeSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const [claim, setClaim] = useState<DisputeOpen['claim']>('not_delivered');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>();
  useApplyPrefill('dispute-open', (p) => {
    if (typeof p.claim === 'string') setClaim(p.claim as DisputeOpen['claim']);
    if (typeof p.text === 'string') setText(p.text);
  });
  const reviewable = !!o.ruling && !o.escrowSpent;
  useEffect(() => {
    if (reviewable) void rt.client.reviewRuling(o.id).then(setProblems);
  }, [reviewable, o.updatedAt, o.id, rt]);

  if (!provisionalFunding(o)) return null;
  const canOpen = !o.escrowSpent && !o.dispute;
  if (!canOpen && !o.dispute && !o.ruling && !o.pendingRuling) return null;
  const r = o.ruling;
  const payTo = o.payment === 'btc-signet' ? o.request.user_btc_address : o.request.user_evm_address;
  return (
    <Section title="紛争" testid="dispute">
      {canOpen && (
        <>
          <Explain>
            届かない・違う商品などのときは、escrow に紛争を申し立てます。この注文の署名付きメッセージ・配送状況と、届け先を開く鍵（key_for_escrow）を証拠として渡します。
            escrow は証拠を見て配分を決め、その取引に署名して送ってきます。
          </Explain>
          <div className="grid2">
            <Field label="申立の種類">
              <select data-testid="dispute-claim" value={claim} onChange={(e) => setClaim(e.target.value as DisputeOpen['claim'])}>
                {CLAIMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="説明">
              <input data-testid="dispute-text" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </div>
          <ActionButton testid="dispute-open" kind="danger" onClick={() => rt.client.openDispute(o.id, { claim, text })}>紛争を申し立てる</ActionButton>
        </>
      )}
      {o.dispute && <p data-testid="dispute-opened">申立済み（{o.dispute.open.claim}）: {o.dispute.open.text}</p>}
      {o.pendingRuling && !r && (
        <p className="banner warn" data-testid="ruling-pending">escrow から裁定が届きましたが、紛争が開かれたことをまだ確かめられません。</p>
      )}
      {r && (
        <div data-testid="ruling" data-split-user={r.split.user} data-split-shopper={r.split.shopper} data-fee={r.split.escrow_fee}>
          <p>
            裁定: 利用者へ <strong>{formatAsset(r.split.user, o.payment)}</strong> ・ shopper へ <strong>{formatAsset(r.split.shopper, o.payment)}</strong> ・ escrow 手数料 {formatAsset(r.split.escrow_fee, o.payment)}
          </p>
          <p className="muted">理由: {r.reason}</p>
          {problems && problems.length > 0 && (
            <div className="banner error" data-testid="ruling-problems">この裁定には連署できません:<ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
          )}
          {reviewable && o.pendingSettlement?.from !== rt.pubkey && (
            <>
              <Explain>アプリは裁定の取引を確かめました（入力は入金の出力だけ、出力は配分どおり、escrow の手数料は 2% 以内）。連署すると 2-of-3 の署名がそろい、放送されます。</Explain>
              <ActionButton
                testid="ruling-countersign"
                disabled={!problems || problems.length > 0}
                confirm={{
                  title: '裁定に連署して放送します',
                  amount: formatAsset(r.split.user, o.payment),
                  recipient: payTo,
                  details: <p className="muted">shopper へ {formatAsset(r.split.shopper, o.payment)}、escrow へ {formatAsset(r.split.escrow_fee, o.payment)}</p>,
                  okLabel: '連署する',
                }}
                onClick={() => rt.client.countersignRuling(o.id)}
              >
                この裁定に連署して放送する
              </ActionButton>
            </>
          )}
          {o.settledTxid && <p className="banner ok" data-testid="ruling-settled">精算されました（チェーンで確認済み）: <Mono testid="ruling-settled-txid">{o.settledTxid}</Mono></p>}
        </div>
      )}
    </Section>
  );
}
