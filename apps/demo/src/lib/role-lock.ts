/**
 * A role runs in one window at a time (two windows answering the same messages could, for example, sign
 * two rulings). Uses the Web Locks API; where it is missing (non-secure contexts) every window may run.
 */
interface LockManagerLike {
  request(name: string, opts: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => Promise<void>): Promise<void>;
}

export interface RoleLock {
  /** true when this window holds the role. */
  held: boolean;
  release(): void;
}

export function acquireRoleLock(role: string, opts: { steal?: boolean; onLost?: () => void } = {}): Promise<RoleLock> {
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  if (!locks) return Promise.resolve({ held: true, release: () => undefined });
  return new Promise((resolve) => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let got = false;
    locks
      .request(`ps-demo-role-${role}`, opts.steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        got = lock !== null;
        resolve({ held: got, release });
        if (got) await hold;
      })
      .catch(() => {
        // A steal from another window rejects the request we were holding.
        if (got) opts.onLost?.();
        else resolve({ held: false, release: () => undefined });
      });
  });
}
