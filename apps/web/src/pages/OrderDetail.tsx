import { fundingStarted, provisionalFunding, timelockEta, type DisputeOpen, type Payment, type UserOrder } from '@proxy-shopping/core/browser';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ActionButton, Copyable, ErrorBoundary, Field, Mono, Section, type ConfirmSpec } from '../components/ui';
import { faucet } from '../lib/faucet';
import { countdown, formatAsset, formatTime, PAYMENT_LABEL, short, STATUS_LABEL } from '../lib/format';
import type { Runtime } from '../lib/runtime';
import { useLive, useRuntime } from '../state';

const FUNDABLE = ['accepted', 'funding'];
/** Before the escrow output is spent the user may always sign the payout, dispute or (after T2) refund. */
const RELEASABLE = ['funded', 'purchased', 'shipped', 'delivered', 'delivery_failed', 'disputed', 'ruled'];

/** Current tip height (BTC) or chain time (USDC), refreshed every 10 s. */
function useChainNow(rt: Runtime, payment: Payment): number | undefined {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    const load = async () => {
      if (payment === 'btc-signet') setNow(await rt.session.chain?.tipHeight());
      else setNow(rt.session.evm ? Number(await rt.session.evm.blockTimestamp()) : undefined);
    };
    void load().catch(() => undefined);
    const t = setInterval(() => void load().catch(() => undefined), 10_000);
    return () => clearInterval(t);
  }, [payment, rt]);
  return now;
}

const Panel = ({ name, children }: { name: string; children: ReactNode }) => <ErrorBoundary name={name}>{children}</ErrorBoundary>;

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
      {o.pendingSettlement && (
        <p className="banner warn" data-testid="order-pending-settlement" data-kind={o.pendingSettlement.kind}>
          {o.pendingSettlement.from === o.shopper || o.pendingSettlement.from === o.escrow
            ? `相手が${o.pendingSettlement.kind === 'completed' ? '完了' : '連署'}を報告しました`
            : `${o.pendingSettlement.kind === 'refunded' ? '返金' : '精算'}の取引を放送しました`}
          （<Mono>{short(o.pendingSettlement.txid)}</Mono>）。チェーンで確認できるまで、この注文は終わっていません。
        </p>
      )}
      {!!o.dropped?.length && (
        <div className="banner warn" data-testid="order-dropped" data-count={o.dropped.length}>
          受け取れなかったメッセージがあります（相手に送り直しを頼んでください）:
          <ul>{o.dropped.map((d, i) => <li key={i} data-testid="order-dropped-item" data-type={d.type}>{formatTime(d.at)} {d.from} の {d.type}: {d.reason}</li>)}</ul>
        </div>
      )}

      <Panel name="summary">
        <Section title="注文の内容">
          <p>{o.request.shop_url}（{o.request.shop_region}）・ {PAYMENT_LABEL[o.payment]}</p>
          <ul>{o.request.items.map((i) => <li key={i.sku}>{i.sku} × {i.qty}</li>)}</ul>
          <p className="muted">
            shopper {o.shopperProfile?.name ?? short(o.shopper)} ・ escrow {o.escrowProfile?.name ?? short(o.escrow)} ・ operator {short(o.entry.provenance.operator)}（v{o.entry.provenance.listVersion}）
          </p>
        </Section>
      </Panel>

      <Panel name="quote"><QuotePanel o={o} /></Panel>
      {FUNDABLE.includes(o.status) && <Panel name="fund"><FundPanel o={o} /></Panel>}
      <Panel name="progress"><ProgressPanel o={o} /></Panel>
      {o.refundOffer && !o.escrowSpent && <Panel name="refund-offer"><RefundOfferPanel o={o} /></Panel>}
      <Panel name="dispute"><DisputePanel o={o} /></Panel>
      {/* Rendered on its own and never hidden by a peer's claim: only a verified on-chain spend retires it.
          An interrupted funding counts too (the refund confirms it on chain first). */}
      {provisionalFunding(o) && !o.escrowSpent && <Panel name="refund"><RefundPanel o={o} /></Panel>}
      <Panel name="report"><ReportPanel o={o} /></Panel>

      <Panel name="timeline">
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
      </Panel>
    </div>
  );
}

/** A timelock as block height / UNIX time plus an estimated date and a countdown (item 2). */
function Timelock({ o, value, now, testid }: { o: UserOrder; value: number; now?: number; testid: string }) {
  const eta = now === undefined ? undefined : timelockEta(o.payment, value, now);
  return (
    <span data-testid={testid} data-value={value} data-at={eta ?? ''}>
      {o.payment === 'btc-signet' ? `高さ ${value}` : formatTime(value)}
      {eta !== undefined && (
        <>
          {o.payment === 'btc-signet' && `（約 ${formatTime(eta)}）`}
          <span className="countdown">{countdown(eta)}</span>
        </>
      )}
    </span>
  );
}

function QuotePanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const now = useChainNow(rt, o.payment);
  const [ack, setAck] = useState(false);
  const q = o.quote;
  if (!q) {
    return (
      <Section title="見積">
        <p className="muted" data-testid="quote-waiting">shopper の見積を待っています…</p>
        {o.status === 'requested' && (
          <div className="row">
            {/* A request whose publish failed stays here: send it (and order.escrow_key) again, or give up. */}
            <ActionButton testid="order-resend" kind="plain" onClick={() => rt.user.resendRequest(o.id)}>依頼を送り直す</ActionButton>
            <ActionButton testid="order-cancel" kind="plain" onClick={() => rt.user.cancel(o.id)}>取り消す</ActionButton>
          </div>
        )}
      </Section>
    );
  }
  if (!q.accept) {
    return (
      <Section title="見積">
        <p className="banner error" data-testid="quote-rejected">断られました: {q.reject_reason} {q.detail}</p>
      </Section>
    );
  }
  const check = o.quoteCheck;
  const fx = check?.fx;
  const ackRequired = check?.ackRequired ?? [];
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
          {q.timelock && (
            <>
              <tr><th>T1（shopper が単独で受け取れる）</th><td><Timelock o={o} value={q.timelock.t1} now={now} testid="quote-timelock-t1" /></td></tr>
              <tr><th>T2（あなたが単独で返金を受けられる）</th><td><Timelock o={o} value={q.timelock.t2} now={now} testid="quote-timelock-t2" /></td></tr>
            </>
          )}
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
      {check?.ok && ackRequired.length > 0 && o.status === 'quoted' && (
        <div className="banner strong" data-testid="quote-ack-required">
          <ul>{ackRequired.map((e) => <li key={e}>{e}</li>)}</ul>
          <label className="row">
            <input type="checkbox" style={{ width: 'auto' }} data-testid="quote-ack-deviation" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            レートを自分で確かめ、この見積で承諾することを了解しました
          </label>
        </div>
      )}
      {o.status === 'quoted' && (
        <div className="row">
          <ActionButton
            testid="quote-accept"
            disabled={!check?.ok || (ackRequired.length > 0 && !ack)}
            onClick={() => rt.user.acceptQuote(o.id, { acknowledgeRateDeviation: ack })}
          >
            見積を承諾する
          </ActionButton>
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
  const [preview] = useLive(() => rt.user.previewFunding(o.id), (cb) => {
    const t = setInterval(cb, 10_000);
    return () => clearInterval(t);
  }, [rt, o.id, bal?.btcSats]);
  const q = o.quote!;
  const isBtc = o.payment === 'btc-signet';
  const need = BigInt(q.lock_amount ?? '0') + BigInt(q.escrow_upfront_fee ?? '0');
  const have = isBtc ? bal?.btcSats : bal?.usdc;
  // BTC also pays the network fee (see the preview); this is the lower bound.
  const enough = have !== undefined && have >= need;
  const faucetUrl = rt.config.faucet_url;
  if (fundingStarted(o)) {
    // A funding transaction exists already: finish that one. Balance and fee preview no longer apply
    // (the coins are spent), and nothing new is paid beyond the steps not yet sent.
    return (
      <Section title="入金" testid="fund">
        <p className="banner warn" data-testid="fund-in-progress">
          入金が途中で止まりました（{o.fundingProgress?.btcTxid ?? o.fundingProgress?.fundTx ?? o.fundingProgress?.deployTx}）。続きを実行すると、同じ取引をチェーンで確かめ、shopper と escrow に知らせます。
        </p>
        <div className="row">
          <ActionButton
            testid="order-fund-resume"
            confirm={{
              title: '入金の続きを実行します',
              amount: formatAsset(need, o.payment),
              recipient: q.escrow_address,
              details: <p className="muted">すでに送った取引は送り直しません。まだの手順（{isBtc ? 'なし' : 'Safe への送金・escrow への前払い'}）だけを実行します。</p>,
              okLabel: '続ける',
            }}
            onClick={() => rt.user.fund(o.id)}
          >
            入金を再開する
          </ActionButton>
        </div>
      </Section>
    );
  }
  const confirm = async (): Promise<ConfirmSpec> => {
    const p = await rt.user.previewFunding(o.id);
    return {
      title: isBtc ? '多重署名に入金します' : 'Safe を作って入金します',
      amount: formatAsset(p.total, o.payment),
      recipient: p.recipients[0].address,
      details: (
        <ul data-testid="confirm-details">
          {p.recipients.map((r) => <li key={r.label}>{r.label}: {formatAsset(r.amount, o.payment)} → <Mono>{r.address}</Mono></li>)}
          {p.networkFee !== undefined && <li>送金手数料: {formatAsset(p.networkFee, o.payment)}（{p.feeRate} sat/vB）</li>}
          {!isBtc && <li>ほかにガス代（ETH）がかかります</li>}
        </ul>
      ),
      okLabel: '入金する',
    };
  };
  return (
    <Section title="入金" testid="fund">
      <p>
        必要な額: {formatAsset(need, o.payment)}（預け {formatAsset(q.lock_amount, o.payment)} + escrow 前払い {formatAsset(q.escrow_upfront_fee, o.payment)}{isBtc ? ' + 送金手数料' : ' + ガス代（ETH）'}）
      </p>
      {isBtc && preview?.networkFee !== undefined && (
        <p className="muted" data-testid="fund-preview" data-fee={preview.networkFee.toString()} data-fee-rate={preview.feeRate}>
          送金手数料の見込み: {formatAsset(preview.networkFee, o.payment)}（{preview.feeRate} sat/vB、上限 {rt.config.max_fee_rate ?? 50}）・ 合計 {formatAsset(preview.total, o.payment)}
        </p>
      )}
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
        <ActionButton testid="order-fund" disabled={!enough} confirm={confirm} onClick={() => rt.user.fund(o.id)}>
          {isBtc ? '多重署名に入金する' : 'Safe を作って入金する'}
        </ActionButton>
        <ActionButton testid="order-cancel" kind="plain" onClick={() => rt.user.cancel(o.id)}>取り消す</ActionButton>
      </div>
    </Section>
  );
}

function ProgressPanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  if (!o.funded) return null;
  const q = o.quote!;
  const payout = o.payment === 'btc-signet'
    ? BigInt(q.lock_amount ?? '0') - BigInt(q.payout_fee_reserve ?? '0')
    : BigInt(q.lock_amount ?? '0');
  const releaseConfirm: ConfirmSpec = {
    title: 'shopper への支払いに署名します',
    amount: formatAsset(payout, o.payment),
    recipient: o.payment === 'btc-signet' ? q.shopper_btc_address : q.shopper_evm_address,
    warning: o.status === 'delivered'
      ? undefined
      : `まだ「配達済み」になっていません（現在: ${STATUS_LABEL[o.status] ?? o.status}）。署名すると shopper は商品を届けなくても受け取れます。`,
    okLabel: '支払いに署名する',
  };
  return (
    <Section title="購入と配送" testid="progress">
      <p data-testid="order-funded-tx">
        入金: <Mono>{o.funded.asset === 'btc-signet' ? o.funded.txid : o.funded.safe}</Mono>
      </p>
      {o.purchased ? (
        <p data-testid="order-purchased">店の注文番号 {o.purchased.shop_order_id} ・ {o.purchased.total.amount} {o.purchased.total.currency} ・ 証拠 {o.purchased.evidence.length} 件</p>
      ) : (
        <p className="muted">購入を待っています…</p>
      )}
      <ul data-testid="order-tracking">
        {o.tracking.map((t, i) => (
          <li key={i}>{formatTime(t.updated_at)} {t.status} {t.carrier} {t.tracking_no}</li>
        ))}
      </ul>
      {!o.escrowSpent && RELEASABLE.includes(o.status) && (
        <div>
          <p className="muted">商品を受け取ったら、支払いに署名してください。shopper が連署して受け取ります。</p>
          <ActionButton testid="order-release" confirm={releaseConfirm} onClick={() => rt.user.release(o.id)}>受け取りました（支払う）</ActionButton>
        </div>
      )}
      {o.completedTxid && (
        <p className="banner ok" data-testid="order-completed">
          完了しました（チェーンで確認済み）。支払いの取引: <Mono testid="order-completed-txid">{o.completedTxid}</Mono>
        </p>
      )}
    </Section>
  );
}

