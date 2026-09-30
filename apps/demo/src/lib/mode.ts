/**
 * Lab or mock mode. `?mock=1` runs the demo entirely inside the browser (src/mock: relays, chains, faucet, rates,
 * shops and the shopper node simulated in a SharedWorker), `?mock=0` against the docker compose lab through the
 * demo server; without the parameter the build decides (VITE_DEMO_MOCK=1, set by `.env.pages` for GitHub Pages).
 * Each mode keeps its own keys and records (localStorage prefix, IndexedDB names, role locks), so the two never mix.
 */
function fromQuery(): boolean | undefined {
  const v = new URLSearchParams(window.location.search).get('mock');
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

export const MOCK_DEFAULT = import.meta.env.VITE_DEMO_MOCK === '1';

/** Fixed for the page's lifetime: switching reloads (see mockSwitchUrl). */
export const IS_MOCK: boolean = fromQuery() ?? MOCK_DEFAULT;

/** The same page in the other mode (the header's モック / Mock switch). */
export function mockSwitchUrl(mock: boolean): string {
  const u = new URL(window.location.href);
  u.searchParams.set('mock', mock ? '1' : '0');
  return u.toString();
}

/** Prefix of everything this mode stores. */
export const MODE_PREFIX = IS_MOCK ? 'ps-demo-mock' : 'ps-demo';
