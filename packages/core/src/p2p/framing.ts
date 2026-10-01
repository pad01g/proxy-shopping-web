/**
 * Newline-delimited JSON on libp2p streams (§10): /ps/msg/1.0.0 (one wrap, one reply line) and
 * /ps/trust-sync/1.0.0 (events, one per line, until the sender closes). Written against the small part of a
 * js-libp2p v3 Stream used here, so the framing can be tested without libp2p.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { KIND, tagValue } from '../nostr/kinds.js';
import { MAX_MSG_BYTES, MSG_TIMEOUT_MS, type WrapReply } from './types.js';

type Chunk = Uint8Array | { subarray(): Uint8Array };

export interface LineStream extends AsyncIterable<Chunk> {
  send(data: Uint8Array): boolean;
  close(options?: { signal?: AbortSignal }): Promise<void>;
  abort(err: Error): void;
  onDrain?(options?: { signal?: AbortSignal }): Promise<void>;
}

const enc = new TextEncoder();
const NL = 0x0a;

const bytesOf = (c: Chunk): Uint8Array => (c instanceof Uint8Array ? c : c.subarray());

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Write one JSON value followed by a newline. */
export async function writeLine(stream: LineStream, value: unknown): Promise<void> {
  const ok = stream.send(enc.encode(`${JSON.stringify(value)}\n`));
  if (!ok && stream.onDrain) await stream.onDrain();
}

/** Reject after `ms` (the caller aborts the stream). */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Read newline-terminated lines and pass each to `onLine` (without the newline) until the stream ends, `onLine`
 * returns false, or a line is longer than `maxLineBytes` (throws). A last line without newline is passed too.
 */
export async function readLines(
  stream: LineStream,
  onLine: (line: string) => boolean | void,
  opts: { maxLineBytes: number; maxTotalBytes?: number },
): Promise<void> {
  const dec = new TextDecoder();
  let buf: Uint8Array = new Uint8Array(0);
  let total = 0;
  for await (const chunk of stream) {
    const bytes = bytesOf(chunk);
    total += bytes.length;
    if (opts.maxTotalBytes !== undefined && total > opts.maxTotalBytes) throw new Error(`stream over ${opts.maxTotalBytes} bytes`);
    buf = concat(buf, bytes);
    for (;;) {
      const i = buf.indexOf(NL);
      if (i < 0) break;
      if (i > opts.maxLineBytes) throw new Error(`line over ${opts.maxLineBytes} bytes`);
      const line = dec.decode(buf.subarray(0, i));
      buf = buf.slice(i + 1);
      if (onLine(line) === false) return;
    }
    if (buf.length > opts.maxLineBytes) throw new Error(`line over ${opts.maxLineBytes} bytes`);
  }
  if (buf.length) onLine(dec.decode(buf));
}

/** The first line of a stream, or undefined when it ends without one. */
export async function readLine(stream: LineStream, maxLineBytes: number): Promise<string | undefined> {
  let first: string | undefined;
  await readLines(stream, (line) => {
    first = line;
    return false;
  }, { maxLineBytes });
  return first;
}

/** Sender side of /ps/msg/1.0.0 (§4.2, §10): the wrap, then one reply line. True only for {"ok": true}. */
export async function sendWrapOnStream(stream: LineStream, wrap: NostrEvent, timeoutMs = MSG_TIMEOUT_MS): Promise<WrapReply> {
  try {
    return await deadline((async () => {
      await writeLine(stream, wrap);
      await stream.close().catch(() => undefined); // half-close: nothing more from us
      const line = await readLine(stream, 4096);
      if (line === undefined) return { ok: false, error: 'no reply' };
      const reply = JSON.parse(line) as WrapReply;
      return { ok: reply?.ok === true, error: typeof reply?.error === 'string' ? reply.error.slice(0, 200) : undefined };
    })(), timeoutMs, '/ps/msg');
  } catch (err) {
    stream.abort(err as Error);
    return { ok: false, error: (err as Error).message };
  }
}

/** Is this the shape of a gift wrap addressed to `me`? (The signature is checked by the handler.) */
export function wrapProblem(v: unknown, me: string): string | undefined {
  const e = v as NostrEvent;
  if (!e || typeof e !== 'object' || e.kind !== KIND.giftWrap || !Array.isArray(e.tags) || typeof e.content !== 'string') return 'not a gift wrap';
  if (tagValue(e.tags, 'p') !== me) return 'not addressed to us';
  return undefined;
}

/**
 * Receiver side of /ps/msg/1.0.0: read one wrap line (≤ 64 KiB), answer what `handle` decides, close.
 */
export async function serveWrapStream(stream: LineStream, handle: (wrap: NostrEvent) => Promise<WrapReply>, timeoutMs = MSG_TIMEOUT_MS): Promise<WrapReply> {
  try {
    return await deadline((async () => {
      let reply: WrapReply;
      try {
        const line = await readLine(stream, MAX_MSG_BYTES);
        if (line === undefined) throw new Error('empty stream');
        reply = await handle(JSON.parse(line) as NostrEvent);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message.slice(0, 200) };
      }
      await writeLine(stream, reply.ok ? { ok: true } : { ok: false, error: reply.error ?? 'refused' });
      await stream.close().catch(() => undefined);
      return reply;
    })(), timeoutMs, '/ps/msg');
  } catch (err) {
    stream.abort(err as Error);
    return { ok: false, error: (err as Error).message };
  }
}

/** Receiver side of /ps/trust-sync/1.0.0: parse each line as an event (bad lines are skipped). */
export async function readSyncEvents(stream: LineStream, opts: { maxEvents: number; maxEventBytes: number; maxTotalBytes: number }): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  try {
    await readLines(stream, (line) => {
      if (!line.trim()) return true;
      try {
        out.push(JSON.parse(line) as NostrEvent);
      } catch {
        /* skip */
      }
      return out.length < opts.maxEvents;
    }, { maxLineBytes: opts.maxEventBytes, maxTotalBytes: opts.maxTotalBytes });
  } catch (err) {
    // Over a limit: keep what came before it (delegations and lists come first, §10).
    if (!out.length) throw err;
  }
  return out;
}

/** Sender side of /ps/trust-sync/1.0.0: every event on its own line, then close. */
export async function writeSyncEvents(stream: LineStream, events: NostrEvent[]): Promise<void> {
  for (const e of events) await writeLine(stream, e);
  await stream.close();
}
