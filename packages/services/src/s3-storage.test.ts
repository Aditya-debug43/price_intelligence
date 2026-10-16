import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '@ci/core';
import { S3Storage } from './s3-storage.ts';

/**
 * The driver is exercised through the real AWS SDK against a small in-process S3-compatible server (path-style addressing, the way
 * MinIO and R2 are used). This verifies our driver and its error mapping — it is NOT a test against AWS S3 or R2 themselves.
 */
describe('S3Storage against an S3-compatible fake', () => {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const seen: { method: string; path: string; signed: boolean }[] = [];
  let server: http.Server;
  let storage: S3Storage;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]!);
        seen.push({ method: req.method ?? '', path, signed: String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256') });
        const key = path.replace(/^\/test-bucket\//, '');
        if (path.startsWith('/denied/')) {
          res.writeHead(403, { 'content-type': 'application/xml' });
          return void res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>no</Message></Error>');
        }
        if (req.method === 'PUT') {
          objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? '') });
          res.writeHead(200, { etag: '"abc"' });
          return void res.end();
        }
        const obj = objects.get(key);
        if (req.method === 'DELETE') {
          objects.delete(key);
          res.writeHead(204);
          return void res.end();
        }
        if (!obj) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          return void res.end(req.method === 'HEAD' ? undefined : '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
        }
        res.writeHead(200, { 'content-type': obj.type, 'content-length': obj.body.length });
        res.end(req.method === 'HEAD' ? undefined : obj.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    storage = new S3Storage({ S3_BUCKET: 'test-bucket', S3_REGION: 'us-east-1', S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret' } as AppConfig);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('stores, reads back (bytes and text), checks existence and deletes — with signed requests and the content type', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    await storage.put('evidence/org1/page.html', '<html>héllo</html>', 'text/html; charset=utf-8');
    await storage.put('exports/report.pdf', bytes, 'application/pdf');

    expect((await storage.get('evidence/org1/page.html'))!.toString('utf8')).toBe('<html>héllo</html>');
    expect(Buffer.compare((await storage.get('exports/report.pdf'))!, bytes)).toBe(0);
    expect(objects.get('evidence/org1/page.html')!.type).toContain('text/html');
    expect(await storage.exists('exports/report.pdf')).toBe(true);

    await storage.delete('exports/report.pdf');
    expect(await storage.exists('exports/report.pdf')).toBe(false);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((s) => s.signed)).toBe(true);
  });

  it('maps a missing object to null / false instead of throwing', async () => {
    expect(await storage.get('nope/missing.txt')).toBeNull();
    expect(await storage.exists('nope/missing.txt')).toBe(false);
  });

  it('does not mistake a permission failure for a missing object', async () => {
    const denied = new S3Storage({ S3_BUCKET: 'denied', S3_REGION: 'us-east-1', S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' } as AppConfig);
    await expect(denied.get('any.txt')).rejects.toBeDefined();
    await expect(denied.exists('any.txt')).rejects.toBeDefined(); // used to answer false
  });
});
