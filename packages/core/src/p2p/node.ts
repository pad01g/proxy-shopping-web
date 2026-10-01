/**
 * The libp2p node of apps and browsers (§10): WSS to p2p relays, circuit relay v2 as a client (reservations, our
 * /p2p-circuit addresses), WebRTC where the environment has a working RTCPeerConnection, Noise, yamux, identify,
 * gossipsub on the trust and profile topics, and the /ps/msg and /ps/trust-sync stream protocols.
 * The peer key is the secp256k1 key at m/7333'/0'/0' (§1), so the peer ID is the Go node's for the same mnemonic.
 */
import { gossipsub, TopicValidatorResult, type GossipSub } from '@libp2p/gossipsub';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import type { Libp2p, PeerId, PrivateKey, Stream } from '@libp2p/interface';
import { noise } from '@libp2p/noise';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { webSockets } from '@libp2p/websockets';
import { yamux } from '@libp2p/yamux';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import type { NostrEvent } from 'nostr-tools/pure';
import { KIND } from '../nostr/kinds.js';
import { Emitter } from '../util/emitter.js';
import { isPrivateHost } from '../util/endpoint.js';
import { readSyncEvents, sendWrapOnStream, serveWrapStream, writeSyncEvents, type LineStream } from './framing.js';
import {
  MSG_TIMEOUT_MS, PROTO_MSG, PROTO_TRUST_SYNC, topicProfiles, topicTrust,
  type GossipVerdict, type P2PAddr, type P2PEvents, type P2PService, type P2PStatus, type WrapReply,
} from './types.js';

/** Like the Go node: 256 KiB per event, and a peer's gossip beyond 600 events a minute is ignored. */
const MAX_EVENT_BYTES = 256 * 1024;
const PEER_EVENTS_PER_MINUTE = 600;
/** trust-sync from one peer: at most this many events / bytes, and again only after 5 minutes. */
const MAX_SYNC_EVENTS = 5000;
const MAX_SYNC_BYTES = 16 * 1024 * 1024;
const RESYNC_MS = 5 * 60_000;
const RETRY_SYNC_MS = 20_000;
const SYNC_TIMEOUT_MS = 60_000;
const KEEP_CONNECTED_MS = 15_000;
/** Peer-supplied addresses tried per send. */
const MAX_TARGET_ADDRS = 8;
const MAX_RELAYS = 8;

const TRUST_KINDS: readonly number[] = [KIND.delegation, KIND.operatorList];
const PROFILE_KINDS: readonly number[] = [KIND.shopperProfile, KIND.escrowProfile, KIND.inboxRelays];

export interface P2PNodeOptions {
  /** 32-byte secp256k1 secret, `KeySet.libp2pSecretKey` (m/7333'/0'/0'). */
  secretKey: Uint8Array;
  network: string;
  /** p2p relays (§10 p2p.relays): dialled and asked for a reservation. Multiaddrs ending in /p2p/<id>. */
  relays?: string[];
  /** Other peers kept connected (§10 p2p.bootstrap). */
  bootstrap?: string[];
  /** WebRTC between apps through relays: 'auto' (default) uses it where RTCPeerConnection works. */
  webrtc?: boolean | 'auto';
  /** Lab only: dial private / loopback addresses. */
  allowPrivate?: boolean;
  /** Debug lines (connection changes, reservations, errors). */
  log?: (line: string) => void;
}

/** The libp2p private key of a mnemonic's key set (§1 m/7333'/0'/0'). */
export function libp2pPrivateKey(secretKey: Uint8Array): PrivateKey {
  if (secretKey.length !== 32) throw new Error('libp2p key must be 32 bytes (secp256k1)');
  return privateKeyFromRaw(secretKey);
}

/** The peer ID (16Uiu2…) of a 32-byte secp256k1 secret, as the Go node computes it. */
export function libp2pPeerId(secretKey: Uint8Array): string {
  return peerIdFromPrivateKey(libp2pPrivateKey(secretKey) as never).toString();
}

