/**
 * Endpoint hygiene (spec §4.10): relays and chain APIs must be https/wss, and by default we
 * never connect to loopback, link-local or private addresses given as IP literals. The lab
 * sets `allowPrivate` because it runs on plain ws/http inside docker networks.
 */

export type EndpointKind = 'http' | 'ws';

export interface EndpointPolicy {
  /** Lab only: allow http/ws and private / loopback hosts. */
  allowPrivate?: boolean;
}

function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : undefined;
}

function privateIpv4(o: number[]): boolean {
  const [a, b] = o;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast / reserved
  );
}

/** Loopback, link-local, private or unspecified host given literally (or `localhost`). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = ipv4Octets(host);
  if (v4) return privateIpv4(v4);
  if (!host.includes(':')) return false; // a DNS name: cannot tell without resolving
  if (host === '::' || host === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return privateIpv4(ipv4Octets(mapped[1]) ?? [0]);
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

/** Why `url` is not acceptable as a `kind` endpoint, or undefined when it is. */
export function endpointProblem(url: string, kind: EndpointKind, policy: EndpointPolicy = {}): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  const secure = kind === 'http' ? 'https:' : 'wss:';
  const insecure = kind === 'http' ? 'http:' : 'ws:';
  if (u.protocol !== secure && !(policy.allowPrivate && u.protocol === insecure)) {
    return `${url}: only ${secure.slice(0, -1)}:// is allowed`;
  }
  if (u.username || u.password) return `${url}: credentials in URLs are not allowed`;
  if (!policy.allowPrivate && isPrivateHost(u.hostname)) return `${url}: private or loopback address`;
  return undefined;
}

export const isAllowedEndpoint = (url: string, kind: EndpointKind, policy?: EndpointPolicy): boolean =>
  endpointProblem(url, kind, policy) === undefined;
