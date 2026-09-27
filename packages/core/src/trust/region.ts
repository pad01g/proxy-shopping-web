/** Spec §2.5: covers(R, X) = X == R or X starts with R + "-". */
export function covers(region: string, x: string): boolean {
  return x === region || x.startsWith(region + '-');
}

/** Hostname of a shop URL (or the value itself if it is already a host). */
export function shopHost(shopUrl: string): string {
  try {
    return new URL(shopUrl).hostname.toLowerCase();
  } catch {
    return shopUrl.toLowerCase();
  }
}

export function shopAllowed(shops: string[], shopUrl: string): boolean {
  const host = shopHost(shopUrl);
  return shops.some((s) => s === '*' || s.toLowerCase() === host);
}
