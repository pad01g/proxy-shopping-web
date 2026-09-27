import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import type { ChainApi } from '../btc/esplora.js';
import type { EvmClient } from '../evm/chain.js';
import type { RateSource } from '../fx/types.js';
import type { KeySet } from '../keys/derive.js';
import { LocalSigner, type IdentitySigner } from '../keys/signer.js';
import { tagValue } from '../nostr/kinds.js';
import { Messenger } from '../nostr/messenger.js';
import { unique, type NostrTransport, type PublishResult } from '../nostr/transport.js';
import { ScopedStorage, type Storage } from '../storage/types.js';
import { TrustDirectory } from '../trust/directory.js';
import { verified } from '../trust/events.js';
import { latestByAddress, eventVersion } from '../trust/versions.js';

export interface SessionConfig {
  network: string;
  relays: string[];
  /** Trusted coordinators, highest priority first (§2.4). */
  coordinators: string[];
  /** Minimum relays per message (§4.2). */
  k?: number;
  retryIntervalMs?: number;
}

export interface SessionOptions {
  keys: KeySet;
  /** Identity signer; defaults to the mnemonic's NIP-06 key. Pass a Nip07Signer to use an extension. */
  signer?: IdentitySigner;
  transport: NostrTransport;
  storage: Storage;
  config: SessionConfig;
  /** Esplora-compatible BTC chain API (needed for btc-signet orders). */
  chain?: ChainApi;
  /** EVM client for this participant (needed for usdc-evm orders). */
  evm?: EvmClient;
  rates?: RateSource[];
}

/**
 * Everything a role client needs: keys, identity, relays, trust directory,
 * chain access. One session can host several role clients at once.
 */
export class Session {
  readonly keys: KeySet;
  readonly signer: IdentitySigner;
  readonly transport: NostrTransport;
  readonly storage: Storage;
  readonly messenger: Messenger;
  readonly directory: TrustDirectory;
  chain?: ChainApi;
  evm?: EvmClient;
  rates: RateSource[];
  private cfg: SessionConfig;
  private pubkeyValue?: string;

  constructor(opts: SessionOptions) {
    this.keys = opts.keys;
    this.signer = opts.signer ?? new LocalSigner(opts.keys.nostrSecretKey);
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.chain = opts.chain;
    this.evm = opts.evm;
    this.rates = opts.rates ?? [];
    this.cfg = { ...opts.config, relays: unique(opts.config.relays) };
    this.messenger = new Messenger({
      signer: this.signer,
      transport: this.transport,
      storage: new ScopedStorage(this.storage, 'msg/'),
      relays: this.cfg.relays,
      k: this.cfg.k,
      retryIntervalMs: this.cfg.retryIntervalMs,
    });
    this.directory = new TrustDirectory({
      transport: this.transport,
      storage: this.storage,
      network: this.cfg.network,
      relays: () => this.cfg.relays,
      coordinators: () => this.cfg.coordinators,
    });
  }

  get config(): SessionConfig {
    return this.cfg;
  }

  get network(): string {
    return this.cfg.network;
  }

  /** Update relays/coordinators at runtime (settings screen). */
  updateConfig(patch: Partial<SessionConfig>): void {
    this.cfg = { ...this.cfg, ...patch, relays: unique(patch.relays ?? this.cfg.relays) };
    if (patch.relays) this.messenger.setRelays(this.cfg.relays);
  }

  async pubkey(): Promise<string> {
    return (this.pubkeyValue ??= await this.signer.getPublicKey());
  }

  async start(): Promise<void> {
    await this.directory.load();
    await this.messenger.start();
  }

  stop(): void {
    this.messenger.stop();
  }

  async sign(template: EventTemplate): Promise<NostrEvent> {
    return this.signer.signEvent(template);
  }

  async publish(event: NostrEvent, relays = this.cfg.relays): Promise<PublishResult> {
    return this.transport.publish(relays, event);
  }

  /** Our own latest addressable event of `kind` with `d`, looked up on relays and in local storage. */
  async ownLatest(kind: number, d: string): Promise<NostrEvent | undefined> {
    const me = await this.pubkey();
    const local = (await this.storage.get<NostrEvent[]>(`own/${kind}/${d}`)) ?? [];
    const remote = await this.transport.query(this.cfg.relays, { kinds: [kind], authors: [me], '#d': [d] });
    const all = [...local, ...remote].filter((e) => e.pubkey === me && tagValue(e.tags, 'd') === d && verified(e));
    return latestByAddress(all)[0];
  }

  /** Next version for our own event (§2.1: versions only grow). */
  async nextVersion(kind: number, d: string): Promise<number> {
    const cur = await this.ownLatest(kind, d);
    return cur ? eventVersion(cur) + 1 : 1;
  }

  /** Sign, remember and publish one of our addressable events. */
  async publishOwn(template: EventTemplate): Promise<{ event: NostrEvent; result: PublishResult }> {
    const event = await this.sign(template);
    const d = tagValue(event.tags, 'd') ?? '';
    const key = `own/${event.kind}/${d}`;
    const local = (await this.storage.get<NostrEvent[]>(key)) ?? [];
    await this.storage.put(key, latestByAddress([...local, event]));
    const result = await this.publish(event);
    return { event, result };
  }

  async publishInboxRelays(): Promise<NostrEvent> {
    return this.messenger.publishInboxRelays();
  }
}

