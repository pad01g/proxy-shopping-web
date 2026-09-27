import { REJECT_LABEL } from '../lib/format';
import { preset } from './presets';
import {
  acceptRefundStep, acceptStep, caseWaitStep, completedWaitStep, countersignStep, decryptStep, deliveredWaitStep, disputeStep,
  failedWaitStep, fundStep, nodeProgress, orderStep, prepareSteps, purchaseWaitStep, quoteWaitStep, refundedWaitStep,
  refundOfferWaitStep, releaseStep, rulingArrivesStep, rulingStep, settledWaitStep, shopperGasStep,
} from './steps';
import type { Scenario, Step } from './types';

const normalBtc = (): Scenario => {
  const p = preset('safe-a100');
  return {
    id: 'normal-btc',
    title: '正常系（BTC）',
    description: '安全な店の商品を BTC で代理購入してもらい、届いたら利用者と shopper の署名でマルチシグのロックを解いて支払います。',
    preset: p,
    steps: [
      ...prepareSteps(),
      orderStep(p, '抹茶ティーセット, 3200 円'), quoteWaitStep(), acceptStep(p.payment), fundStep(p.payment),
      purchaseWaitStep(), deliveredWaitStep(), releaseStep(), completedWaitStep(),
    ],
  };
};

const normalUsdc = (): Scenario => {
  const p = preset('us-u100');
  return {
    id: 'normal-usdc',
    title: '正常系（USDC）',
    description: '米国の店の商品を USDC で代理購入してもらいます。預け先は注文ごとの Safe（2-of-3）で、届いたら利用者が署名し、shopper が連署して実行します。',
    preset: p,
    steps: [
      ...prepareSteps(), shopperGasStep(),
      orderStep(p, 'Coffee beans 1kg, 25.00 USD'), quoteWaitStep(), acceptStep(p.payment), fundStep(p.payment),
      purchaseWaitStep(), deliveredWaitStep(), releaseStep(), completedWaitStep(),
    ],
  };
};

const disputeRefund = (): Scenario => {
  const p = preset('safe-fail');
  return {
    id: 'dispute-refund',
    title: '配達失敗 → 紛争 → 返金',
    description: '配送に失敗する商品を注文します。利用者が紛争を申し立て、escrow が証拠を確かめて全額を利用者に返す裁定をし、利用者が連署して取り戻します。',
    preset: p,
    steps: [
      ...prepareSteps(),
      orderStep(p, '配送に失敗する商品, 2000 円'), quoteWaitStep(), acceptStep(p.payment), fundStep(p.payment),
      purchaseWaitStep(), failedWaitStep(), disputeStep(), caseWaitStep(), decryptStep(), rulingStep('user'),
      rulingArrivesStep(), countersignStep(), settledWaitStep('利用者'),
    ],
  };
};

const soldOut = (): Scenario => {
  const p = preset('safe-soldout');
  return {
    id: 'sold-out',
    title: '在庫切れ → 協力的な払い戻し',
    description: '在庫切れの商品を注文します。shopper は買えなかったので、全額を返す取引に署名して申し出ます。利用者が内容を確かめて連署します。',
    preset: p,
    steps: [
      ...prepareSteps(),
      orderStep(p, '在庫切れの商品, 2500 円'), quoteWaitStep(), acceptStep(p.payment), fundStep(p.payment),
      refundOfferWaitStep(), acceptRefundStep(), refundedWaitStep(),
    ],
  };
};

const risky = (): Scenario => {
  const p = preset('risky-r100');
  const rejected: Step = {
    id: 'rejected',
    actor: 'user',
    title: '断られたことを確かめる',
    text: 'risky-shop は HTTP だけで、決済画面も知らないゲートウェイです。shopper は店を点数化し（許可リスト・証明書・決済画面）、しきい値未満なので「risk」で断ります。利用者の画面に理由が表示されます。お金は動いていません。',
    done: (ctx) => ctx.order?.status === 'rejected' && ctx.order.rejectReason === 'risk',
    progress: (ctx) => (ctx.order?.status === 'rejected'
      ? `断られた理由: ${ctx.order.rejectReason}（${REJECT_LABEL[ctx.order.rejectReason ?? ''] ?? '?'}）`
      : nodeProgress(ctx)),
  };
  return {
    id: 'risky',
    title: '危険な店',
    description: '危険と判定される店の商品を注文します。shopper は見積を出さずに断ります。',
    preset: p,
    steps: [...prepareSteps(), orderStep(p, '安すぎるヘッドホン, 9.99 USD'), quoteWaitStep(), rejected],
  };
};

