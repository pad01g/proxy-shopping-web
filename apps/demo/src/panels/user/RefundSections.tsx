import type { UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { formatAsset, formatTime } from '../../lib/format';
import { useRuntime } from '../../state';
import { useChainNow } from './chain';
import { Timelock } from './QuoteSection';

/** The shopper's cooperative refund: shown for review, signed only after the user confirms (§4.10). */
export function RefundOfferSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const offer = o.refundOffer!;
  return (
    <Section title="shopper からの払い戻しの提案" testid="refund-offer">
      <Explain>shopper は買えなかったので、全額を利用者に返す取引に署名して送ってきました（協力的な払い戻し）。アプリが決まった形の取引かを確かめてあります。</Explain>
      <p>{formatAsset(offer.amount, o.payment)} を <Mono>{offer.recipient}</Mono> へ（{formatTime(offer.receivedAt)} 受信）</p>
      {offer.problems.length > 0 ? (
        <div className="banner error" data-testid="refund-offer-problems">決まった形の取引ではないので連署できません:<ul>{offer.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
      ) : (
        <ActionButton
          testid="refund-offer-accept"
          confirm={{ title: '払い戻しに連署して放送します', amount: formatAsset(offer.amount, o.payment), recipient: offer.recipient, okLabel: '連署する' }}
          onClick={() => rt.client.acceptRefundOffer(o.id)}
        >
          払い戻しを受ける（連署）
        </ActionButton>
      )}
    </Section>
  );
}

/** After T2 the user alone can take everything back (§5.1 T2 path, §6.3 refundToUser). */
export function TimelockRefundSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const now = useChainNow(rt, o.payment);
  const q = o.quote;
  const t2 = q?.timelock?.t2;
  if (!q || !t2) return null;
  if (o.status === 'refunded') {
    return (
      <Section title="返金" testid="refund">
        <p className="banner ok" data-testid="order-refunded">返金されました（チェーンで確認済み）: <Mono testid="order-refund-txid">{o.refundTxid}</Mono></p>
      </Section>
    );
  }
  if (o.escrowSpent) return null;
  const reached = now !== undefined && now >= t2;
  const isBtc = o.payment === 'btc-signet';
  const reserve = BigInt(q.payout_fee_reserve ?? '0');
  const amount = isBtc ? BigInt(q.lock_amount ?? '0') - (reserve > 0n ? reserve : 500n) : BigInt(q.lock_amount ?? '0');
  return (
    <Section title="タイムロックによる返金（T2）" testid="refund">
      <Explain>
        shopper も escrow も応答しなくなっても、T2 を過ぎれば利用者は自分の鍵だけで全額を取り戻せます（{isBtc ? 'witness script の T2 の経路' : 'Safe のモジュールの refundToUser'}）。
      </Explain>
      <p className="muted" data-testid="refund-status" data-reached={reached ? 'true' : 'false'}>
        T2 = <Timelock o={o} value={t2} now={now} testid="refund-t2" />
      </p>
      <ActionButton
        testid="order-refund"
        kind="plain"
        disabled={!reached}
        confirm={{ title: 'T2 後の返金を受けます', amount: formatAsset(amount, o.payment), recipient: isBtc ? o.request.user_btc_address : o.request.user_evm_address, okLabel: '返金を受ける' }}
        onClick={() => rt.client.refundAfterTimelock(o.id)}
      >
        T2 後の返金を受ける
      </ActionButton>
    </Section>
  );
}
