import type { OrderPreset } from './types';

/** The lab's fake shops (docs/lab.md「店の商品」). */
export const SHOP_PRESETS: OrderPreset[] = [
  { id: 'safe-a100', label: 'safe-shop A-100 抹茶ティーセット（3200 円）', shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', sku: 'A-100', payment: 'btc-signet' },
  { id: 'safe-fail', label: 'safe-shop FAIL-100 配送に失敗する商品（2000 円）', shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', sku: 'FAIL-100', payment: 'btc-signet' },
  { id: 'safe-soldout', label: 'safe-shop SOLDOUT-100 在庫切れの商品（2500 円）', shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', sku: 'SOLDOUT-100', payment: 'btc-signet' },
  { id: 'us-u100', label: 'us-shop U-100 Coffee beans 1kg（25.00 USD）', shopUrl: 'https://us-shop.test/', region: 'US', sku: 'U-100', payment: 'usdc-evm' },
  { id: 'risky-r100', label: 'risky-shop R-100 安すぎるヘッドホン（9.99 USD, HTTP のみ）', shopUrl: 'http://risky-shop.test/', region: 'US', sku: 'R-100', payment: 'btc-signet' },
  { id: 'cash-c100', label: 'cash-store C-100 店頭限定の和菓子（1500 円, 現金のみ）', shopUrl: 'https://cash-store.test/', region: 'JP-13-13104', sku: 'C-100', payment: 'btc-signet' },
];

export const REGION_PRESETS: Array<{ code: string; label: string }> = [
  { code: 'JP-13-13104', label: '東京都新宿区' },
  { code: 'JP-13', label: '東京都' },
  { code: 'US', label: '米国' },
  { code: 'JP-27-27100', label: '大阪市' },
];

export const DEMO_ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };

export const preset = (id: string): OrderPreset => {
  const p = SHOP_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset ${id}`);
  return p;
};