/** Is there an RTCPeerConnection that can make a data channel (old or stripped WebViews may not)? */
export function webRTCWorks(): boolean {
  const RTC = (globalThis as { RTCPeerConnection?: new (c?: unknown) => { createDataChannel(l: string): unknown; close(): void } }).RTCPeerConnection;
  if (typeof RTC !== 'function') return false;
  try {
    const pc = new RTC();
    pc.createDataChannel('probe');
    pc.close();
    return true;
  } catch {
    return false;
  }
}

function parseAddrs(list: string[] | undefined, what: string, log: (l: string) => void): Multiaddr[] {
  const out: Multiaddr[] = [];
  for (const s of list ?? []) {
    try {
      const ma = multiaddr(s.trim());
      if (!ma.getComponents().some((c) => c.name === 'p2p')) throw new Error('no /p2p/<peer id>');
      out.push(ma);
    } catch (err) {
      log(`${what} ${s}: ${(err as Error).message}`);
    }
  }
  return out;
}

const peerOf = (ma: Multiaddr): string | undefined => {
  const p2p = ma.getComponents().filter((c) => c.name === 'p2p');
  return p2p[p2p.length - 1]?.value;
};

type Services = { identify: unknown; pubsub: GossipSub };

/**
 * One running libp2p node. Create with `P2PNode.start`; wire into a Session with `session.attachP2P(node)`.
 */
