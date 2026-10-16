import type { FastifyInstance, InjectOptions } from 'fastify';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  raw: Buffer;
}

/** Minimal cookie-jar client over Fastify's inject(), sending the same headers the web app sends. */
export class ApiClient {
  cookies = new Map<string, string>();
  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: { csrf?: boolean } = {},
  ) {}

  async request<T = any>(method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.opts.csrf !== false && method !== 'GET' && !('x-requested-with' in h)) h['x-requested-with'] = 'ci-web';
    const res = await this.app.inject({ method, url, headers: h, ...(body !== undefined ? { payload: body as never } : {}) });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const ct = String(res.headers['content-type'] ?? '');
    let parsed: unknown = res.body;
    if (ct.includes('json')) {
      try {
        parsed = res.json();
      } catch {
        /* keep the raw text */
      }
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers, raw: res.rawPayload };
  }

  get = <T = any>(url: string, headers?: Record<string, string>) => this.request<T>('GET', url, undefined, headers);
  post = <T = any>(url: string, body?: unknown, headers?: Record<string, string>) => this.request<T>('POST', url, body ?? {}, headers);
  put = <T = any>(url: string, body?: unknown) => this.request<T>('PUT', url, body ?? {});
  patch = <T = any>(url: string, body?: unknown) => this.request<T>('PATCH', url, body ?? {});
  delete = <T = any>(url: string) => this.request<T>('DELETE', url);
}
