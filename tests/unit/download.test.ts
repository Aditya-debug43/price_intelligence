import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/api.ts';

// The web app is compiled by its own project (DOM settings), so this root-level test loads the download helper at run time.
const DOWNLOAD_MODULE: string = '../../apps/web/src/download.ts';
let downloadFile: (url: string, contentType: string) => Promise<string>;
beforeAll(async () => {
  ({ downloadFile } = (await import(/* @vite-ignore */ DOWNLOAD_MODULE)) as { downloadFile: typeof downloadFile });
});

/** A failed or wrong export is reported with the server's own message; it is never handed to the browser to save as if it were the file. */
const answer = (status: number, body: string | null, headers: Record<string, string> = {}) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers })));

afterEach(() => vi.unstubAllGlobals());

describe('downloading an export', () => {
  it('reports the message of an error answer instead of saving it', async () => {
    answer(409, JSON.stringify({ error: { code: 'conflict', message: 'The report is not finished yet' } }), { 'content-type': 'application/json' });
    await expect(downloadFile('/x?format=pdf&dataset=stock', 'application/pdf')).rejects.toMatchObject({ message: 'The report is not finished yet', status: 409 });
  });

  it('says so plainly when the error answer is not JSON', async () => {
    answer(502, '<html>bad gateway</html>', { 'content-type': 'text/html' });
    await expect(downloadFile('/x', 'application/pdf')).rejects.toThrow('The download failed (502).');
  });

  it('refuses an answer that is not the kind of file asked for (a page, a login screen) rather than saving it', async () => {
    answer(200, '<html>sign in</html>', { 'content-type': 'text/html; charset=utf-8' });
    const e = await downloadFile('/x', 'application/pdf').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as Error).message).toMatch(/did not send the file that was asked for\. Nothing was saved/);
  });

  it('asks for exactly the address it was given, with the session', async () => {
    answer(500, JSON.stringify({ error: { message: 'x' } }));
    await downloadFile('/api/v1/orgs/o/reports/r/export?format=pdf&dataset=coverage', 'application/pdf').catch(() => undefined);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('/api/v1/orgs/o/reports/r/export?format=pdf&dataset=coverage');
    expect(call[1]).toMatchObject({ credentials: 'same-origin' });
  });
});
