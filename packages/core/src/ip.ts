import { isIP } from 'node:net';

/**
 * SSRF address classification. Returns a human-readable reason when the address must NOT be fetched,
 * or null when it is a public unicast address.
 *
 * Handles IPv4, IPv6, IPv4-mapped IPv6 (::ffff:a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16)
 * and rejects scoped addresses (fe80::1%eth0).
 */
export function forbiddenAddressReason(address: string): string | null {
  const ip = address.trim().replace(/^\[|\]$/g, '');
  if (ip.includes('%')) return 'scoped IPv6 address';
  const kind = isIP(ip);
  if (kind === 4) return ipv4Reason(ip);
  if (kind === 6) return ipv6Reason(ip);
  return 'not an IP address';
}

export const isForbiddenAddress = (address: string): boolean => forbiddenAddressReason(address) !== null;

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number) as [number, number, number, number];
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

interface V4Range {
  cidr: string;
  reason: string;
}

const V4_RANGES: V4Range[] = [
  { cidr: '0.0.0.0/8', reason: 'unspecified / "this network" address' },
  { cidr: '10.0.0.0/8', reason: 'private network (RFC 1918)' },
  { cidr: '100.64.0.0/10', reason: 'carrier-grade NAT / cloud internal range' },
  { cidr: '127.0.0.0/8', reason: 'loopback address' },
  { cidr: '169.254.0.0/16', reason: 'link-local / cloud metadata range' },
  { cidr: '172.16.0.0/12', reason: 'private network (RFC 1918)' },
  { cidr: '192.0.0.0/24', reason: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', reason: 'documentation range' },
  { cidr: '192.88.99.0/24', reason: '6to4 relay anycast' },
  { cidr: '192.168.0.0/16', reason: 'private network (RFC 1918)' },
  { cidr: '198.18.0.0/15', reason: 'benchmarking range' },
  { cidr: '198.51.100.0/24', reason: 'documentation range' },
  { cidr: '203.0.113.0/24', reason: 'documentation range' },
  { cidr: '224.0.0.0/4', reason: 'multicast address' },
  { cidr: '240.0.0.0/4', reason: 'reserved address' },
];

const V4_PARSED = V4_RANGES.map((r) => {
  const [base, bits] = r.cidr.split('/') as [string, string];
  const len = Number(bits);
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { net: ipv4ToInt(base) & mask, mask, reason: r.reason };
});

function ipv4Reason(ip: string): string | null {
  const n = ipv4ToInt(ip);
  for (const r of V4_PARSED) {
    if (((n & r.mask) >>> 0) === (r.net >>> 0)) return r.reason;
  }
  return null;
}

/** Expand an IPv6 literal to eight 16-bit groups. Returns null on malformed input. */
export function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const v4 = tail[1]!;
    if (isIP(v4) !== 4) return null;
    const n = ipv4ToInt(v4);
    s = s.slice(0, s.length - v4.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 && missing < 1) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head;
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function ipv6Reason(ip: string): string | null {
  const g = expandIPv6(ip);
  if (!g) return 'malformed IPv6 address';
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return 'unspecified address';
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return 'loopback address';
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) → judge the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return ipv4Reason(embeddedV4(g6, g7)) ?? (g5 === 0 ? 'IPv4-compatible address' : null);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    // IPv6-only networks (DNS64) hand out these synthetic addresses for ordinary public IPv4 sites, so a NAT64 address
    // is judged by the IPv4 address it embeds: public => allowed, private/loopback/metadata => still blocked.
    return ipv4Reason(embeddedV4(g6, g7));
  }
  // 6to4 2002::/16 embeds an IPv4 address in g1:g2
  if (g0 === 0x2002) return ipv4Reason(embeddedV4(g1, g2));
  if (g0 === 0x2001 && g1 === 0) return 'Teredo tunnel address';
  if (g0 === 0x2001 && g1 === 0xdb8) return 'documentation range';
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return 'discard-only range';
  if ((g0 & 0xfe00) === 0xfc00) return 'unique-local address (private network / cloud metadata)';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local address';
  if ((g0 & 0xffc0) === 0xfec0) return 'site-local address';
  if ((g0 & 0xff00) === 0xff00) return 'multicast address';
  return null;
}

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
];
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];

/** Cheap pre-DNS hostname screen. The authoritative check happens on the resolved address at connect time. */
export function forbiddenHostnameReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.includes(h)) return `hostname "${h}" is reserved for internal use`;
  for (const s of BLOCKED_SUFFIXES) if (h.endsWith(s)) return `hostname suffix "${s}" is reserved for internal use`;
  if (isIP(h.replace(/^\[|\]$/g, ''))) return forbiddenAddressReason(h);
  return null;
}
