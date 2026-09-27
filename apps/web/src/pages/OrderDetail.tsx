import type { DisputeOpen, UserOrder } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ActionButton, Copyable, Field, Mono, Section } from '../components/ui';
import { faucet } from '../lib/faucet';
import { formatAsset, formatTime, PAYMENT_LABEL, short, STATUS_LABEL } from '../lib/format';
import { useLive, useRuntime } from '../state';

const FUNDABLE = ['accepted', 'funding'];
const RELEASABLE = ['funded', 'purchased', 'shipped', 'delivered', 'delivery_failed'];
const DISPUTABLE = ['funded', 'purchased', 'shipped', 'delivered', 'delivery_failed', 'released'];

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const rt = useRuntime();
  const [order] = useLive(() => rt.user.getOrder(id), (cb) => rt.user.on('order', (o) => o.id === id && cb()), [rt, id]);
  if (!order) return <p className="muted" data-testid="order-not-found">注文を読み込み中…</p>;
  const o = order;
  return (
    <div data-testid="order-detail" data-order-id={o.id}>
      <h1>
        注文 <Mono testid="order-id">{o.id}</Mono>
      </h1>
      <p>
        状態: <span className="badge" data-testid="order-status" data-status={o.status}>{STATUS_LABEL[o.status] ?? o.status}</span>
      </p>
      {o.lastError && <p className="banner error" data-testid="order-last-error">{o.lastError}</p>}

      <Section title="注文の内容">
        <p>{o.request.shop_url}（{o.request.shop_region}）・ {PAYMENT_LABEL[o.payment]}</p>
        <ul>{o.request.items.map((i) => <li key={i.sku}>{i.sku} × {i.qty}</li>)}</ul>
        <p className="muted">
          shopper {o.shopperProfile?.name ?? short(o.shopper)} ・ escrow {o.escrowProfile?.name ?? short(o.escrow)} ・ operator {short(o.entry.provenance.operator)}（v{o.entry.provenance.listVersion}）
        </p>
      </Section>

      <QuotePanel o={o} />
      {FUNDABLE.includes(o.status) && <FundPanel o={o} />}
      <ProgressPanel o={o} />
      <DisputePanel o={o} />
      {o.funded && <RefundPanel o={o} />}
      <ReportPanel o={o} />

      <Section title="経過" testid="order-timeline">
        <ul className="timeline">
          {[...o.timeline].reverse().map((t, i) => (
            <li key={i} data-testid="order-timeline-item" data-kind={t.kind}>
              <time>{formatTime(t.at)}</time>
              {t.text}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function QuotePanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const q = o.quote;
  if (!q) return <Section title="見積"><p className="muted" data-testid="quote-waiting">shopper の見積を待っています…</p></Section>;
  if (!q.accept) {
    return (
      <Section title="見積">
        <p className="banner error" data-testid="quote-rejected">断られました: {q.reject_reason} {q.detail}</p>
      </Section>
    );
  }
  const check = o.quoteCheck;
  const fx = check?.fx;
  return (
    <Section title="見積" testid="quote">
      <table>
        <tbody>
          <tr><th>商品</th><td>{q.price?.items.amount} {q.price?.items.currency}</td></tr>
          <tr><th>送料</th><td>{q.price?.shipping.amount} {q.price?.shipping.currency}</td></tr>
          <tr><th>shopper 手数料</th><td>{q.price?.shopper_fee.amount} {q.price?.shopper_fee.currency}</td></tr>
          <tr><th>レート</th><td data-testid="quote-rate">{q.fx?.pair} = {q.fx?.rate}{fx && `（自分の取得元 ${fx.own.toFixed(4)}）`}</td></tr>
          <tr><th>預ける額</th><td data-testid="quote-lock-amount">{formatAsset(q.lock_amount, q.asset)}</td></tr>
          <tr><th>escrow 前払い手数料</th><td>{formatAsset(q.escrow_upfront_fee, q.asset)}</td></tr>
          <tr><th>払い出し手数料の予備</th><td>{formatAsset(q.payout_fee_reserve, q.asset)}</td></tr>
          <tr><th>タイムロック</th><td>T1 {q.timelock?.t1} / T2 {q.timelock?.t2}{q.asset === 'btc-signet' ? '（ブロック高）' : '（UNIX 秒）'}</td></tr>
          <tr><th>多重署名のアドレス</th><td><Mono testid="quote-escrow-address">{q.escrow_address}</Mono></td></tr>
          <tr><th>有効期限</th><td>{q.expires_at ? formatTime(q.expires_at) : '-'}</td></tr>
        </tbody>
      </table>
      {fx && (
        <p className={`banner ${fx.level === 'ok' ? 'ok' : fx.level}`} data-testid="quote-fx-banner" data-level={fx.level}>
          {fx.level === 'ok' && `レートは自分の取得元と ${(fx.deviation * 100).toFixed(2)}% の差です。`}
          {fx.level === 'warn' && `注意: レートが自分の取得元と ${(fx.deviation * 100).toFixed(2)}% ずれています（3% 超）。`}
          {fx.level === 'strong' && `警告: レートが自分の取得元と ${(fx.deviation * 100).toFixed(2)}% も離れています（10% 超）。承諾しないことを勧めます。`}
        </p>
      )}
      {check && !check.ok && (
        <div className="banner error" data-testid="quote-check-errors">
          この見積は検証に失敗しました:
          <ul>{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {!!check?.warnings.length && (
        <div className="banner warn" data-testid="quote-check-warnings">
          <ul>{check.warnings.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {check?.ok && <p className="muted" data-testid="quote-check-ok">多重署名のアドレスを自分で計算し直し、一致を確かめました。組み合わせは実効の一覧にあります。</p>}
      {o.status === 'quoted' && (
        <div className="row">
          <ActionButton testid="quote-accept" disabled={!check?.ok} onClick={() => rt.user.acceptQuote(o.id)}>見積を承諾する</ActionButton>
          <ActionButton testid="quote-recheck" kind="plain" onClick={() => rt.user.recheckQuote(o.id)}>検証し直す</ActionButton>
          <ActionButton testid="order-cancel" kind="plain" onClick={() => rt.user.cancel(o.id)}>取り消す</ActionButton>
        </div>
      )}
    </Section>
  );
}

function FundPanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const [bal, refresh] = useLive(() => rt.user.balances(), (cb) => {
    const t = setInterval(cb, 4000);
    return () => clearInterval(t);
  }, [rt]);
  const q = o.quote!;
  const isBtc = o.payment === 'btc-signet';
  const need = BigInt(q.lock_amount ?? '0') + BigInt(q.escrow_upfront_fee ?? '0');
  const have = isBtc ? bal?.btcSats : bal?.usdc;
  // BTC also pays the network fee, which the wallet only knows when building the tx; this is the lower bound.
  const enough = have !== undefined && have >= need;
  const faucetUrl = rt.config.faucet_url;
  return (
    <Section title="入金" testid="fund">
      <p>
        必要な額: {formatAsset(need, o.payment)}（預け {formatAsset(q.lock_amount, o.payment)} + escrow 前払い {formatAsset(q.escrow_upfront_fee, o.payment)}{isBtc ? ' + 送金手数料' : ' + ガス代（ETH）'}）
      </p>
      <p data-testid="fund-balance" data-enough={String(enough)}>
        財布の残高: {have === undefined ? '…' : formatAsset(have, o.payment)}
        {!isBtc && bal?.eth !== undefined && ` ・ ETH ${(Number(bal.eth) / 1e18).toFixed(4)}`}
      </p>
      <p className="muted">
        入金元: <Mono>{isBtc ? rt.keys.btcWallet.address : rt.keys.evmAddress}</Mono>
      </p>
      <div className="row">
        {faucetUrl && (
          <ActionButton
            testid="order-faucet"
            kind="plain"
            onClick={async () => {
              if (isBtc) await faucet.btc(faucetUrl, rt.keys.btcWallet.address);
              else await faucet.evm(faucetUrl, rt.keys.evmAddress);
              refresh();
            }}
          >
            蛇口から受け取る（lab）
          </ActionButton>
        )}
        <ActionButton testid="order-fund" disabled={!enough} onClick={() => rt.user.fund(o.id)}>
          {isBtc ? '多重署名に入金する' : 'Safe を作って入金する'}
        </ActionButton>
      </div>
    </Section>
  );
}

function ProgressPanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  if (!o.funded) return null;
  return (
    <Section title="購入と配送" testid="progress">
      <p data-testid="order-funded-tx">
        入金: <Mono>{o.funded.asset === 'btc-signet' ? o.funded.txid : o.funded.safe}</Mono>
      </p>
      {o.purchased ? (
        <p data-testid="order-purchased">店の注文番号 {o.purchased.shop_order_id} ・ {o.purchased.total?.amount} {o.purchased.total?.currency} ・ 証拠 {o.purchased.evidence?.length ?? 0} 件</p>
      ) : (
        <p className="muted">購入を待っています…</p>
      )}
      <ul data-testid="order-tracking">
        {o.tracking.map((t, i) => (
          <li key={i}>{formatTime(t.updated_at)} {t.status} {t.carrier} {t.tracking_no}</li>
        ))}
      </ul>
      {RELEASABLE.includes(o.status) && (
        <div>
          <p className="muted">商品を受け取ったら、支払いに署名してください。shopper が連署して受け取ります。</p>
          <ActionButton testid="order-release" onClick={() => rt.user.release(o.id)}>受け取りました（支払う）</ActionButton>
        </div>
      )}
      {o.completedTxid && (
        <p className="banner ok" data-testid="order-completed">
          完了しました。支払いの取引: <Mono testid="order-completed-txid">{o.completedTxid}</Mono>
        </p>
      )}
    </Section>
  );
}

function DisputePanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const [claim, setClaim] = useState<DisputeOpen['claim']>('not_delivered');
  const [text, setText] = useState('');
  const [splitUser, setSplitUser] = useState('');
  const [splitShopper, setSplitShopper] = useState('');
  const [problems, setProblems] = useState<string[]>();
  useEffect(() => {
    if (o.ruling && o.status === 'ruled') void rt.user.reviewRuling(o.id).then(setProblems);
  }, [o.ruling, o.status, o.id, rt]);

  if (!o.funded) return null;
  const canOpen = DISPUTABLE.includes(o.status) && !o.dispute;
  if (!canOpen && !o.dispute && !o.ruling) return null;
  return (
    <Section title="紛争" testid="dispute">
      {canOpen && (
        <>
          <p className="muted">escrow に全ての証拠（署名付きメッセージ・配送状況・届け先の鍵）を渡して裁定を求めます。</p>
          <div className="grid2">
            <Field label="申立の種類">
              <select data-testid="dispute-claim" value={claim} onChange={(e) => setClaim(e.target.value as DisputeOpen['claim'])}>
                <option value="not_delivered">届かない</option>
                <option value="wrong_item">違う商品</option>
                <option value="not_released">支払われない</option>
                <option value="other">その他</option>
              </select>
            </Field>
            <Field label="希望する配分（user / shopper, 任意）">
              <div className="row">
                <input data-testid="dispute-split-user" placeholder="user" value={splitUser} onChange={(e) => setSplitUser(e.target.value)} />
                <input data-testid="dispute-split-shopper" placeholder="shopper" value={splitShopper} onChange={(e) => setSplitShopper(e.target.value)} />
              </div>
            </Field>
          </div>
          <Field label="説明">
            <textarea data-testid="dispute-text" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ActionButton
            testid="dispute-open"
            kind="danger"
            onClick={() => rt.user.openDispute(o.id, {
              claim, text, requestedSplit: splitUser && splitShopper ? { user: splitUser, shopper: splitShopper } : undefined,
            })}
          >
            紛争を申し立てる
          </ActionButton>
        </>
      )}
      {o.dispute && (
        <p data-testid="dispute-opened">
          申立済み（{o.dispute.open.claim}）。
          <ActionButton testid="dispute-send-evidence" kind="plain" onClick={() => rt.user.sendEvidence(o.id)}>証拠を送り直す</ActionButton>
        </p>
      )}
      {o.ruling && (
        <div data-testid="ruling">
          <p>
            裁定: user <strong>{formatAsset(o.ruling.split.user, o.payment)}</strong> / shopper {formatAsset(o.ruling.split.shopper, o.payment)} / escrow 手数料 {formatAsset(o.ruling.split.escrow_fee, o.payment)}
          </p>
          <p className="muted">理由: {o.ruling.reason}</p>
          {o.ruling.no_obligation && <p className="banner warn">escrow は前払い手数料を確認できず、裁定の義務を負わないと表明しています。</p>}
          {problems && problems.length > 0 && (
            <div className="banner error" data-testid="ruling-problems"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
          )}
          {o.status === 'ruled' && (
            <ActionButton testid="ruling-countersign" disabled={!!problems?.length} onClick={() => rt.user.countersignRuling(o.id)}>
              この裁定に連署して放送する
            </ActionButton>
          )}
          {o.settledTxid && <p className="banner ok" data-testid="ruling-settled">精算の取引: <Mono>{o.settledTxid}</Mono></p>}
        </div>
      )}
    </Section>
  );
}

function RefundPanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const t2 = o.quote?.timelock?.t2;
  const [now, setNow] = useState<number>();
  useEffect(() => {
    const load = async () => {
      if (o.payment === 'btc-signet') setNow(await rt.session.chain?.tipHeight());
      else setNow(rt.session.evm ? Number(await rt.session.evm.blockTimestamp()) : undefined);
    };
    void load().catch(() => undefined);
    const t = setInterval(() => void load().catch(() => undefined), 10_000);
    return () => clearInterval(t);
  }, [o.payment, rt]);
  if (!t2 || ['completed', 'settled', 'refunded'].includes(o.status)) return null;
  const reached = now !== undefined && now >= t2;
  return (
    <Section title="タイムロックによる返金" testid="refund">
      <p className="muted" data-testid="refund-status" data-reached={reached ? 'true' : 'false'}>
        T2 = {t2}{o.payment === 'btc-signet' ? '（ブロック高）' : `（${formatTime(t2)}）`}・ 現在 {now ?? '…'}。T2 を過ぎると、あなた一人で全額を取り戻せます。
      </p>
      <ActionButton testid="order-refund" kind="plain" disabled={!reached} onClick={() => rt.user.refundAfterTimelock(o.id)}>
        T2 後の返金を受ける
      </ActionButton>
    </Section>
  );
}

function ReportPanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const [subject, setSubject] = useState<'shopper' | 'escrow'>('shopper');
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <Section title="オペレータへの通報" testid="report">
      <div className="row">
        <select data-testid="report-subject" value={subject} onChange={(e) => setSubject(e.target.value as 'shopper' | 'escrow')}>
          <option value="shopper">shopper</option>
          <option value="escrow">escrow</option>
        </select>
        <input data-testid="report-text" placeholder="何が起きたか" value={text} onChange={(e) => setText(e.target.value)} />
        <ActionButton testid="report-send" kind="plain" onClick={async () => { await rt.user.report(o.id, { subject, text }); setSent(true); }}>
          通報する
        </ActionButton>
      </div>
      {sent && <p className="muted" data-testid="report-sent">通報しました（署名付きのメッセージを証拠として添付）。</p>}
      <p className="muted">
        あなたの受け取りアドレス: <Copyable value={o.payment === 'btc-signet' ? o.request.user_btc_address ?? '' : o.request.user_evm_address ?? ''} />
      </p>
    </Section>
  );
}
