/**
 * Timeline lines of @proxy-shopping/core. UserClient and EscrowClient record `{ kind, text }` with Japanese
 * text; the page renders each line from its kind in the current language (the catalogs' `timeline`), taking
 * only the values (txids, amounts, claims, other parties' free text) out of core's text. A known kind whose text
 * is not recognised renders as `timeline.other`; an unknown kind keeps core's original text.
 */
import type { TimelineEntry } from '@proxy-shopping/core/browser';
import type { Messages } from './ja';

/** A rendered line: our words, then (optionally) a value that is data, not UI copy (shown as-is, i18n-exempt), then our words again. */
export interface TimelineLine {
  text: string;
  data?: string;
  tail?: string;
  /** Core's original text of a kind this demo does not know. */
  original?: boolean;
}

/** Kinds core writes (MSG.* message types plus the clients' own). */
const KNOWN_KINDS = new Set([
  'order.request', 'order.quote', 'order.accept', 'order.cancel', 'order.escrow_key', 'order.funded', 'escrow.notice',
  'order.purchased', 'order.shipping', 'order.release', 'order.refund', 'order.completed', 'dispute.open',
  'dispute.evidence_request', 'dispute.evidence', 'dispute.ruling', 'dispute.countersigned', 'report', 'chat', 'attachment',
  'refund', 'obligation', 'case', 'conflict', 'delivery', 'ack',
]);

type T = Messages['timeline'];
type Rule = [RegExp, (t: T, m: RegExpMatchArray, who: (w: string) => string) => TimelineLine];

const line = (text: string, data?: string, tail?: string): TimelineLine => ({ text, data, tail });

