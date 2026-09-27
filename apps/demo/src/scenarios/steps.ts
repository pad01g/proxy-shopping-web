/**
 * Building blocks of the scenarios. Every `done` is "this or anything after it happened", so a step is
 * recognised even when the state moved on quickly (the guide checks the steps in order).
 */
import type { Payment, UserOrderStatus } from '@proxy-shopping/core/browser';
import { formatAsset, NODE_STATE_LABEL, STATUS_LABEL } from '../lib/format';
import type { GuideCtx, OrderPreset, Step } from './types';

const set = (...s: UserOrderStatus[]): ReadonlySet<UserOrderStatus> => new Set(s);
const ACCEPTED = set('accepted', 'funding', 'funded', 'purchased', 'shipped', 'delivered', 'delivery_failed', 'released', 'completed', 'disputed', 'ruled', 'settled', 'refunded');
const PURCHASED = set('purchased', 'shipped', 'delivered', 'delivery_failed', 'released', 'completed', 'disputed', 'ruled', 'settled');
const DELIVERED = set('delivered', 'released', 'completed');
const FAILED = set('delivery_failed', 'disputed', 'ruled', 'settled');
const RELEASED = set('released', 'completed');

const BTC_NEEDED = 200_000n;
const USDC_NEEDED = 100_000_000n;
const ETH_NEEDED = 50_000_000_000_000_000n;
/** The shopper node pays the gas of USDC payouts (§6.4). */
const SHOPPER_ETH_NEEDED = 100_000_000_000_000_000n;

const big = (v?: string): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
const has = (o: GuideCtx['order'], s: ReadonlySet<UserOrderStatus>) => !!o && s.has(o.status);

export const assetWords = (p: Payment) => (p === 'btc-signet'
  ? { coin: 'BTC（signet）', lock: '2-of-3 のマルチシグ（P2WSH）', lockShort: 'マルチシグ' }
  : { coin: 'USDC', lock: '注文ごとの Safe（2-of-3 のマルチシグ・コントラクト）', lockShort: 'Safe' });

/** "shopper ノードの状態: 購入中" — what the Go node says about the scenario's order. */
export function nodeProgress(ctx: GuideCtx): string {
  const n = ctx.nodeOrder;
  if (!n) return `${ctx.shopper.name} ノードはまだこの注文を記録していません`;
  return `${ctx.shopper.name} ノードの状態: ${NODE_STATE_LABEL[n.state] ?? n.state}${n.error ? `（${n.error}）` : ''}`;
}

const userProgress = (ctx: GuideCtx): string | undefined => {
  const o = ctx.order;
  if (!o) return undefined;
  return `利用者の画面の状態: ${STATUS_LABEL[o.status] ?? o.status}${o.lastError ? `（エラー: ${o.lastError}）` : ''}`;
};

const both = (ctx: GuideCtx) => [nodeProgress(ctx), userProgress(ctx)].filter(Boolean).join(' ・ ');

// ---------- 準備（全シナリオ共通。済んでいれば ✓） ----------

