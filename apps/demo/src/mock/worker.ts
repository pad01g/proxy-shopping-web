/**
 * The mock world's worker. As a SharedWorker (the default) every window of this browser connects to the same
 * world, which is what the separate-windows mode needs; where SharedWorker is missing, the page starts it as a
 * dedicated Worker (one world per window, kept in the same IndexedDB).
 *
 * Messages: page → worker {id, method, params} (and {bye: true} when the page goes away);
 * worker → page {id, result} | {id, error} | {sub, event} | {sub, eose: true}.
 */
import { IndexedDBStorage } from '@proxy-shopping/core/browser';
import { MockWorld } from './world/world';

export const WORLD_DB = 'ps-demo-mock-world';

interface Port {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
  start?(): void;
}

let worldP: Promise<MockWorld> | undefined;
const world = () => (worldP ??= IndexedDBStorage.open(WORLD_DB).then((st) => MockWorld.open(st)));

function serve(port: Port): void {
  const mine = new Set<string>();
  port.onmessage = (e: MessageEvent) => {
    const m = e.data as { id?: number; method?: string; params?: unknown[]; bye?: boolean };
    if (m.bye) {
      void world().then((w) => w.dropSubscriptions([...mine]));
      mine.clear();
      return;
    }
    if (m.id === undefined || !m.method) return;
    if (m.method === 'relay.subscribe') mine.add(String(m.params?.[0]));
    if (m.method === 'relay.unsubscribe') mine.delete(String(m.params?.[0]));
    void world()
      .then((w) => w.call(m.method!, m.params ?? [], {
        event: (sub, event) => port.postMessage({ sub, event }),
        eose: (sub) => port.postMessage({ sub, eose: true }),
      }))
      .then(
        (result) => port.postMessage({ id: m.id, result }),
        (err: Error) => port.postMessage({ id: m.id, error: err?.message ?? String(err) }),
      );
  };
  port.start?.();
}

const g = self as unknown as { onconnect?: (e: MessageEvent) => void; postMessage?: (m: unknown) => void };
if ('SharedWorkerGlobalScope' in self) {
  g.onconnect = (e: MessageEvent) => serve(e.ports[0] as unknown as Port);
} else {
  serve(self as unknown as Port);
}
// Start the world at once (the first page is waiting for it).
void world().catch((e) => console.error('mock world failed to start', e));
