import {
  ChainlinkSource, CoingeckoSource, CoordinatorClient, deploymentsSchema, EscrowClient, EsploraClient, EvmClient, FrankfurterSource,
  IndexedDBStorage, KeySet, Nip07Signer, OperatorClient, PoolTransport, Session, ShopperProfile, StaticSource,
  UserClient, type Deployments, type Nip07Provider, type RateSource,
} from '@proxy-shopping/core/browser';
import { configProblems, type AppConfig, type RateSourceConfig } from './config';
import { identityDbName, type Identity } from './identity';

export interface Runtime {
  config: AppConfig;
  keys: KeySet;
  pubkey: string;
  dbName: string;
  session: Session;
  user: UserClient;
  escrow: EscrowClient;
  operator: OperatorClient;
  coordinator: CoordinatorClient;
  shopper: ShopperProfile;
  deployments?: Deployments;
  deploymentsError?: string;
  stop(): void;
}

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

async function loadDeployments(url: string): Promise<Deployments> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`deployments: HTTP ${res.status}`);
  // The URL is configurable: never trust its shape (addresses are cross-checked with the operator list later).
  return deploymentsSchema(await res.json(), 'deployments');
}

function rateSources(cfg: RateSourceConfig[], evm?: EvmClient, d?: Deployments): RateSource[] {
  const out: RateSource[] = [];
  for (const r of cfg) {
    if (r.type === 'frankfurter' && r.base) out.push(new FrankfurterSource(r.base, ['JPY']));
    else if (r.type === 'coingecko' && r.base) out.push(new CoingeckoSource(r.base));
    else if (r.type === 'chainlink' && evm && d?.feeds) out.push(new ChainlinkSource(evm.public, d.feeds));
    else if (r.type === 'static' && r.rates) out.push(new StaticSource(r.rates));
  }
  return out;
}

/** Build and start a session with every role client attached. */
export async function createRuntime(config: AppConfig, identity: Identity): Promise<Runtime> {
  const problems = configProblems(config);
  if (problems.length) throw new Error(`設定の接続先が不正です: ${problems.join('; ')}`);
  const keys = KeySet.fromMnemonic(identity.mnemonic);
  if (identity.useNip07 && !window.nostr) {
    // Never fall back silently to the mnemonic's key: the user expects a different identity.
    throw new Error('NIP-07 拡張（window.nostr）が見つかりません。拡張を有効にするか、設定で鍵を作り直してください');
  }
  const signer = identity.useNip07 && window.nostr ? new Nip07Signer(window.nostr) : undefined;
  const pubkey = signer ? await signer.getPublicKey() : keys.nostrPublicKey;
  const dbName = identityDbName(pubkey);
  const storage = await IndexedDBStorage.open(dbName);

  let deployments: Deployments | undefined;
  let deploymentsError: string | undefined;
  try {
    deployments = config.deployments_url ? await loadDeployments(config.deployments_url) : undefined;
    if (deployments && deployments.chain_id !== config.chain_id) {
      throw new Error(`deployments chain_id ${deployments.chain_id} != configured ${config.chain_id}`);
    }
  } catch (err) {
    deployments = undefined;
    deploymentsError = (err as Error).message;
  }
  const evm = deployments && config.evm_rpc ? new EvmClient(config.chain_id, config.evm_rpc, keys.evmAccount, deployments) : undefined;
  const chain = config.esplora ? new EsploraClient(config.esplora) : undefined;

  const session = new Session({
    keys,
    signer,
    transport: new PoolTransport(),
    storage,
    config: {
      network: config.network, relays: config.relays, coordinators: config.coordinators,
      timelockPolicy: config.timelock_policy, allowPrivateEndpoints: !!config.allow_private_endpoints, maxFeeRate: config.max_fee_rate,
      maxClockSkewSeconds: config.max_clock_skew_seconds,
    },
    chain,
    evm,
    rates: rateSources(config.rates, evm, deployments),
  });
  const user = new UserClient(session, { deployments }).attach();
  const escrow = new EscrowClient(session, { deployments }).attach();
  const operator = new OperatorClient(session).attach();
  await session.start();
  // Let peers find our inbox relays, and warm the trust view; neither blocks the UI.
  void session.publishInboxRelays().catch((e) => console.warn('publish 10050 failed', e));
  void session.directory.refresh().catch((e) => console.warn('trust refresh failed', e));

  return {
    config, keys, pubkey, dbName, session, user, escrow, operator,
    coordinator: new CoordinatorClient(session),
    shopper: new ShopperProfile(session),
    deployments, deploymentsError,
    stop: () => {
      user.detach();
      escrow.detach();
      operator.detach();
      session.stop();
      session.transport.close();
      storage.close();
    },
  };
}
