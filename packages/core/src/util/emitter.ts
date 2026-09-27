type Listener<T> = (value: T) => void;

/** Tiny typed event emitter (no Node `events` so it runs anywhere). */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events>(type: K, fn: Listener<Events[K]>): void {
    this.listeners.get(type)?.delete(fn as Listener<never>);
  }

  protected emit<K extends keyof Events>(type: K, value: Events[K]): void {
    for (const fn of this.listeners.get(type) ?? []) {
      try {
        (fn as Listener<Events[K]>)(value);
      } catch (err) {
        console.error(`listener for ${String(type)} failed`, err);
      }
    }
  }
}
