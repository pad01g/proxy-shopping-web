import type { UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { formatAsset, formatTime, REJECT_LABEL } from '../../lib/format';
import { useRuntime } from '../../state';
import { useChainNow } from './chain';

/** A timelock as block height (BTC) or chain time (USDC), with how far away it is on the chain's clock. */
export function Timelock({ o, value, now, testid }: { o: UserOrder; value: number; now?: number; testid: string }) {
  const btc = o.payment === 'btc-signet';
  const left = now === undefined ? undefined : Math.max(0, value - now);
  return (
    <span data-testid={testid} data-value={value}>
      {btc ? `高さ ${value}` : formatTime(value)}
      {left !== undefined && (left === 0 ? '（経過済み）' : btc ? `（あと ${left} ブロック）` : `（チェーンの時刻であと ${left} 秒）`)}
    </span>
  );
}

export function QuoteSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const now = useChainNow(rt, o.payment);
  const q = o.quote;
  if (!q) {
    return (
      <Section title="見積" testid="quote">
        <p className="muted" data-testid="quote-waiting">shopper の見積を待っています…（依頼は届くまで 5 秒ごとに送り直します）</p>
        {o.status === 'requested' && (
          <div className="row">
            <ActionButton testid="request-resend" kind="plain" onClick={() => rt.client.resendRequest(o.id)}>依頼を送り直す</ActionButton>
            <ActionButton testid="request-cancel" kind="plain" onClick={() => rt.client.cancel(o.id)}>取り消す</ActionButton>
          </div>
        )}
      </Section>
    );
  }
  if (!q.accept) {
    return (
      <Section title="見積" testid="quote">
        <p className="banner error" data-testid="quote-rejected" data-reason={q.reject_reason ?? ''}>
          断られました: {q.reject_reason}（{REJECT_LABEL[q.reject_reason ?? ''] ?? '理由不明'}）{q.detail && ` — ${q.detail}`}
        </p>
        <Explain>shopper は見積を出す前に、店の危険度（許可リスト・証明書・決済画面）・地域・支払い手段を自分の方針で判定します。断られた注文では、お金は一切動きません。</Explain>
      </Section>
    );
  }
  const check = o.quoteCheck;
  const ack = check?.ackRequired ?? [];
  return (
    <Section title="見積" testid="quote">
      <Explain>
        アプリは見積を自分で検証します: レートを自分の取得元で計算し直し（3% 超で注意、10% 超で明示の確認が必要）、
        多重署名のアドレスを自分の鍵・shopper の鍵・escrow の鍵から計算し直して一致を確かめ、T1 / T2 が方針の範囲かを見ます。
      </Explain>
      <table>
        <tbody>
          <tr><th>商品 + 送料 + shopper 手数料</th><td>{q.price?.items.amount} + {q.price?.shipping.amount} + {q.price?.shopper_fee.amount} {q.price?.items.currency}</td></tr>
          <tr><th>レート</th><td data-testid="quote-rate">{q.fx?.pair} = {q.fx?.rate}{check?.fx && `（自分の取得元との差 ${(check.fx.deviation * 100).toFixed(2)}%）`}</td></tr>
          <tr><th>預ける額</th><td data-testid="quote-lock-amount">{formatAsset(q.lock_amount, q.asset)}（払い出し手数料の予備 {formatAsset(q.payout_fee_reserve, q.asset)} を含む）</td></tr>
          <tr><th>escrow 前払い手数料</th><td>{formatAsset(q.escrow_upfront_fee, q.asset)}</td></tr>
          {q.timelock && (
            <>
              <tr><th>T1（shopper が単独で受け取れる）</th><td><Timelock o={o} value={q.timelock.t1} now={now} testid="quote-timelock-t1" /></td></tr>
              <tr><th>T2（利用者が単独で取り戻せる）</th><td><Timelock o={o} value={q.timelock.t2} now={now} testid="quote-timelock-t2" /></td></tr>
            </>
          )}
          <tr><th>{o.payment === 'btc-signet' ? 'マルチシグ（P2WSH）' : 'Safe'}</th><td><Mono testid="quote-escrow-address">{q.escrow_address}</Mono></td></tr>
        </tbody>
      </table>
      {check && !check.ok && (
        <div className="banner error" data-testid="quote-check-errors">この見積は検証に失敗しました:<ul>{check.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}
      {!!check?.warnings.length && <div className="banner warn" data-testid="quote-check-warnings"><ul>{check.warnings.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {check?.ok && <p className="banner ok" data-testid="quote-check-ok">検証 OK: アドレスを計算し直して一致を確かめました。組み合わせは実効の一覧にあります。</p>}
      {o.status === 'quoted' && (
        <div className="row">
          <ActionButton
            testid="quote-accept"
            disabled={!check?.ok}
            confirm={ack.length ? {
              title: 'レートが大きくずれた見積を承諾します',
              warning: ack.join(' / '),
              details: <p className="muted">レートを自分で確かめ、この見積で承諾することを了解した場合だけ進めてください。</p>,
              okLabel: '確認して承諾する',
            } : undefined}
            onClick={() => rt.client.acceptQuote(o.id, { acknowledgeRateDeviation: ack.length > 0 })}
          >
            見積を承諾する
          </ActionButton>
          <ActionButton testid="quote-recheck" kind="plain" onClick={() => rt.client.recheckQuote(o.id)}>検証し直す</ActionButton>
          <ActionButton testid="quote-cancel" kind="plain" onClick={() => rt.client.cancel(o.id)}>取り消す</ActionButton>
        </div>
      )}
    </Section>
  );
}
