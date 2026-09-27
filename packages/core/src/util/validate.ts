/**
 * Tiny runtime validators for data that crosses a trust boundary (message bodies, profiles,
 * config files). Each check returns the parsed value or throws SchemaError; unknown object
 * keys are dropped and `null` from Go's nil slices is read as an empty list where allowed.
 */

export class SchemaError extends Error {}

export type Check<T> = (v: unknown, path?: string) => T;

const fail = (path: string, msg: string): never => {
  throw new SchemaError(`${path || 'value'}: ${msg}`);
};

export function str(max = 1024, re?: RegExp): Check<string> {
  return (v, path = '') => {
    if (typeof v !== 'string') return fail(path, 'expected a string');
    if (v.length > max) return fail(path, `longer than ${max}`);
    if (re && !re.test(v)) return fail(path, 'bad format');
    return v;
  };
}

export function int(min = 0, max = Number.MAX_SAFE_INTEGER): Check<number> {
  return (v, path = '') => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return fail(path, 'expected an integer');
    if (v < min || v > max) return fail(path, `out of range ${min}..${max}`);
    return v;
  };
}

export const bool: Check<boolean> = (v, path = '') => (typeof v === 'boolean' ? v : fail(path, 'expected a boolean'));

export function oneOf<T extends string>(...values: T[]): Check<T> {
  return (v, path = '') => (values.includes(v as T) ? (v as T) : fail(path, `expected one of ${values.join('|')}`));
}

/** Optional: absent or null → undefined. */
export function opt<T>(c: Check<T>): Check<T | undefined> {
  return (v, path) => (v === undefined || v === null ? undefined : c(v, path));
}

/** Array of at most `max` items; `null`/absent is accepted as [] unless `required`. */
export function arr<T>(item: Check<T>, max: number, opts: { required?: boolean } = {}): Check<T[]> {
  return (v, path = '') => {
    if ((v === null || v === undefined) && !opts.required) return [];
    if (!Array.isArray(v)) return fail(path, 'expected an array');
    if (v.length > max) return fail(path, `more than ${max} items`);
    return v.map((x, i) => item(x, `${path}[${i}]`));
  };
}

type Shape = Record<string, Check<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

export function obj<S extends Shape>(shape: S): Check<Parsed<S>> {
  return (v, path = '') => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(path, 'expected an object');
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, check] of Object.entries(shape)) {
      const val = check(src[k], path ? `${path}.${k}` : k);
      if (val !== undefined) out[k] = val;
    }
    return out as Parsed<S>;
  };
}

/** Discriminated union on `key`. */
export function union<T>(key: string, variants: Record<string, Check<T>>): Check<T> {
  return (v, path = '') => {
    const tag = (v as Record<string, unknown> | null)?.[key];
    const c = typeof tag === 'string' ? variants[tag] : undefined;
    return c ? c(v, path) : fail(path ? `${path}.${key}` : key, `expected one of ${Object.keys(variants).join('|')}`);
  };
}

/** Map a check's result (e.g. normalise a number to a string). */
export function map<A, B>(c: Check<A>, f: (a: A) => B): Check<B> {
  return (v, path) => f(c(v, path));
}

/** First check that accepts wins. */
export function either<A, B>(a: Check<A>, b: Check<B>): Check<A | B> {
  return (v, path) => {
    try {
      return a(v, path);
    } catch {
      return b(v, path);
    }
  };
}

/** Parse or return undefined. */
export function tryParse<T>(c: Check<T>, v: unknown): T | undefined {
  try {
    return c(v);
  } catch {
    return undefined;
  }
}

// ---- common formats ----
export const HEX64 = /^[0-9a-f]{64}$/;
export const hex64 = str(64, HEX64);
export const hexN = (bytes: number) => str(bytes * 2, new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
/** Unsigned integer amount in base units (sats, USDC units). */
export const uintStr = str(40, /^\d{1,40}$/);
/** Unsigned decimal string, e.g. fiat amounts and rates. */
export const decStr = str(48, /^\d{1,30}(\.\d{1,18})?$/);
export const evmAddress = str(42, /^0x[0-9a-fA-F]{40}$/) as Check<`0x${string}`>;
export const evmHash = str(66, /^0x[0-9a-fA-F]{64}$/);
export const btcAddress = str(100, /^[a-zA-Z0-9]{14,100}$/);
export const base64 = (max: number) => str(max, /^[A-Za-z0-9+/]*={0,2}$/);
export const url = str(2048, /^[a-z][a-z0-9+.-]*:\/\/\S+$/i);
