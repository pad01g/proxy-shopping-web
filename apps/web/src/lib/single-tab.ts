/**
 * Only one tab may run the protocol at a time (item 8): two tabs would both answer messages and
 * could both fund an order. Uses the Web Locks API; without it, a BroadcastChannel handshake.
 */
export interface TabLock {
  /** Resolves true once this tab is the active one (false when another tab holds it). */
  acquired: Promise<boolean>;
  release(): void;
}

const NAME = 'proxy-shopping-active-tab';

interface LockManagerLike {
  request(name: string, opts: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => Promise<void>): Promise<void>;
}

/** `onLost` runs when another tab takes over with `steal`. */
export function acquireTabLock(opts: { steal?: boolean; onLost?: () => void } = {}): TabLock {
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  if (locks) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let got = false;
    const acquired = new Promise<boolean>((resolve) => {
      void locks
        .request(NAME, opts.steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
          got = lock !== null;
          resolve(got);
          if (got) await held;
        })
        .catch(() => {
          if (got) opts.onLost?.();
          resolve(false);
        });
    });
    return { acquired, release: () => release() };
  }
  return broadcastLock();
}

/** Fallback: ask existing tabs; anyone answering "busy" within 300 ms means we are not first. */
function broadcastLock(): TabLock {
  if (typeof BroadcastChannel === 'undefined') return { acquired: Promise.resolve(true), release: () => undefined };
  const ch = new BroadcastChannel(NAME);
  let active = false;
  ch.onmessage = (e) => {
    if (e.data === 'who' && active) ch.postMessage('busy');
  };
  const acquired = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => {
      active = true;
      resolve(true);
    }, 300);
    const onBusy = (e: MessageEvent) => {
      if (e.data !== 'busy' || active) return;
      clearTimeout(t);
      ch.removeEventListener('message', onBusy);
      resolve(false);
    };
    ch.addEventListener('message', onBusy);
    ch.postMessage('who');
  });
  return { acquired, release: () => ch.close() };
}
