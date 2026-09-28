import type { Messages } from '../i18n';
import type { OrderPreset } from './types';

/** The lab's fake shops (docs/lab.md「店の商品」). Labels are in the catalogs (presets.shop / presets.item). */
export const SHOP_PRESETS: OrderPreset[] = [
  { id: 'safe-a100', shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', sku: 'A-100', payment: 'btc-signet' },
  { id: 'safe-fail', shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', sku: 'FAIL-100', payment: 'btc-signet' },
  { id: 'safe-soldout', shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', sku: 'SOLDOUT-100', payment: 'btc-signet' },
  { id: 'us-u100', shopUrl: 'https://us-shop.test/', region: 'US', sku: 'U-100', payment: 'usdc-evm' },
  { id: 'risky-r100', shopUrl: 'http://risky-shop.test/', region: 'US', sku: 'R-100', payment: 'btc-signet' },
  { id: 'cash-c100', shopUrl: 'https://cash-store.test/', region: 'JP-13-13104', sku: 'C-100', payment: 'btc-signet' },
];

export type PresetId = keyof Messages['presets']['shop'];

/** Region codes offered in the order form (names in presets.region). */
export const REGION_PRESETS = ['JP-13-13104', 'JP-13', 'US', 'JP-27-27100'] as const;

export const preset = (id: PresetId): OrderPreset => {
  const p = SHOP_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset ${id}`);
  return p;
};
