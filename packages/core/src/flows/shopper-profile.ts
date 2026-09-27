import { KIND } from '../nostr/kinds.js';
import { shopperProfileTemplate } from '../trust/events.js';
import type { ShopperProfileContent } from '../trust/types.js';
import type { Session } from './session.js';

/**
 * Build, sign and publish a shopper profile (kind 30502). The shopper engine
 * itself runs in Go; this lets a shopper manage its profile from the browser.
 */
export class ShopperProfile {
  constructor(private readonly s: Session) {}

  /** Fill key-derived fields (payout addresses) from the session keys. */
  withOwnAddresses(content: Omit<ShopperProfileContent, 'btc_address' | 'evm_address'> & Partial<ShopperProfileContent>): ShopperProfileContent {
    return {
      ...content,
      btc_address: content.btc_address ?? this.s.keys.btcWallet.address,
      evm_address: content.evm_address ?? this.s.keys.evmAddress,
    };
  }

  async current(): Promise<ShopperProfileContent | undefined> {
    const ev = await this.s.ownLatest(KIND.shopperProfile, this.s.network);
    return ev ? (JSON.parse(ev.content) as ShopperProfileContent) : undefined;
  }

  async publish(content: ShopperProfileContent) {
    const v = await this.s.nextVersion(KIND.shopperProfile, this.s.network);
    const res = await this.s.publishOwn(shopperProfileTemplate(content, this.s.network, v));
    await this.s.publishInboxRelays();
    return res;
  }
}
