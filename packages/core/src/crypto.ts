import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------- passwords (scrypt, built into Node)

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 } as const;

function scrypt(password: string, salt: Buffer, opts: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  try {
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      keylen: expected.length,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- tokens

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------- AES-256-GCM secret storage (access tokens)

export interface KeyRing {
  currentId: string;
  keys: Record<string, Buffer>;
}

/** Parse a ring from "id:base64key[,id2:base64key2]" — the first entry is the current encryption key. */
export function parseKeyRing(spec: string): KeyRing {
  const entries = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      if (i < 1) throw new Error('TOKEN_ENCRYPTION_KEY must look like "k1:<base64-32-bytes>"');
      const id = s.slice(0, i);
      const key = Buffer.from(s.slice(i + 1), 'base64');
      if (key.length !== 32) throw new Error(`Encryption key "${id}" must decode to exactly 32 bytes`);
      return [id, key] as const;
    });
  if (entries.length === 0) throw new Error('TOKEN_ENCRYPTION_KEY is empty');
  return { currentId: entries[0]![0], keys: Object.fromEntries(entries) };
}

export function generateKeyRingSpec(id = 'k1'): string {
  return `${id}:${randomBytes(32).toString('base64')}`;
}

/** Output: v1.<keyId>.<iv>.<tag>.<ciphertext> (all base64url). */
export function encryptSecret(plaintext: string, ring: KeyRing): string {
  const key = ring.keys[ring.currentId]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ring.currentId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', ring.currentId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, ring: KeyRing): string {
  const [v, keyId, ivB, tagB, ctB] = payload.split('.');
  if (v !== 'v1' || !keyId || !ivB || !tagB || !ctB) throw new Error('Unsupported secret format');
  const key = ring.keys[keyId];
  if (!key) throw new Error(`Encryption key "${keyId}" is not available (was it rotated out?)`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAAD(Buffer.from(keyId));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------- Shopify HMAC verification

/** Verifies the `hmac` query parameter Shopify attaches to OAuth redirects (hex SHA-256 over sorted key=value pairs). */
export function verifyShopifyQueryHmac(query: Record<string, string>, clientSecret: string): boolean {
  const { hmac, signature: _signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = createHmac('sha256', clientSecret).update(message).digest('hex');
  return safeEqual(digest, hmac);
}

/** Verifies the `X-Shopify-Hmac-Sha256` header over the raw webhook body (base64 SHA-256). */
export function verifyShopifyWebhookHmac(rawBody: string | Buffer, headerValue: string | undefined, clientSecret: string): boolean {
  if (!headerValue) return false;
  const digest = createHmac('sha256', clientSecret).update(rawBody).digest('base64');
  return safeEqual(digest, headerValue);
}

export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(shop);
}

// ---------------------------------------------------------------- canonical JSON (hash stability across jsonb round-trips)

/** JSON with recursively sorted keys. PostgreSQL jsonb does not preserve key order, so hashes must not depend on it. */
export function stableStringify(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
