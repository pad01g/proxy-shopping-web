async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`faucet: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Lab faucet (docs/lab.md). */
export const faucet = {
  btc: (base: string, address: string, sats = 1_000_000) => post(`${base}/btc`, { address, sats }),
  evm: (base: string, address: string) => post(`${base}/evm`, { address, eth: '1', usdc: '1000' }),
  mine: (base: string, blocks = 1) => post(`${base}/mine`, { blocks }),
};
