import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * The single-origin deployment: the API process also serves the built web app (SERVE_WEB=true), so the page, the API and the session cookie
 * share one address. These checks use a tiny stand-in build so they run without compiling the web app.
 */
let h: Harness;
let app: FastifyInstance;
let dist: string;

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-web-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div><script src="/assets/app-abc123.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');
  h = await createHarness({ extraEnv: { SERVE_WEB: 'true' } });
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, webDist: dist });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('serving the web app from the API', () => {
  it('serves the page, and a deep link, as the app shell that is always re-checked', async () => {
    const home = await new ApiClient(app).get('/');
    expect(home.status).toBe(200);
    expect(String(home.body)).toContain('id="root"');
    expect(home.headers['cache-control']).toBe('no-cache');
    const deep = await new ApiClient(app).get('/o/anything/prices');
    expect(deep.status).toBe(200);
    expect(String(deep.body)).toContain('id="root"');
  });

  it('lets browsers keep content-hashed build files for a year', async () => {
    const js = await new ApiClient(app).get('/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers an unknown API path with a JSON 404, never with the web page', async () => {
    const r = await new ApiClient(app).get('/api/v1/nothing-here');
    expect(r.status).toBe(404);
    expect(String(r.headers['content-type'])).toContain('json');
  });
});
