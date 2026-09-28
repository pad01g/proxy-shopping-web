import { getLang, label, messagesFor, useLang, type Lang, type Messages } from '../i18n';
import { preset } from './presets';
import {
  acceptRefundStep, acceptStep, caseWaitStep, completedWaitStep, countersignStep, decryptStep, deliveredWaitStep, disputeStep,
  failedWaitStep, fundStep, nodeProgress, orderStep, prepareSteps, purchaseWaitStep, quoteWaitStep, refundedWaitStep,
  refundOfferWaitStep, releaseStep, rulingArrivesStep, rulingStep, settledWaitStep, shopperGasStep,
} from './steps';
import type { Scenario, Step } from './types';

type ScenarioId = keyof Messages['scenarios'];

const meta = (m: Messages, id: ScenarioId) => ({ id, ...m.scenarios[id] });

const normalBtc = (m: Messages): Scenario => {
  const p = preset('safe-a100');
  return {
    ...meta(m, 'normal-btc'),
    preset: p,
    steps: [
      ...prepareSteps(m),
      orderStep(m, p), quoteWaitStep(m), acceptStep(m, p.payment), fundStep(m, p.payment),
      purchaseWaitStep(m), deliveredWaitStep(m), releaseStep(m), completedWaitStep(m),
    ],
  };
};

const normalUsdc = (m: Messages): Scenario => {
  const p = preset('us-u100');
  return {
    ...meta(m, 'normal-usdc'),
    preset: p,
    steps: [
      ...prepareSteps(m), shopperGasStep(m),
      orderStep(m, p), quoteWaitStep(m), acceptStep(m, p.payment), fundStep(m, p.payment),
      purchaseWaitStep(m), deliveredWaitStep(m), releaseStep(m), completedWaitStep(m),
    ],
  };
};

const disputeRefund = (m: Messages): Scenario => {
  const p = preset('safe-fail');
  return {
    ...meta(m, 'dispute-refund'),
    preset: p,
    steps: [
      ...prepareSteps(m),
      orderStep(m, p), quoteWaitStep(m), acceptStep(m, p.payment), fundStep(m, p.payment),
      purchaseWaitStep(m), failedWaitStep(m), disputeStep(m), caseWaitStep(m), decryptStep(m), rulingStep(m, 'user'),
      rulingArrivesStep(m), countersignStep(m), settledWaitStep(m, m.roles.label.user),
    ],
  };
};

const soldOut = (m: Messages): Scenario => {
  const p = preset('safe-soldout');
  return {
    ...meta(m, 'sold-out'),
    preset: p,
    steps: [
      ...prepareSteps(m),
      orderStep(m, p), quoteWaitStep(m), acceptStep(m, p.payment), fundStep(m, p.payment),
      refundOfferWaitStep(m), acceptRefundStep(m), refundedWaitStep(m),
    ],
  };
};

const risky = (m: Messages): Scenario => {
  const p = preset('risky-r100');
  const rejected: Step = {
    id: 'rejected',
    actor: 'user',
    title: m.steps.rejected.title,
    text: m.steps.rejected.text,
    done: (ctx) => ctx.order?.status === 'rejected' && ctx.order.rejectReason === 'risk',
    progress: (ctx) => (ctx.order?.status === 'rejected'
      ? m.steps.rejected.progress(ctx.order.rejectReason ?? '', ctx.order.rejectReason ? label(m.format.reject, ctx.order.rejectReason) : '?')
      : nodeProgress(m)(ctx)),
  };
  return {
    ...meta(m, 'risky'),
    preset: p,
    steps: [...prepareSteps(m), orderStep(m, p), quoteWaitStep(m), rejected],
  };
};

