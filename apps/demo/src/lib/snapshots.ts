/**
 * What each role shows the others. A role runs in one window only; it writes a small summary of its state
 * to localStorage after every change, and every window (its own included) builds the guide from these.
 * Amounts are decimal strings of base units (sats, USDC 6 decimals, wei).
 */
import type { DisputeOpen, Payment, UserOrderStatus } from '@proxy-shopping/core/browser';
import type { SessionRole } from './roles';
import { onOtherWindowChange, readJson, writeJson } from './storage';

export interface Split {
  user: string;
  shopper: string;
  fee: string;
}

export interface OrderSnap {
  id: string;
  status: UserOrderStatus;
  createdAt: number;
  shopUrl: string;
  region: string;
  sku: string;
  payment: Payment;
  shopper: string;
  escrow: string;
  rejectReason?: string;
  quoteOk?: boolean;
  /** The quote needs an explicit acknowledgement (rate deviation). */
  ackRequired: boolean;
  lockAmount?: string;
  payoutFeeReserve?: string;
  t2?: number;
  funded: boolean;
  dispute?: DisputeOpen['claim'];
  ruling?: Split;
  refundOffer?: { problems: number };
  /** A payout waiting for the chain; `mine` when we broadcast it ourselves. */
  pendingSettlement?: { kind: 'completed' | 'settled' | 'refunded'; mine: boolean };
  completedTxid?: string;
  settledTxid?: string;
  refundTxid?: string;
  reported: boolean;
  lastError?: string;
}

export interface UserSnap {
  at: number;
  btcSats?: string;
  usdc?: string;
  eth?: string;
  orders: OrderSnap[];
  /** The last search for shopper × escrow candidates (ms timestamp). */
  offers?: { at: number; list: Array<{ region: string; shopper: string; escrow: string; operator: string; listVersion: number }> };
}

export interface CaseSnap {
  orderId: string;
  status: string;
  disputes: number;
  decrypted: boolean;
  ruling?: Split;
  settledTxid?: string;
}

export interface EscrowSnap {
  at: number;
  profile?: { bps: number; disputeBps: number };
  cases: CaseSnap[];
}

export interface OperatorSnap {
  at: number;
  list?: { version: number; entries: Array<{ region: string; shopper: string; escrow: string; payments: Payment[] }> };
  reports: Array<{ id: string; subject: string; orderId: string; at: number }>;
}

export interface CoordinatorSnap {
  at: number;
  delegations: Array<{ operator: string; version: number; revoked: boolean }>;
}

export interface Snapshots {
  user?: UserSnap;
  escrow?: EscrowSnap;
  operator?: OperatorSnap;
  coordinator?: CoordinatorSnap;
}

export type RoleSnap<R extends SessionRole> = NonNullable<Snapshots[R]>;

const key = (role: SessionRole) => `snap.${role}`;

export function readSnapshots(): Snapshots {
  return {
    user: readJson<UserSnap>(key('user')),
    escrow: readJson<EscrowSnap>(key('escrow')),
    operator: readJson<OperatorSnap>(key('operator')),
    coordinator: readJson<CoordinatorSnap>(key('coordinator')),
  };
}

export function writeSnapshot<R extends SessionRole>(role: R, snap: RoleSnap<R>): void {
  writeJson(key(role), snap);
}

/** Calls `fn` when another window wrote a snapshot. */
export function onSnapshotChange(fn: () => void): () => void {
  return onOtherWindowChange((k) => (k === '*' || k.startsWith('snap.')) && fn());
}