export function prepareSteps(): Step[] {
  return [
    {
      id: 'prep-delegate',
      actor: 'coordinator',
      title: 'operator に委任する',
      text: 'coordinator が、このデモの operator に「一覧を作ってよい」という委任書（kind 30500）に署名して公開します。lab の Go ノード（shopper-1 など）と利用者のアプリは、この coordinator の鍵を信頼の起点にしています。',
      action: (ctx) => ({ testid: 'coordinator-delegate', prefill: { operator: ctx.ids.operator.pubkey } }),
      done: (ctx) => !!ctx.snap.coordinator?.delegations.some((d) => d.operator === ctx.ids.operator.pubkey && !d.revoked),
    },
    {
      id: 'prep-list',
      actor: 'operator',
      title: '組み合わせの一覧を公開する',
      text: 'operator が「地域 × shopper × escrow」の組み合わせ一覧（kind 30501）に署名して公開します。ここでは shopper-1（Go ノード）とこのデモの escrow を JP-13（東京都）と US に載せます。一覧には利用者が確かめる EVM のコントラクト（Safe・モジュール）のアドレスも入ります。',
      action: { testid: 'operator-publish', prefill: { demo: true } },
      done: (ctx) => {
        const entries = ctx.snap.operator?.list?.entries ?? [];
        return ['JP-13', 'US'].every((region) =>
          entries.some((e) => e.region === region && e.shopper === ctx.shopper.pubkey && e.escrow === ctx.ids.escrow.pubkey && e.payments.length === 2));
      },
    },
    {
      id: 'prep-escrow-profile',
      actor: 'escrow',
      title: 'escrow のプロフィールを公開する',
      text: 'escrow がプロフィール（kind 30503）を公開します。BTC の注文鍵を導く拡張公開鍵（tpub）と手数料の条件（前払い 0.5%・最低 1000 sats / 0.50 USDC、紛争手数料 2%）が載ります。shopper はこれを見て見積に escrow の鍵と前払い手数料を入れます。',
      action: { testid: 'escrow-profile-publish' },
      done: (ctx) => !!ctx.snap.escrow?.profile,
    },
    {
      id: 'prep-node-trust',
      actor: 'shopper',
      title: 'shopper ノードが一覧を受け取る',
      text: 'shopper-1 ノードが Nostr リレー（と libp2p の網）から委任書・一覧・escrow のプロフィールを受け取るのを待ちます。一覧に載っていない組み合わせの注文は、shopper が「trust」で断ります。',
      done: (ctx) =>
        ctx.lab.shopper.effective.some((e) => e.shopper === ctx.shopper.pubkey && e.escrow === ctx.ids.escrow.pubkey && e.operator === ctx.ids.operator.pubkey)
        && ctx.lab.shopper.escrowProfiles.includes(ctx.ids.escrow.pubkey),
      progress: (ctx) => {
        const list = ctx.lab.shopper.effective.some((e) => e.escrow === ctx.ids.escrow.pubkey && e.operator === ctx.ids.operator.pubkey);
        const profile = ctx.lab.shopper.escrowProfiles.includes(ctx.ids.escrow.pubkey);
        return `一覧: ${list ? '受信済み' : '待っています'} ・ escrow のプロフィール: ${profile ? '受信済み' : '待っています'}`;
      },
    },
    {
      id: 'prep-btc',
      actor: 'user',
      title: 'BTC を受け取る（lab の蛇口）',
      text: '利用者の財布に lab の蛇口から signet の BTC を送ってもらいます（本物の網では自分で用意します）。',
      action: { testid: 'wallet-faucet-btc' },
      done: (ctx) => big(ctx.snap.user?.btcSats) >= BTC_NEEDED,
      progress: (ctx) => `残高: ${formatAsset(ctx.snap.user?.btcSats, 'btc-signet')}`,
    },
    {
      id: 'prep-evm',
      actor: 'user',
      title: 'USDC と ETH を受け取る（lab の蛇口）',
      text: '利用者の EVM アカウントに USDC とガス代の ETH を送ってもらいます。',
      action: { testid: 'wallet-faucet-evm' },
      done: (ctx) => big(ctx.snap.user?.usdc) >= USDC_NEEDED && big(ctx.snap.user?.eth) >= ETH_NEEDED,
      progress: (ctx) => `残高: ${formatAsset(ctx.snap.user?.usdc, 'usdc-evm')} ・ ETH ${(Number(big(ctx.snap.user?.eth)) / 1e18).toFixed(3)}`,
    },
  ];
}

/** USDC payouts are executed (and paid for) by the shopper node: give it gas. */
export const shopperGasStep = (): Step => ({
  id: 'lab-shopper-gas',
  actor: 'lab',
  title: 'shopper ノードにガス代を配る',
  text: 'USDC の支払いは、受け取る shopper が Safe の取引を実行してガス代（ETH）を払います。lab の蛇口から shopper-1 の EVM アカウントに ETH を送ります。',
  action: { testid: 'lab-shopper-gas' },
  done: (ctx) => big(ctx.lab.shopper.eth) >= SHOPPER_ETH_NEEDED,
  progress: (ctx) => `shopper-1 の ETH: ${(Number(big(ctx.lab.shopper.eth)) / 1e18).toFixed(3)}`,
});

// ---------- 注文から入金まで ----------

export function orderStep(p: OrderPreset, what: string): Step {
  return {
    id: 'order',
    actor: 'user',
    title: '注文を依頼する',
    text: `利用者が ${p.shopUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')} の ${p.sku}（${what}）を ${assetWords(p.payment).coin} で注文します。候補の中からこのデモの escrow の組み合わせを選びます。届け先は暗号化され、shopper と（紛争になったときだけ）escrow しか読めません。`,
    action: { testid: 'order-submit' },
    done: (ctx) => !!ctx.order,
  };
}

export const quoteWaitStep = (): Step => ({
  id: 'quote-wait',
  actor: 'shopper',
  title: '見積を待つ',
  text: 'shopper ノードが店の危険度・地域・支払い手段を判定し、レートを取得して見積を返します。見積には多重署名のアドレスとタイムロック（T1: shopper が単独で受け取れる時点、T2: 利用者が単独で取り戻せる時点）が入ります。',
  done: (ctx) => !!ctx.order && ctx.order.status !== 'requested',
  progress: both,
});