const fraud = (m: Messages): Scenario => {
  const p = preset('safe-fail');
  const w = m.steps;
  const steps: Step[] = [
    {
      id: 'shopper-countersign',
      actor: 'shopper',
      ...w.shopperCountersign,
      done: (ctx) => ctx.order?.status === 'settled',
      progress: nodeProgress(m),
    },
    {
      id: 'report',
      actor: 'user',
      title: w.report.title,
      text: w.report.text,
      action: { testid: 'report-send', prefill: { subject: 'escrow', text: w.report.prefill } },
      done: (ctx) => !!ctx.order?.reported,
    },
    {
      id: 'report-arrives',
      actor: 'operator',
      ...w.reportArrives,
      done: (ctx) => !!ctx.order && !!ctx.snap.operator?.reports.some((r) => r.orderId === ctx.order!.id && r.subject === ctx.ids.escrow.pubkey),
    },
    {
      id: 'remove-escrow',
      actor: 'operator',
      ...w.removeEscrow,
      action: (ctx) => ({ testid: 'operator-remove-escrow', prefill: { escrow: ctx.ids.escrow.pubkey } }),
      done: (ctx) => !!ctx.snap.operator?.list && !ctx.snap.operator.list.entries.some((e) => e.escrow === ctx.ids.escrow.pubkey),
    },
    {
      id: 'offers-gone',
      actor: 'user',
      ...w.offersGone,
      action: { testid: 'order-search' },
      done: (ctx) => {
        const offers = ctx.snap.user?.offers;
        const removedAt = ctx.doneAt('remove-escrow');
        return !!offers && !!removedAt && offers.at > removedAt && !offers.list.some((o) => o.escrow === ctx.ids.escrow.pubkey);
      },
    },
  ];
  return {
    ...meta(m, 'fraud'),
    preset: p,
    steps: [
      ...prepareSteps(m),
      orderStep(m, p), quoteWaitStep(m), acceptStep(m, p.payment), fundStep(m, p.payment),
      purchaseWaitStep(m), failedWaitStep(m), disputeStep(m), caseWaitStep(m), rulingStep(m, 'shopper'), ...steps,
    ],
  };
};

const timelockT2 = (m: Messages): Scenario => {
  const p = preset('safe-a100');
  const w = m.steps;
  const paused = (ctx: Parameters<Step['done']>[0]) => (ctx.lab.shopper.status?.paused_until ?? 0) > ctx.now;
  const steps: Step[] = [
    {
      id: 'pause',
      actor: 'lab',
      ...w.pause,
      action: { testid: 'lab-pause-shopper' },
      done: paused,
      progress: (ctx) => (paused(ctx) ? w.paused : w.running),
    },
    fundStep(m, p.payment),
    {
      id: 'mine-t2',
      actor: 'lab',
      title: w.mineT2.title,
      text: w.mineT2.text,
      action: (ctx) => {
        const t2 = ctx.order?.t2;
        const h = ctx.lab.heights?.btc;
        return { testid: 'lab-mine', prefill: t2 !== undefined && h !== undefined ? { blocks: Math.max(1, t2 - h + 1) } : undefined };
      },
      done: (ctx) => ctx.order?.t2 !== undefined && (ctx.lab.heights?.btc ?? 0) >= ctx.order.t2,
      progress: (ctx) => w.mineT2.progress(String(ctx.lab.heights?.btc ?? '?'), String(ctx.order?.t2 ?? '?')),
    },
    {
      id: 'refund-t2',
      actor: 'user',
      ...w.refundT2,
      action: { testid: 'order-refund', confirm: true },
      done: (ctx) => ctx.order?.status === 'refunded' || ctx.order?.pendingSettlement?.kind === 'refunded' || !!ctx.order?.refundTxid,
    },
    refundedWaitStep(m),
    {
      id: 'resume',
      actor: 'lab',
      ...w.resume,
      action: { testid: 'lab-resume-shopper' },
      done: (ctx) => !!ctx.lab.shopper.status && !paused(ctx),
      progress: (ctx) => (paused(ctx) ? w.paused : w.running),
    },
  ];
  return {
    ...meta(m, 'timelock-t2'),
    preset: p,
    steps: [...prepareSteps(m), orderStep(m, p), quoteWaitStep(m), acceptStep(m, p.payment), ...steps],
  };
};

const build = (m: Messages): Scenario[] => [normalBtc(m), normalUsdc(m), disputeRefund(m), soldOut(m), risky(m), fraud(m), timelockT2(m)];

/** The scenarios with their texts in one language (built once per language; ids and steps are the same in all). */
const cache = new Map<Lang, Scenario[]>();
export function scenariosFor(lang: Lang): Scenario[] {
  let list = cache.get(lang);
  if (!list) {
    list = build(messagesFor(lang));
    cache.set(lang, list);
  }
  return list;
}

/** The scenarios in the page's current language. */
export const scenarios = (): Scenario[] => scenariosFor(getLang());

/** The scenarios in the page's language (re-renders on a switch). */
export const useScenarios = (): Scenario[] => scenariosFor(useLang());

export const DEFAULT_SCENARIO = 'normal-btc';

export const scenarioById = (id: string): Scenario => {
  const list = scenarios();
  return list.find((s) => s.id === id) ?? list[0];
};
