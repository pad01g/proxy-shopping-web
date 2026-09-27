import type { ChainApi } from '../btc/esplora.js';
import type { EvmClient } from '../evm/chain.js';
import { CoordinatorClient } from '../flows/coordinator.js';
import { EscrowClient } from '../flows/escrow.js';
import { OperatorClient } from '../flows/operator.js';
import { Session } from '../flows/session.js';
import { ShopperProfile } from '../flows/shopper-profile.js';
import { UserClient } from '../flows/user.js';
import { StaticSource } from '../fx/sources.js';
import { KeySet } from '../keys/derive.js';
import type { NostrTransport } from '../nostr/transport.js';
import { MemoryStorage } from '../storage/memory.js';
import type { TimelockPolicy } from '../flows/timelock-policy.js';
import { FakeShopper, type FakeShopperOptions } from './fake-shopper.js';

/** Lab mnemonics from docs/lab.md (test-only keys). */
export const LAB_MNEMONICS = {
  'coordinator-1': 'pizza champion puzzle wrestle curtain galaxy vendor pluck town mixture original gorilla',
  'operator-1': 'donkey burger catch disease lens parrot visa manage explain corn million toast',
  'shopper-1': 'december art feature luxury renew grape champion meadow wage weird aunt unaware',
  'escrow-1': 'blue salt fault plastic fault bargain word lady icon actual speed reflect',
  'user-1': 'news hybrid corn purchase public hedgehog clay survey able alter supreme shove',
  faucet: 'defense girl explain south shine scissors view soup code talk fence town',
} as const;

export type LabName = keyof typeof LAB_MNEMONICS;

type Role = 'coordinator-1' | 'operator-1' | 'shopper-1' | 'escrow-1' | 'user-1';
const ROLES: Role[] = ['coordinator-1', 'operator-1', 'shopper-1', 'escrow-1', 'user-1'];

export interface WorldOptions {
  relays: string[];
  transport: (name: Role) => NostrTransport;
  chain?: ChainApi;
  evm?: (keys: KeySet) => EvmClient;
  shopper?: Partial<FakeShopperOptions>;
  retryIntervalMs?: number;
  /** The user's timelock policy; defaults to the lab's short one (LAB_TIMELOCK_POLICY). */
  timelockPolicy?: TimelockPolicy;
  /** How often user / escrow re-check settlement claims on chain (ms). */
  chainPollMs?: number;
}

/** `timelock_policy` of the lab web config (proxy-shopping-go/lab/web-config.json). */
export const LAB_TIMELOCK_POLICY: TimelockPolicy = {
  btc_min_t1_blocks: 50,
  evm_min_t1_seconds: 1800,
  btc_min_gap_blocks: 20,
  evm_min_gap_seconds: 1800,
  btc_max_t2_blocks: 1000,
  evm_max_t2_seconds: 86400,
};

/**
 * A complete trust setup (coordinator → operator → list with shopper × escrow)
 * plus running user / escrow / fake shopper clients. Used by flow tests.
 */
export async function createWorld(o: WorldOptions) {
  const network = 'ps-lab';
  const keys = Object.fromEntries(ROLES.map((n) => [n, KeySet.fromMnemonic(LAB_MNEMONICS[n])])) as Record<Role, KeySet>;
  const coordinatorPk = keys['coordinator-1'].nostrPublicKey;
  const session = (name: Role) =>
    new Session({
      keys: keys[name],
      transport: o.transport(name),
      storage: new MemoryStorage(),
      config: {
        network, relays: o.relays, coordinators: [coordinatorPk], retryIntervalMs: o.retryIntervalMs ?? 1000,
        timelockPolicy: o.timelockPolicy ?? LAB_TIMELOCK_POLICY, allowPrivateEndpoints: true,
      },
      chain: o.chain,
      evm: o.evm?.(keys[name]),
      rates: [new StaticSource({ 'BTC/USD': 100000, 'USD/JPY': 150, 'USDC/USD': 1 })],
    });
  const sessions = Object.fromEntries(ROLES.map((n) => [n, session(n)])) as Record<Role, Session>;

  await new CoordinatorClient(sessions['coordinator-1']).delegate(keys['operator-1'].nostrPublicKey, 'lab');
  const operator = new OperatorClient(sessions['operator-1']).attach();
  const content = await operator.draft('Kanto operator');
  await operator.publish({
    ...content,
    regions: ['JP-13'],
    entries: [{
      region: 'JP-13',
      shopper: keys['shopper-1'].nostrPublicKey,
      escrow: keys['escrow-1'].nostrPublicKey,
      shops: ['*'],
      payments: ['btc-signet', 'usdc-evm'],
      tags: [],
      escrow_sla_days: 14,
    }],
  });
  const shopperProfile = new ShopperProfile(sessions['shopper-1']);
  await shopperProfile.publish(shopperProfile.withOwnAddresses({
    name: 'shopper-1', payments: ['btc-signet', 'usdc-evm'], currencies: ['JPY'], cash_regions: ['JP-27'],
    fee: { bps: 500, min: { amount: '300', currency: 'JPY' } }, delivery_days: 5,
  }));
  const escrow = new EscrowClient(sessions['escrow-1'], { chainPollMs: o.chainPollMs ?? 500 }).attach();
  await escrow.publishProfile({ name: 'escrow-1', upfront_fee: { bps: 50, min_sats: '1000', min_usdc: '0.50' }, dispute_fee_bps: 200 });

  const shopper = new FakeShopper(sessions['shopper-1'], {
    catalog: { 'A-100': 3200, 'A-200': 12000 },
    shippingJpy: 800,
    rates: { 'btc-signet': 15_000_000, 'usdc-evm': 150 },
    escrowUpfrontFee: { 'btc-signet': 1000n, 'usdc-evm': 500_000n },
    ...o.shopper,
  });
  const user = new UserClient(sessions['user-1'], { chainPollMs: o.chainPollMs ?? 500 }).attach();

  for (const s of Object.values(sessions)) await s.start();
  await sessions['shopper-1'].directory.refresh();

  return {
    keys, sessions, user, escrow, operator, shopper,
    stop: () => {
      user.detach();
      escrow.detach();
      Object.values(sessions).forEach((s) => { s.stop(); s.transport.close(); });
    },
  };
}
