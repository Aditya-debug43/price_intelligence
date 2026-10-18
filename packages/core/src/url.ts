/** URL normalisation helpers. No network access here; SSRF *network* checks live in connectors/safe-fetch. */

export class UrlValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid'
      | 'protocol'
      | 'credentials'
      | 'port'
      | 'host'
      | 'too_long'
      | 'private_address',
  ) {
    super(message);
    this.name = 'UrlValidationError';
  }
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_',
  '_ga',
  'srsltid',
  'variant_view',
  'pr_prod_strat',
  'pr_rec_id',
  'pr_rec_pid',
  'pr_ref_pid',
  'pr_seq',
  'sort_by',
]);

export interface NormalizedSiteUrl {
  href: string;
  origin: string;
  /** Host including a non-default port ("127.0.0.1:4011"): the identity of a site within a workspace. */
  hostname: string;
  /** Host name without port. */
  bareHostname: string;
  protocol: 'http:' | 'https:';
  /**
   * The page the customer pointed at when it was not the home page ("/shop/", "/en/store?lang=en"): path and query only, no fragment, null
   * for a bare address. A website is tracked as a whole (the origin is its identity), but the page the customer named is where the shop
   * starts — it is what robots.txt is checked against and where product listings are looked for first.
   */
  entryPath: string | null;
}

const MAX_ENTRY_PATH = 512;

/**
 * Normalise a customer-typed site URL ("shop.example.com", "https://Shop.Example.com/foo?x=1#y")
 * to its origin. Rejects non-http(s) protocols, embedded credentials, and obviously malformed hosts.
 */
export function normalizeSiteUrl(input: string): NormalizedSiteUrl {
  const raw = input.trim();
  if (raw.length === 0) throw new UrlValidationError('URL is empty', 'invalid');
  if (raw.length > 2048) throw new UrlValidationError('URL is too long', 'too_long');

  // Bare hostnames are accepted and assumed https.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
  // "host:8080" has a colon but is not a scheme; treat "word:digits" as host:port.
  const looksLikeHostPort = /^[a-zA-Z0-9.-]+:\d+(\/|$)/.test(raw);
  const withScheme = hasScheme && !looksLikeHostPort ? raw : `https://${raw}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new UrlValidationError('URL is not valid', 'invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UrlValidationError(`Protocol ${u.protocol} is not allowed; use http or https`, 'protocol');
  }
  if (u.username || u.password) {
    throw new UrlValidationError('URLs with embedded credentials are not allowed', 'credentials');
  }
  const hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253) throw new UrlValidationError('Hostname is not valid', 'host');
  // Single-label hosts (e.g. "intranet", "localhost") are never public shops.
  const isIpLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[');
  if (!isIpLiteral && !hostname.includes('.') && hostname !== 'localhost') {
    throw new UrlValidationError('Hostname must be a fully-qualified domain', 'host');
  }
  // Tracking parameters are noise; the rest of the query may be what selects the shop section ("?lang=en"), so it is kept.
  const typed = canonicalizeUrl(u.toString());
  const t = new URL(typed);
  const entry = `${t.pathname}${t.search}`;
  return {
    href: `${u.protocol}//${u.host}/`,
    origin: u.origin,
    hostname: u.host.toLowerCase(),
    bareHostname: hostname,
    protocol: u.protocol as 'http:' | 'https:',
    entryPath: entry === '/' || entry.length > MAX_ENTRY_PATH ? null : entry,
  };
}

/**
 * Canonical product URL used for de-duplication: lowercase host, no fragment, no tracking params,
 * sorted remaining params, no trailing slash (except root), no default port.
 */
export function canonicalizeUrl(input: string, base?: string): string {
  const u = new URL(input, base);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()) && !k.toLowerCase().startsWith('utm_'))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;
  return u.toString();
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Strips query/fragment when logging or storing a URL as non-sensitive evidence metadata. */
export function redactUrlForLog(input: string): string {
  try {
    const u = new URL(input);
    u.username = '';
    u.password = '';
    const sensitive = /token|key|secret|sig|signature|auth|code|password|session/i;
    for (const k of [...u.searchParams.keys()]) {
      if (sensitive.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}