export const acceptStep = (p: Payment): Step => ({
  id: 'accept',
  actor: 'user',
  title: '見積を承諾する',
  text: `利用者のアプリが見積を検証しました: レートを自分の取得元で計算し直し、${assetWords(p).lock}のアドレスを自分で計算して一致を確かめ、タイムロックが方針に合うかを見ています。内容を確かめて承諾します。`,
  action: (ctx) => ({ testid: 'quote-accept', confirm: !!ctx.order?.ackRequired }),
  done: (ctx) => has(ctx.order, ACCEPTED),
  progress: userProgress,
});

export const fundStep = (p: Payment): Step => ({
  id: 'fund',
  actor: 'user',
  title: p === 'btc-signet' ? 'マルチシグに入金する' : 'Safe を作って入金する',
  text: p === 'btc-signet'
    ? '利用者が 2-of-3 のマルチシグ（利用者・shopper・escrow の鍵）に入金し、同じ取引で escrow に前払い手数料を払います。お金は 3 人のうち 2 人の署名がそろうまで動きません。入金したことを shopper と escrow に知らせます。'
    : '利用者が注文ごとの Safe（所有者は利用者・shopper・escrow、しきい値 2）を作って USDC を入れ、escrow に前払い手数料を送ります。Safe にはタイムロックのモジュールも組み込まれます。',
  action: { testid: 'order-fund', confirm: true },
  done: (ctx) => !!ctx.order?.funded,
  progress: userProgress,
});

export const purchaseWaitStep = (): Step => ({
  id: 'purchase-wait',
  actor: 'shopper',
  title: 'shopper が購入する',
  text: 'shopper ノードが入金を 1 承認で確かめ、自動操作ツール（shopper-bot）で店に代理注文します。店の注文番号と画面の証拠を利用者に送ります。',
  done: (ctx) => has(ctx.order, PURCHASED),
  progress: both,
});

export const deliveredWaitStep = (): Step => ({
  id: 'delivered-wait',
  actor: 'shopper',
  title: '配達を待つ',
  text: '店が発送し、配達されます（lab の店は注文の 2 秒後に発送、さらに 3 秒後に配達）。shopper は追跡状況を定期的に調べて利用者に知らせます。',
  done: (ctx) => has(ctx.order, DELIVERED),
  progress: both,
});

export const failedWaitStep = (): Step => ({
  id: 'failed-wait',
  actor: 'shopper',
  title: '配送の失敗を待つ',
  text: 'この商品（FAIL-100）は発送の後、配送に失敗します。shopper は追跡状況「failed」を利用者に知らせます。お金はまだマルチシグの中です。',
  done: (ctx) => has(ctx.order, FAILED),
  progress: both,
});

// ---------- 支払い ----------

export const releaseStep = (): Step => ({
  id: 'release',
  actor: 'user',
  title: '受け取りを確認して支払う',
  text: '商品が届いたので、利用者が shopper への支払いに署名します（2-of-3 の 1 つ目の署名）。escrow の出番はありません。',
  action: { testid: 'order-release', confirm: true },
  done: (ctx) => has(ctx.order, RELEASED),
  progress: userProgress,
});

export const completedWaitStep = (): Step => ({
  id: 'completed-wait',
  actor: 'chain',
  title: 'チェーンで完了を確かめる',
  text: 'shopper が 2 つ目の署名を加えて放送します（escrow のロック解除）。利用者のアプリは、チェーン上で多重署名の出力が使われたのを確かめてから「完了」にします。',
  done: (ctx) => ctx.order?.status === 'completed',
  progress: both,
});

// ---------- 紛争 ----------

export const disputeStep = (): Step => ({
  id: 'dispute',
  actor: 'user',
  title: '紛争を申し立てる',
  text: '利用者が escrow に紛争を申し立てます。署名付きのメッセージ・配送状況・届け先を開く鍵（key_for_escrow）を証拠として渡し、写しを shopper にも送ります。',
  action: { testid: 'dispute-open', prefill: { claim: 'not_delivered', text: '配送に失敗したと通知が来ました。返金してください。' } },
  done: (ctx) => !!ctx.order?.dispute,
  progress: userProgress,
});

export const caseWaitStep = (): Step => ({
  id: 'case-wait',
  actor: 'escrow',
  title: 'escrow に案件が届く',
  text: 'escrow の画面に案件が現れるのを待ちます。escrow は入金の通知と紛争の証拠から注文を組み立て、チェーン上の入金と前払い手数料を確かめてから案件を開きます。',
  done: (ctx) => !!ctx.escrowCase && ctx.escrowCase.disputes > 0,
  progress: (ctx) => (ctx.escrowCase ? `案件の状態: ${STATUS_LABEL[ctx.escrowCase.status] ?? ctx.escrowCase.status}（申立 ${ctx.escrowCase.disputes} 件）` : 'まだ案件はありません'),
});

