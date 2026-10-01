/**
 * What the rest of core needs from the libp2p side (§4.2, §10), without importing libp2p: the Messenger sends wraps
 * through a `WrapCarrier`, the Session wires a `P2PService` to the trust directory. The implementation is
 * `P2PNode` in `@proxy-shopping/core/p2p`.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import type { P2PAddr } from '../trust/types.js';

export type { P2PAddr };

/** Stream protocols and topics of §10. */
export const PROTO_MSG = '/ps/msg/1.0.0';
export const PROTO_TRUST_SYNC = '/ps/trust-sync/1.0.0';
export const PROTO_STATUS = '/ps/status/1.0.0';
export const topicTrust = (network: string): string => `/ps/${network}/trust/1`;
export const topicProfiles = (network: string): string => `/ps/${network}/profiles/1`;

/** §10: one wrap per /ps/msg stream, newline terminated, at most 64 KiB. */
export const MAX_MSG_BYTES = 64 * 1024;
/** §4.2: the receiver has 10 s to answer {"ok": true}. */
export const MSG_TIMEOUT_MS = 10_000;

export interface WrapReply {
  ok: boolean;
  error?: string;
}

/** Sends gift wraps over /ps/msg/1.0.0. */
export interface WrapCarrier {
  /** Resolves true when the receiver answered {"ok": true} within the budget; never throws. */
  sendWrap(target: P2PAddr, wrap: NostrEvent, opts?: { timeoutMs?: number }): Promise<boolean>;
}

export type GossipVerdict = 'accept' | 'ignore' | 'reject';

export interface P2PStatus {
  running: boolean;
  /** Why P2P is not running (disabled, unsupported environment, start failed). */
  reason?: string;
  peerId?: string;
  /** Our addresses with /p2p/<id>, the /p2p-circuit ones of our relay reservations included. */
  addrs: string[];
  circuitAddrs: string[];
  relays: Array<{ addr: string; peerId: string; connected: boolean; reserved: boolean }>;
  peers: number;
  /** Gossip messages received on our topics, and events received by trust-sync. */
  gossipReceived: number;
  syncReceived: number;
  messagesSent: number;
  messagesReceived: number;
  webrtc: boolean;
  lastError?: string;
}

export type P2PEvents = {
  /** Our addresses changed (a reservation was made, renewed elsewhere or lost). */
  addrs: P2PAddr;
  status: P2PStatus;
};

/** The P2P node as the Session sees it. */
export interface P2PService extends WrapCarrier {
  readonly peerId: string;
  /** Our destination (§10): peer ID and addresses, circuit addresses included. */
  self(): P2PAddr;
  status(): P2PStatus;
  /** Gossip a signed event on the topic of its kind (§10). */
  publish(event: NostrEvent): Promise<void>;
  /** Incoming /ps/msg wraps. */
  onWrap(fn: (wrap: NostrEvent) => Promise<WrapReply>): void;
  /** Gossip and trust-sync events, after the validator accepted them (batches for trust-sync). */
  onEvents(fn: (events: NostrEvent[], source: 'gossip' | 'sync') => void): void;
  /** How gossip is validated: verified and in scope → accept; valid but not ours → ignore. */
  setValidator(fn: (event: NostrEvent) => GossipVerdict): void;
  /** What we hand out on /ps/trust-sync. */
  setSyncSource(fn: () => NostrEvent[]): void;
  /** Extra dial / reservation targets (§2.3 p2p_relays of the lists in use). */
  addRelays(addrs: string[]): void;
  on<K extends keyof P2PEvents>(type: K, fn: (v: P2PEvents[K]) => void): () => void;
  stop(): Promise<void>;
}