const fraud = (): Scenario => {
  const p = preset('safe-fail');
  const steps: Step[] = [
    {
      id: 'shopper-countersign',
      actor: 'shopper',
      title: 'shopper が自動で連署する',
      text: 'shopper ノードは開いている紛争の裁定を自動で連署して放送します（手数料が上限内なら）。escrow と shopper の 2 つの署名がそろうので、利用者の同意が無くてもお金は shopper へ動きます。',
      done: (ctx) => ctx.order?.status === 'settled',
      progress: nodeProgress,
    },
    {
      id: 'report',
      actor: 'user',
      title: 'escrow を通報する',
      text: '利用者が operator に escrow を通報します。この注文の署名付きメッセージ（依頼・見積・入金・配送失敗・裁定）がそのまま証拠になります。',
      action: { testid: 'report-send', prefill: { subject: 'escrow', text: '配送に失敗したのに、escrow が全額を shopper に配分しました' } },
      done: (ctx) => !!ctx.order?.reported,
    },
    {
      id: 'report-arrives',
      actor: 'operator',
      title: '通報が operator に届く',
      text: 'operator の受信箱に通報が届くのを待ちます。',
      done: (ctx) => !!ctx.order && !!ctx.snap.operator?.reports.some((r) => r.orderId === ctx.order!.id && r.subject === ctx.ids.escrow.pubkey),
    },
    {
      id: 'remove-escrow',
      actor: 'operator',
      title: 'escrow を一覧から外す',
      text: 'operator が証拠を確かめ、この escrow の組み合わせを外した一覧の新しい版に署名して公開します（bond の没収などはプロトコルの外の規約）。',
      action: (ctx) => ({ testid: 'operator-remove-escrow', prefill: { escrow: ctx.ids.escrow.pubkey } }),
      done: (ctx) => !!ctx.snap.operator?.list && !ctx.snap.operator.list.entries.some((e) => e.escrow === ctx.ids.escrow.pubkey),
    },
    {
      id: 'offers-gone',
      actor: 'user',
      title: '候補から消えたことを確かめる',
      text: '利用者が候補を探し直します。新しい版の一覧にはこの escrow の組み合わせが無いので、候補に出てきません（shopper ノードも同じ一覧で判断します）。',
      action: { testid: 'order-search' },
      done: (ctx) => {
        const offers = ctx.snap.user?.offers;
        const removedAt = ctx.doneAt('remove-escrow');
        return !!offers && !!removedAt && offers.at > removedAt && !offers.list.some((o) => o.escrow === ctx.ids.escrow.pubkey);
      },
    },
  ];
  return {
    id: 'fraud',
    title: '不正な escrow → 通報 → 一覧から外す',
    description: '配送に失敗した注文で、escrow がわざと全額を shopper に配分します（不正な裁定のデモ）。利用者が通報し、operator がその escrow を一覧から外します。',
    preset: p,
    steps: [
      ...prepareSteps(),
      orderStep(p, '配送に失敗する商品, 2000 円'), quoteWaitStep(), acceptStep(p.payment), fundStep(p.payment),
      purchaseWaitStep(), failedWaitStep(), disputeStep(), caseWaitStep(), rulingStep('shopper'), ...steps,
    ],
  };
};

const timelockT2 = (): Scenario => {
  const p = preset('safe-a100');
  const paused = (ctx: Parameters<Step['done']>[0]) => (ctx.lab.shopper.status?.paused_until ?? 0) > ctx.now;
  const steps: Step[] = [
    {
      id: 'pause',
      actor: 'lab',
      title: 'shopper ノードを止める',
      text: '「shopper が消えた」状態を作ります。lab の管理 API で shopper-1 のメッセージの送受信と定期処理を止めます（入金しても買いに行きません）。',
      action: { testid: 'lab-pause-shopper' },
      done: paused,
      progress: (ctx) => (paused(ctx) ? '停止中' : '動いています'),
    },
    fundStep(p.payment),
    {
      id: 'mine-t2',
      actor: 'lab',
      title: 'T2 までブロックを掘る',
      text: 'T2（見積のタイムロック）を過ぎるまで signet のブロックを掘ります。本物の網なら数週間待つところを、lab では一瞬で進めます。',
      action: (ctx) => {
        const t2 = ctx.order?.t2;
        const h = ctx.lab.heights?.btc;
        return { testid: 'lab-mine', prefill: t2 !== undefined && h !== undefined ? { blocks: Math.max(1, t2 - h + 1) } : undefined };
      },
      done: (ctx) => ctx.order?.t2 !== undefined && (ctx.lab.heights?.btc ?? 0) >= ctx.order.t2,
      progress: (ctx) => `いまの高さ ${ctx.lab.heights?.btc ?? '?'} ・ T2 = ${ctx.order?.t2 ?? '?'}`,
    },
    {
      id: 'refund-t2',
      actor: 'user',
      title: 'T2 後に一人で取り戻す',
      text: 'T2 を過ぎたので、利用者は shopper や escrow の署名なしで、witness script の T2 の経路（利用者の鍵だけ）で全額を取り戻します。',
      action: { testid: 'order-refund', confirm: true },
      done: (ctx) => ctx.order?.status === 'refunded' || ctx.order?.pendingSettlement?.kind === 'refunded' || !!ctx.order?.refundTxid,
    },
    refundedWaitStep(),
    {
      id: 'resume',
      actor: 'lab',
      title: 'shopper ノードを戻す',
      text: '止めていた shopper-1 を再開します（ほかのシナリオのため）。再開した shopper は、T1 を過ぎた注文を買わずに払い戻しを申し出るだけです。',
      action: { testid: 'lab-resume-shopper' },
      done: (ctx) => !!ctx.lab.shopper.status && !paused(ctx),
      progress: (ctx) => (paused(ctx) ? '停止中' : '動いています'),
    },
  ];
  return {
    id: 'timelock-t2',
    title: 'shopper が消えたら T2 で取り戻す（BTC）',
    description: '見積を承諾した後に shopper が応答しなくなった場合です。入金したお金は、T2 を過ぎると利用者が一人で取り戻せます。',
    preset: p,
    steps: [...prepareSteps(), orderStep(p, '抹茶ティーセット, 3200 円'), quoteWaitStep(), acceptStep(p.payment), ...steps],
  };
};

export const SCENARIOS: Scenario[] = [normalBtc(), normalUsdc(), disputeRefund(), soldOut(), risky(), fraud(), timelockT2()];

export const DEFAULT_SCENARIO = SCENARIOS[0].id;

export const scenarioById = (id: string): Scenario => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
