/**
 * Bundles of signed events (§2.6): `{"events": [...]}` at a coordinator's bundle URL or an operator's list_url.
 * A bundle adds no trust: every event is verified on its own (one bad event does not spoil the rest) and then
 * scoped by the directory exactly like events from any other path.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { endpointProblem } from '../util/endpoint.js';
import { verified } from './events.js';

/** §2.6: at most 2 MiB and 1000 events per bundle. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_EVENTS = 1000;

/** The verified events of a bundle body ({"events": [...]} or a bare array); anything else yields none. */
export function bundleEvents(body: unknown): NostrEvent[] {
  const list = Array.isArray(body) ? body : Array.isArray((body as { events?: unknown })?.events) ? (body as { events: unknown[] }).events : [];
  return list.slice(0, MAX_BUNDLE_EVENTS).filter((e): e is NostrEvent => typeof e === 'object' && e !== null && verified(e as NostrEvent));
}

export interface BundleFetchOptions {
  fetch?: typeof fetch;
  /** Lab only: allow http:// and private hosts. */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

/** Read at most `max` bytes of a response body; throws when it is longer. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) throw new Error(`bundle is ${declared} bytes, over ${max}`);
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > max) throw new Error(`bundle is over ${max} bytes`);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      throw new Error(`bundle is over ${max} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Fetch one bundle (§2.6): https only (http and private hosts only with the lab's allowPrivate), redirects only
 * within the same origin, at most 2 MiB and 1000 events, each event verified.
 */
export async function fetchBundle(url: string, opts: BundleFetchOptions = {}): Promise<NostrEvent[]> {
  const problem = endpointProblem(url, 'http', { allowPrivate: opts.allowPrivate });
  if (problem) throw new Error(problem);
  const get = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await get(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), headers: { accept: 'application/json' } });
  // A redirect elsewhere is refused (fetch follows them; the final URL tells where we ended up).
  if (res.url && new URL(res.url).origin !== new URL(url).origin) throw new Error(`redirected to another origin (${new URL(res.url).origin})`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await readCapped(res, MAX_BUNDLE_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  return bundleEvents(body);
}
