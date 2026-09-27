/** One observed price: 1 `base` is worth `rate` units of `quote`. */
export interface RateObservation {
  base: string;
  quote: string;
  rate: number;
  source: string;
  at: number;
}

/** Spec §7: pluggable rate source. */
export interface RateSource {
  readonly name: string;
  fetch(): Promise<RateObservation[]>;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);
