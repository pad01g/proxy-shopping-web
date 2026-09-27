import {
  ChainlinkSource, CoingeckoSource, CoordinatorClient, EscrowClient, EsploraClient, EvmClient, FrankfurterSource,
  IndexedDBStorage, KeySet, Nip07Signer, OperatorClient, PoolTransport, Session, ShopperProfile, StaticSource,
  UserClient, type Deployments, type Nip07Provider, type RateSource,
} from '@proxy-shopping/core/browser';
import type { AppConfig, RateSourceConfig } from './config';
import type { Identity } from './identity';

export interface Runtime {
  config: AppConfig;
  keys: KeySet;
  pubkey: string;
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
  return (await res.json()) as Deployments;
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
  const keys = KeySet.fromMnemonic(identity.mnemonic);
  const signer = identity.useNip07 && window.nostr ? new Nip07Signer(window.nostr) : undefined;
  const pubkey = signer ? await signer.getPublicKey() : keys.nostrPublicKey;
  // One database per identity so importing another mnemonic never mixes orders.
  const storage = await IndexedDBStorage.open(`proxy-shopping-${pubkey.slice(0, 16)}`);

  let deployments: Deployments | undefined;
  let deploymentsError: string | undefined;
  try {
    deployments = config.deployments_url ? await loadDeployments(config.deployments_url) : undefined;
  } catch (err) {
    deploymentsError = (err as Error).message;
  }
  const evm = deployments && config.evm_rpc ? new EvmClient(config.chain_id, config.evm_rpc, keys.evmAccount, deployments) : undefined;
  const chain = config.esplora ? new EsploraClient(config.esplora) : undefined;

  const session = new Session({
    keys,
    signer,
    transport: new PoolTransport(),
    storage,
    config: { network: config.network, relays: config.relays, coordinators: config.coordinators },
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
    config, keys, pubkey, session, user, escrow, operator,
    coordinator: new CoordinatorClient(session),
    shopper: new ShopperProfile(session),
    deployments, deploymentsError,
    stop: () => {
      session.stop();
      session.transport.close();
    },
  };
}
