const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|apikey|signature|hmac|credential|private[-_]?key|refresh/i;

const VALUE_PATTERNS: [RegExp, string][] = [
  [/shp(?:at|ua|ca|pa)_[a-f0-9]{16,}/gi, 'shp**_[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  [/(access_token|refresh_token|client_secret|api[_-]?key|key)=([^&\s"']+)/gi, '$1=[REDACTED]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[REDACTED]'],
  [/EAA[A-Za-z0-9]{30,}/g, 'EAA[REDACTED]'],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redacts objects for logging: sensitive keys are masked, string values are pattern-scrubbed. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[truncated]' as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redactString(value.message) } as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Fastify/pino `redact.paths` that cover headers and common body fields. */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.token',
  '*.password',
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
];