// Order matters only where one pattern is a prefix of another.
const RULES: Rule[] = [
  // UserClient
  [/^注文を依頼しました$/, (t) => line(t.requested)],
  [/^見積を承諾しました（確認済み: ([\s\S]*)）$/, (t, m) => line(t.acceptedAck(m[1]))],
  [/^見積を承諾しました$/, (t) => line(t.accepted)],
  [/^取り消しました: ([\s\S]*?)(（shopper への通知は送れませんでした）)?$/, (t, m) => line(t.cancelled, m[1], m[2] ? t.cancelNotSent : undefined)],
  [/^shopper が取り消しました: ([\s\S]*)$/, (t, m) => line(t.shopperCancelled, m[1])],
  [/^shopper の取り消しを無視しました（入金後）$/, (t) => line(t.shopperCancelIgnored)],
  [/^入金しました \((.*)\)$/, (t, m) => line(t.funded(m[1]))],
  [/^中断した入金をチェーンで確認しました \((.*)\)$/, (t, m) => line(t.fundingRecovered(m[1]))],
  [/^受取を確認し、支払いに署名しました$/, (t) => line(t.released)],
  [/^紛争を申し立てました \((\S+)\)(?:（証拠は (\d+) 通に分けて送りました）)?$/, (t, m) => line(t.disputeOpened(m[1]) + (m[2] ? t.disputeSplit(m[2]) : ''))],
  [/^shopper が紛争を申し立てました \((\S+)\)$/, (t, m) => line(t.shopperDispute(m[1]))],
  [/^証拠を送りました$/, (t) => line(t.evidenceSent)],
  [/^大きすぎて証拠に入れられないメッセージが (\d+) 通ありました$/, (t, m) => line(t.evidenceSkipped(m[1]))],
  [/^裁定に連署して放送しました \((.*)\)$/, (t, m) => line(t.rulingCountersigned(m[1]))],
  [/^相手が裁定に連署したと報告しました \((.*)\)。チェーンで確かめます$/, (t, m) => line(t.peerCountersigned(m[1]))],
  [/^裁定の精算をチェーンで確認しました \((.*)\)$/, (t, m) => line(t.settledOnChain(m[1]))],
  [/^チェーンの確認に失敗: ([\s\S]*)$/, (t, m) => line(t.chainCheckFailed, m[1])],
  [/^shopper の払い戻しに連署しました \((.*)\)$/, (t, m) => line(t.refundCountersigned(m[1]))],
  [/^shopper の払い戻しの提案を検証できませんでした: ([\s\S]*)$/, (t, m) => line(t.refundOfferInvalid, m[1])],
  [/^shopper が払い戻しを提案しています。内容を確かめて連署してください$/, (t) => line(t.refundOffered)],
  [/^返金をチェーンで確認しました \((.*)\)$/, (t, m) => line(t.refundedOnChain(m[1]))],
  [/^T2 経過後の返金を放送しました \((.*)\)$/, (t, m) => line(t.t2Refund(m[1]))],
  [/^オペレータに通報しました$/, (t) => line(t.reported)],
  [/^送信: ([\s\S]*)$/, (t, m) => line(t.chatSent, m[1])],
  [/^(shopper|escrow): ([\s\S]*)$/, (t, m, who) => line(t.chatFrom(who(m[1])), m[2])],
  [/^購入されました \(店の注文番号 (.*)\)$/, (t, m) => line(t.purchased(m[1]))],
  [/^配送状況: (\S+)(?: \((.*)\))?$/, (t, m) => line(t.shipping(m[1], m[2]))],
  [/^shopper が完了を報告しました \((.*)\)。チェーンで確かめます$/, (t, m) => line(t.shopperCompleted(m[1]))],
  [/^完了をチェーンで確認しました \((.*)\)$/, (t, m) => line(t.completedOnChain(m[1]))],
  [/^escrow が証拠を求めています: (.*)$/, (t, m) => line(t.evidenceRequested(m[1]))],
  [/^2 回目の裁定は無視しました$/, (t) => line(t.secondRuling)],
  [/^紛争を知る前に裁定が届きました。紛争を確かめられるまで保留します$/, (t) => line(t.rulingHeld)],
  [/^裁定: user (\S+) \/ shopper (\S+) — ([\s\S]*)$/, (t, m) => line(t.ruling(m[1], m[2]), m[3])],
  [/^受信: (.*)$/, (t, m) => line(t.received(m[1]))],
  [/^断られました: (\S*) ?([\s\S]*)$/, (t, m) => line(t.rejected(m[1]), m[2].trim() || undefined)],
  [
    /^見積を受け取りました \((\S+) (\S+)\)( — 検証に失敗)?(?: — レート注意 (\S+))?$/,
    (t, m) => line(t.quoteReceived(m[1], m[2]) + (m[3] ? t.quoteCheckFailed : '') + (m[4] ? t.rateWarning(m[4]) : '')),
  ],
  // EscrowClient
  [/^前払い手数料を確認しました$/, (t) => line(t.feeConfirmed)],
  [/^前払い手数料なし: ([\s\S]*)$/, (t, m) => line(t.noFee, m[1])],
  [/^証拠を求めました: (.*)$/, (t, m) => line(t.evidenceAsked(m[1]))],
  [/^裁定しました: user (\S+) \/ shopper (\S+) \/ fee (\S+)$/, (t, m) => line(t.ruled(m[1], m[2], m[3]))],
  [/^(\S+) が紛争を申し立てました: ([\s\S]*)$/, (t, m, who) => line(t.partyDispute(who(m[1])), m[2])],
  [/^(\S+) から証拠を受け取りました$/, (t, m, who) => line(t.partyEvidence(who(m[1])))],
  [/^(\S+) が連署を報告しました \((.*)\)。チェーンで確かめます$/, (t, m, who) => line(t.partyCountersigned(who(m[1]), m[2]))],
  [/^入金の通知の署名や差出人が合わないので無視しました$/, (t) => line(t.noticeIgnored)],
  [/^入金の通知を受けました$/, (t) => line(t.noticeReceived)],
  [/^request (\S+) の入金をチェーンで確かめ、案件を開きました$/, (t, m) => line(t.caseOpened(m[1]))],
  [/^(\S+) の届け先の鍵は request の SHA-256 と合わないので捨てました$/, (t, m, who) => line(t.deliveryKeyRejected(who(m[1])))],
  [/^(\S+) の添付 (\S+) はハッシュが一致しないので捨てました$/, (t, m, who) => line(t.attachmentRejected(who(m[1]), m[2]))],
  [/^(\S+) から添付 (\S+)（(\d+) byte）を受け取りました$/, (t, m, who) => line(t.attachmentReceived(who(m[1]), m[2], m[3]))],
  [/^精算をチェーンで確認しました \((.*)\)$/, (t, m) => line(t.caseSettled(m[1]))],
];

export function timelineLine(entry: Pick<TimelineEntry, 'kind' | 'text'>, m: Messages): TimelineLine {
  const t = m.timeline;
  const who = (w: string) => (t.who as Record<string, string>)[w] ?? w;
  // EscrowClient's conflicts are core's own (English) descriptions of what it ignored.
  if (entry.kind === 'conflict') return line('', entry.text);
  for (const [re, render] of RULES) {
    const match = entry.text.match(re);
    if (match) return render(t, match, who);
  }
  if (KNOWN_KINDS.has(entry.kind)) return line(t.other(entry.kind, entry.text));
  return { text: entry.text, original: true };
}