/** The shopper's cooperative refund, shown for review; nothing is signed until the user confirms (§4.10). */
function RefundOfferPanel({ o }: { o: UserOrder }) {
  const rt = useRuntime();
  const offer = o.refundOffer!;
  return (
    <Section title="shopper からの払い戻しの提案" testid="refund-offer">
      <p>
        {formatAsset(offer.amount, o.payment)} を <Mono>{offer.recipient}</Mono> へ（{formatTime(offer.receivedAt)} 受信）
      </p>
      {offer.problems.length > 0 ? (
        <div className="banner error" data-testid="refund-offer-problems">
          この提案は決まった形の取引ではないので連署できません:
          <ul>{offer.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      ) : (
        <ActionButton
          testid="refund-offer-accept"
          confirm={{ title: '払い戻しに連署して放送します', amount: formatAsset(offer.amount, o.payment), recipient: offer.recipient, okLabel: '連署する' }}
          onClick={() => rt.user.acceptRefundOffer(o.id)}
        >
          払い戻しを受ける（連署）
        </ActionButton>
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
  // §4.8: review (and countersign) whenever there is a ruling and the escrow output is unspent — never keyed on
  // the status, which a later dispute.open or a peer's claim could change.
  const reviewable = !!o.ruling && !o.escrowSpent;
  useEffect(() => {
    if (reviewable) void rt.user.reviewRuling(o.id).then(setProblems);
  }, [reviewable, o.ruling, o.updatedAt, o.id, rt]);

  if (!provisionalFunding(o)) return null;
  // Open to dispute whenever the escrow output is unspent on chain, whatever a peer claims.
  const canOpen = !o.escrowSpent && !o.dispute;
  if (!canOpen && !o.dispute && !o.ruling && !o.pendingRuling) return null;
  const r = o.ruling;
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
      {o.pendingRuling && !r && (
        <p className="banner warn" data-testid="ruling-pending" data-split-user={o.pendingRuling.body.split.user}>
          escrow から裁定が届きましたが、紛争が開かれたことをまだ確かめられません。shopper の申立の写しか escrow からの証拠の依頼が届けば表示します。
        </p>
      )}
      {r && (
        <div data-testid="ruling">
          <p>
            裁定: user <strong>{formatAsset(r.split.user, o.payment)}</strong> / shopper {formatAsset(r.split.shopper, o.payment)} / escrow 手数料 {formatAsset(r.split.escrow_fee, o.payment)}
          </p>
          <p className="muted">理由: {r.reason}</p>
          {r.no_obligation && <p className="banner warn">escrow は前払い手数料を確認できず、裁定の義務を負わないと表明しています。</p>}
          {problems && problems.length > 0 && (
            <div className="banner error" data-testid="ruling-problems"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
          )}
          {/* Hidden only while our own broadcast waits for the chain; a peer's claim never hides it (§4.10). */}
          {reviewable && o.pendingSettlement?.from !== rt.pubkey && (
            <ActionButton
              testid="ruling-countersign"
              disabled={!problems || problems.length > 0}
              confirm={{
                title: '裁定に連署して放送します',
                amount: formatAsset(r.split.user, o.payment),
                recipient: o.payment === 'btc-signet' ? o.request.user_btc_address : o.request.user_evm_address,
                details: <p className="muted">shopper へ {formatAsset(r.split.shopper, o.payment)}、escrow へ {formatAsset(r.split.escrow_fee, o.payment)}</p>,
                okLabel: '連署する',
              }}
              onClick={() => rt.user.countersignRuling(o.id)}
            >
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
  const now = useChainNow(rt, o.payment);
  const t2 = o.quote?.timelock?.t2;
  if (!t2) return null;
  const reached = now !== undefined && now >= t2;
  const q = o.quote!;
  const amount = o.payment === 'btc-signet'
    ? BigInt(q.lock_amount ?? '0') - (BigInt(q.payout_fee_reserve ?? '0') > 0n ? BigInt(q.payout_fee_reserve ?? '0') : 500n)
    : BigInt(q.lock_amount ?? '0');
  return (
    <Section title="タイムロックによる返金" testid="refund">
      <p className="muted" data-testid="refund-status" data-reached={reached ? 'true' : 'false'}>
        T2 = <Timelock o={o} value={t2} now={now} testid="refund-t2" /> ・ 現在 {o.payment === 'btc-signet' ? `高さ ${now ?? '…'}` : now ? formatTime(now) : '…'}。T2 を過ぎると、あなた一人で全額を取り戻せます。
      </p>
      <ActionButton
        testid="order-refund"
        kind="plain"
        disabled={!reached}
        confirm={{
          title: 'T2 後の返金を受けます',
          amount: formatAsset(amount, o.payment),
          recipient: o.payment === 'btc-signet' ? o.request.user_btc_address : o.request.user_evm_address,
          okLabel: '返金を受ける',
        }}
        onClick={() => rt.user.refundAfterTimelock(o.id)}
      >
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
