export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

/**
 * The headers of a request. `content-type: application/json` is declared only when there IS a JSON body: the API (Fastify) answers 400
 * "Body cannot be empty when content-type is set to 'application/json'" to a request that declares a body it does not send — which is what
 * every bodyless DELETE (remove a website, revoke an invitation, remove a member, disconnect an integration) used to do.
 */
export function requestHeaders(hasBody: boolean): Record<string, string> {
  return { ...(hasBody ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'ci-web', accept: 'application/json' };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: requestHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: { path: string; message: string }[] } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export const orgPath = (orgId: string, path = '') => `/api/v1/orgs/${orgId}${path}`;

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Field-level messages from a validation error, keyed by field path. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (e instanceof ApiError && e.details) return Object.fromEntries(e.details.map((d) => [d.path, d.message]));
  return {};
}

export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
