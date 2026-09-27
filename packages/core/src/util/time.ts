export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Serialize async work per key (e.g. per order) so handlers never interleave. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
