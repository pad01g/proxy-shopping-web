import type { Payment } from '@proxy-shopping/core/browser';
import type { UserRuntime } from '../../lib/runtimes/user';
import { every, useLive } from '../../state';

/** Current tip height (BTC) or chain time (USDC), refreshed every 3 s (the lab mines and warps time on demand). */
export function useChainNow(rt: UserRuntime, payment: Payment): number | undefined {
  const [now] = useLive(async () => {
    if (payment === 'btc-signet') return rt.session.chain?.tipHeight();
    return rt.session.evm ? Number(await rt.session.evm.blockTimestamp()) : undefined;
  }, every(3000), [rt, payment]);
  return now;
}