export class P2PNode extends Emitter<P2PEvents> implements P2PService {
  readonly peerId: string;
  private readonly relays = new Map<string, Multiaddr>(); // peer id → configured address
  private readonly bootstrap: Multiaddr[];
  private readonly log: (l: string) => void;
  private validator: (e: NostrEvent) => GossipVerdict = () => 'accept';
  private syncSource: () => NostrEvent[] = () => [];
  private wrapHandler?: (wrap: NostrEvent) => Promise<WrapReply>;
  private eventHandlers: Array<(events: NostrEvent[], source: 'gossip' | 'sync') => void> = [];
  private readonly synced = new Map<string, number>();
  private readonly quota = new Map<string, { tokens: number; at: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private lastSelf = '';
  private counters = { gossipReceived: 0, syncReceived: 0, messagesSent: 0, messagesReceived: 0 };
  private lastError?: string;
  private stopped = false;

  private constructor(
    private readonly node: Libp2p<Services>,
    private readonly opts: P2PNodeOptions,
    readonly webrtc: boolean,
  ) {
    super();
    this.peerId = node.peerId.toString();
    this.log = opts.log ?? (() => undefined);
    for (const ma of parseAddrs(opts.relays, 'relay', this.log)) this.relays.set(peerOf(ma)!, ma);
    this.bootstrap = parseAddrs(opts.bootstrap, 'bootstrap', this.log);
  }

  static async start(opts: P2PNodeOptions): Promise<P2PNode> {
    const privateKey = libp2pPrivateKey(opts.secretKey);
    const useWebRTC = opts.webrtc === false ? false : webRTCWorks();
    const transports: unknown[] = [webSockets(), circuitRelayTransport({ reservationCompletionTimeout: 15_000 })];
    if (useWebRTC) {
      // Loaded only where it can run, so Node and old WebViews never pull it in.
      const { webRTC } = await import('@libp2p/webrtc');
      transports.push(webRTC());
    }
    const relayCount = Math.max(1, Math.min(2, (opts.relays ?? []).length));
    const node = await createLibp2p<Services>({
      privateKey,
      addresses: { listen: [...Array.from({ length: relayCount }, () => '/p2p-circuit'), ...(useWebRTC ? ['/webrtc'] : [])] },
      transports: transports as never,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: opts.allowPrivate ? { denyDialMultiaddr: () => false } : undefined,
      connectionManager: { maxConnections: 64 },
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
          fallbackToFloodsub: true,
          maxInboundDataLength: MAX_EVENT_BYTES + 4096,
        }) as never,
      },
    });
    const p = new P2PNode(node, opts, useWebRTC);
    await p.wire();
    return p;
  }

  private async wire(): Promise<void> {
    const n = this.node;
    const ps = n.services.pubsub;
    for (const topic of [topicTrust(this.opts.network), topicProfiles(this.opts.network)]) {
      ps.topicValidators.set(topic, (from, msg) => this.validate(topic, from, msg.data));
      ps.subscribe(topic);
    }
    ps.addEventListener('message', (evt) => {
      const msg = evt.detail;
      if (!this.isOurTopic(msg.topic)) return;
      const ev = this.parse(msg.data);
      if (!ev) return;
      this.counters.gossipReceived++;
      this.deliver([ev], 'gossip');
    });
    await n.handle(PROTO_MSG, (stream) => void this.serveMsg(stream), { runOnLimitedConnection: true, maxInboundStreams: 32 });
    await n.handle(PROTO_TRUST_SYNC, (stream) => void this.serveSync(stream), { runOnLimitedConnection: true, maxInboundStreams: 8 });
    n.addEventListener('peer:identify', (evt) => {
      const { peerId, protocols } = evt.detail;
      if (protocols.includes(PROTO_TRUST_SYNC)) void this.maybeSync(peerId);
    });
    const changed = () => this.changed();
    n.addEventListener('peer:connect', changed);
    n.addEventListener('peer:disconnect', changed);
    n.addEventListener('self:peer:update', changed);
    this.timer = setInterval(() => void this.keepConnected(), KEEP_CONNECTED_MS);
    void this.keepConnected();
  }

  private isOurTopic(topic: string): boolean {
    return topic === topicTrust(this.opts.network) || topic === topicProfiles(this.opts.network);
  }

  private parse(data: Uint8Array): NostrEvent | undefined {
    if (data.length > MAX_EVENT_BYTES) return undefined;
    try {
      const ev = JSON.parse(new TextDecoder().decode(data)) as NostrEvent;
      return ev && typeof ev === 'object' && typeof ev.kind === 'number' ? ev : undefined;
    } catch {
      return undefined;
    }
  }

  /** Like the Go validator: malformed or wrong topic → reject; over the peer's quota or out of scope → ignore. */
  private validate(topic: string, from: PeerId, data: Uint8Array): TopicValidatorResult {
    const ev = this.parse(data);
    if (!ev) return TopicValidatorResult.Reject;
    const want = TRUST_KINDS.includes(ev.kind) ? topicTrust(this.opts.network) : PROFILE_KINDS.includes(ev.kind) ? topicProfiles(this.opts.network) : '';
    if (want !== topic) return TopicValidatorResult.Reject;
    if (!this.allowFrom(from.toString())) return TopicValidatorResult.Ignore;
    let verdict: GossipVerdict;
    try {
      verdict = this.validator(ev);
    } catch {
      verdict = 'reject';
    }
    return verdict === 'accept' ? TopicValidatorResult.Accept : verdict === 'ignore' ? TopicValidatorResult.Ignore : TopicValidatorResult.Reject;
  }

  private allowFrom(peer: string): boolean {
    const now = Date.now();
    const rate = PEER_EVENTS_PER_MINUTE;
    const b = this.quota.get(peer) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    this.quota.delete(peer);
    this.quota.set(peer, b);
    if (this.quota.size > 1024) this.quota.delete(this.quota.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private deliver(events: NostrEvent[], source: 'gossip' | 'sync'): void {
    for (const fn of this.eventHandlers) {
      try {
        fn(events, source);
      } catch (err) {
        this.fail(err as Error);
      }
    }
  }

  private fail(err: Error): void {
    this.lastError = err.message;
    this.log(`error: ${err.message}`);
  }

  private async keepConnected(): Promise<void> {
    if (this.stopped) return;
    const targets = [...this.relays.values(), ...this.bootstrap];
    await Promise.all(targets.map(async (ma) => {
      const id = peerOf(ma);
      if (!id || id === this.peerId) return;
      const peer = peerIdFromString(id);
      if (this.node.getConnections(peer).length) {
        // identify triggers the first sync; this covers failed ones and the 5-minute resync (§2.6).
        const protos = await this.node.peerStore.get(peer).then((p) => p.protocols, () => [] as string[]);
        if (protos.includes(PROTO_TRUST_SYNC)) void this.maybeSync(peer);
        return;
      }
      try {
        await this.node.dial(ma, { signal: AbortSignal.timeout(10_000) });
        this.log(`connected to ${id}`);
      } catch (err) {
        this.fail(new Error(`dial ${ma.toString()}: ${(err as Error).message}`));
      }
    }));
    this.changed();
  }

  private async maybeSync(peer: PeerId): Promise<void> {
    const id = peer.toString();
    const last = this.synced.get(id) ?? 0;
    if (Date.now() - last < RESYNC_MS) return;
    this.synced.set(id, Date.now());
    if (this.synced.size > 1024) this.synced.delete(this.synced.keys().next().value!);
    try {
      const stream = await this.node.dialProtocol(peer, PROTO_TRUST_SYNC, { runOnLimitedConnection: true, signal: AbortSignal.timeout(15_000) });
      const events = await Promise.race([
        readSyncEvents(stream as unknown as LineStream, { maxEvents: MAX_SYNC_EVENTS, maxEventBytes: MAX_EVENT_BYTES, maxTotalBytes: MAX_SYNC_BYTES }),
        new Promise<NostrEvent[]>((_, reject) => setTimeout(() => reject(new Error('trust-sync timed out')), SYNC_TIMEOUT_MS)),
      ]).finally(() => stream.abort(new Error('done')));
      this.counters.syncReceived += events.length;
      this.log(`trust-sync from ${id}: ${events.length} events`);
      if (events.length) this.deliver(events, 'sync');
      this.changed();
    } catch (err) {
      // Try again soon (keepConnected asks again), not only after the full interval.
      this.synced.set(id, Date.now() - RESYNC_MS + RETRY_SYNC_MS);
      this.fail(new Error(`trust-sync from ${id}: ${(err as Error).message}`));
    }
  }

  private async serveSync(stream: Stream): Promise<void> {
    try {
      await writeSyncEvents(stream as unknown as LineStream, this.syncSource());
    } catch (err) {
      stream.abort(err as Error);
    }
  }

  private async serveMsg(stream: Stream): Promise<void> {
    const handler = this.wrapHandler;
    const reply = await serveWrapStream(stream as unknown as LineStream, async (wrap) => (handler ? handler(wrap) : { ok: false, error: 'no inbox' }));
    if (reply.ok) this.counters.messagesReceived++;
  }

  // ---------- P2PService ----------

  /** Circuit addresses we can hand out: configured relay address + /p2p-circuit, for relays holding our reservation. */
  private circuitAddrs(): string[] {
    const mine = this.node.getMultiaddrs().map((m) => m.toString());
    const out: string[] = [];
    for (const [id, ma] of this.relays) {
      if (!mine.some((a) => a.includes(`/p2p/${id}/p2p-circuit`))) continue;
      if (!this.node.getConnections(peerIdFromString(id)).length) continue;
      const base = ma.toString();
      out.push(`${base}/p2p-circuit/p2p/${this.peerId}`);
      if (this.webrtc) out.push(`${base}/p2p-circuit/webrtc/p2p/${this.peerId}`);
    }
    // Reservations on relays that are not configured (found through p2p_relays later) as libp2p reports them.
    for (const a of mine) {
      if (!a.includes('/p2p-circuit') || out.includes(a)) continue;
      const relay = /\/p2p\/([^/]+)\/p2p-circuit/.exec(a)?.[1];
      if (relay && this.relays.has(relay)) continue;
      const host = /^\/ip[46]\/([^/]+)/.exec(a)?.[1];
      if (!this.opts.allowPrivate && host && isPrivateHost(host)) continue;
      out.push(a);
    }
    return out;
  }

  self(): P2PAddr {
    return { peer_id: this.peerId, addrs: this.circuitAddrs() };
  }

  status(): P2PStatus {
    const circuits = this.circuitAddrs();
    const mine = this.node.getMultiaddrs().map((m) => m.toString());
    return {
      running: !this.stopped,
      peerId: this.peerId,
      addrs: circuits,
      circuitAddrs: circuits,
      relays: [...this.relays].map(([id, ma]) => ({
        addr: ma.toString(),
        peerId: id,
        connected: this.node.getConnections(peerIdFromString(id)).length > 0,
        reserved: mine.some((a) => a.includes(`/p2p/${id}/p2p-circuit`)),
      })),
      peers: this.node.getPeers().length,
      ...this.counters,
      webrtc: this.webrtc,
      lastError: this.lastError,
    };
  }

  private changed(): void {
    const self = JSON.stringify(this.self());
    if (self !== this.lastSelf) {
      this.lastSelf = self;
      this.emit('addrs', this.self());
    }
    this.emit('status', this.status());
  }

  async publish(event: NostrEvent): Promise<void> {
    const topic = TRUST_KINDS.includes(event.kind) ? topicTrust(this.opts.network) : PROFILE_KINDS.includes(event.kind) ? topicProfiles(this.opts.network) : undefined;
    if (!topic) throw new Error(`kind ${event.kind} is not gossiped`);
    const plain = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
    try {
      await this.node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(plain)));
    } catch (err) {
      // Duplicates (the same event gossiped again) are fine.
      if (!/duplicate/i.test((err as Error).message)) throw err;
    }
  }

  async sendWrap(target: P2PAddr, wrap: NostrEvent, opts: { timeoutMs?: number } = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? MSG_TIMEOUT_MS;
    const started = Date.now();
    try {
      const peer = peerIdFromString(target.peer_id);
      const addrs: Multiaddr[] = [];
      // §4.2: a trailing /p2p/<id> must be the target; no private / loopback IPs unless the lab allows them.
      for (const a of (target.addrs ?? []).slice(0, MAX_TARGET_ADDRS)) {
        try {
          let ma = multiaddr(a);
          const comps = ma.getComponents();
          const last = comps[comps.length - 1];
          if (last?.name === 'p2p' && last.value !== target.peer_id) continue;
          if (last?.name !== 'p2p') ma = ma.encapsulate(`/p2p/${target.peer_id}`);
          const first = ma.getComponents()[0];
          if (!this.opts.allowPrivate && (first?.name === 'ip4' || first?.name === 'ip6') && isPrivateHost(first.value ?? '')) continue;
          addrs.push(ma);
        } catch {
          /* skip */
        }
      }
      // Like the Go node: also try circuits through our own relays.
      for (const [id, ma] of this.relays) {
        if (this.node.getConnections(peerIdFromString(id)).length) addrs.push(ma.encapsulate(`/p2p-circuit/p2p/${target.peer_id}`));
      }
      if (addrs.length) await this.node.peerStore.merge(peer, { multiaddrs: addrs.map((m) => m.decapsulateCode(421)) });
      const signal = AbortSignal.timeout(timeoutMs);
      const stream = await this.node.dialProtocol(peer, PROTO_MSG, { runOnLimitedConnection: true, signal });
      const left = Math.max(1000, timeoutMs - (Date.now() - started));
      const reply = await sendWrapOnStream(stream as unknown as LineStream, wrap, left);
      if (reply.ok) this.counters.messagesSent++;
      else this.fail(new Error(`/ps/msg to ${target.peer_id}: ${reply.error ?? 'refused'}`));
      return reply.ok;
    } catch (err) {
      this.fail(new Error(`/ps/msg to ${target.peer_id}: ${(err as Error).message}`));
      return false;
    }
  }

  onWrap(fn: (wrap: NostrEvent) => Promise<WrapReply>): void {
    this.wrapHandler = fn;
  }

  onEvents(fn: (events: NostrEvent[], source: 'gossip' | 'sync') => void): void {
    this.eventHandlers.push(fn);
  }

  setValidator(fn: (event: NostrEvent) => GossipVerdict): void {
    this.validator = fn;
  }

  setSyncSource(fn: () => NostrEvent[]): void {
    this.syncSource = fn;
  }

  addRelays(addrs: string[]): void {
    let added = false;
    for (const ma of parseAddrs(addrs, 'p2p_relay', this.log)) {
      const id = peerOf(ma)!;
      if (this.relays.has(id) || this.relays.size >= MAX_RELAYS || id === this.peerId) continue;
      this.relays.set(id, ma);
      added = true;
    }
    if (added) void this.keepConnected();
  }

  /** Underlying libp2p node (tests, diagnostics). */
  get libp2p(): Libp2p<Services> {
    return this.node;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.node.stop();
    this.emit('status', this.status());
  }
}