export const decryptStep = (): Step => ({
  id: 'decrypt',
  actor: 'escrow',
  title: '証拠を確かめ、届け先を復号する',
  text: 'escrow が証拠（署名付きメッセージ・配送状況・購入画面）を確かめ、届け先を復号します。復号の鍵は紛争のときだけ渡され、署名付きの依頼に入っているハッシュと一致するものだけが使えます。',
  action: { testid: 'escrow-decrypt-address' },
  done: (ctx) => !!ctx.escrowCase?.decrypted,
});

export const rulingStep = (to: 'user' | 'shopper'): Step => ({
  id: 'ruling',
  actor: 'escrow',
  title: to === 'user' ? '全額を利用者へ返す裁定をする' : '全額を shopper へ渡す裁定をする（不正な裁定のデモ）',
  text: to === 'user'
    ? 'escrow が配分（利用者へ全額、shopper へ 0、escrow の紛争手数料 2%）を決め、その取引に署名して両者に送ります。escrow は 1 件の紛争に 1 回しか裁定しません。'
    : '（不正な裁定のデモ）配送に失敗したのに、escrow が全額を shopper に配分する取引に署名して送ります。2-of-3 なので、shopper が連署すればお金は動いてしまいます。',
  action: {
    testid: 'ruling-submit',
    prefill: to === 'user'
      ? { preset: 'user', reason: '配送に失敗したため、全額を利用者へ返します' }
      : { preset: 'shopper', reason: '（不正な裁定のデモ）全額を shopper へ' },
  },
  done: (ctx) => !!ctx.escrowCase?.ruling,
});

export const rulingArrivesStep = (): Step => ({
  id: 'ruling-arrives',
  actor: 'user',
  title: '裁定が届く',
  text: '裁定が利用者に届くのを待ちます。利用者のアプリは、裁定の取引が配分どおりで、escrow の手数料が上限（2%）以内かを確かめます。',
  done: (ctx) => !!ctx.order?.ruling || ctx.order?.status === 'settled',
  progress: userProgress,
});

export const countersignStep = (): Step => ({
  id: 'countersign',
  actor: 'user',
  title: '裁定に連署する',
  text: '利用者が escrow の署名済みの取引に連署して放送します（escrow と利用者の 2 つの署名で 2-of-3 がそろいます）。',
  action: { testid: 'ruling-countersign', confirm: true },
  done: (ctx) => ctx.order?.status === 'settled' || !!ctx.order?.pendingSettlement?.mine,
  progress: userProgress,
});

export const settledWaitStep = (who: string): Step => ({
  id: 'settled-wait',
  actor: 'chain',
  title: 'チェーンで精算を確かめる',
  text: `${who}の放送した精算の取引がチェーンに入り、多重署名の出力が使われたのを利用者のアプリが確かめます。`,
  done: (ctx) => ctx.order?.status === 'settled',
  progress: both,
});

// ---------- 払い戻し・返金 ----------

export const refundOfferWaitStep = (): Step => ({
  id: 'refund-offer-wait',
  actor: 'shopper',
  title: '買えなかったので、shopper が払い戻しを申し出る',
  text: 'shopper ノードが店で注文しようとしますが、在庫切れで失敗します。shopper は買わずに、利用者へ全額を返す取引に署名して申し出ます（協力的な払い戻し）。',
  // A bot result the node cannot interpret goes to a human; in the lab the shopper tab stands in for them.
  action: (ctx) => (ctx.nodeOrder?.state === 'needs_human' ? { testid: 'shopper-resolve-refund', tab: 'shopper', confirm: true } : undefined),
  done: (ctx) => !!ctx.order?.refundOffer || ctx.order?.status === 'refunded',
  progress: both,
});

export const acceptRefundStep = (): Step => ({
  id: 'refund-accept',
  actor: 'user',
  title: '払い戻しを確かめて受ける',
  text: '利用者のアプリが払い戻しの取引を確かめました（入力は入金の出力だけ、宛先は利用者だけ、手数料は予備の範囲）。資金を動かす署名なので、利用者が確認してから連署して放送します。',
  action: { testid: 'refund-offer-accept', confirm: true },
  done: (ctx) => ctx.order?.status === 'refunded' || ctx.order?.pendingSettlement?.kind === 'refunded' || !!ctx.order?.refundTxid,
  progress: userProgress,
});

export const refundedWaitStep = (): Step => ({
  id: 'refunded-wait',
  actor: 'chain',
  title: 'チェーンで返金を確かめる',
  text: '返金の取引がチェーンに入り、多重署名の出力が使われたのを利用者のアプリが確かめます。',
  done: (ctx) => ctx.order?.status === 'refunded',
  progress: userProgress,
});
