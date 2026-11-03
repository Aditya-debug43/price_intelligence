import { ApiError } from './api';

/**
 * Fetches a file the API serves as an attachment and saves it. An error answer (the report is gone, the session ended, the export failed) is thrown with the server's own message
 * instead of being left to the browser to save as if it were the file, and an answer that is not the kind of file asked for is refused rather than saved.
 */
export async function downloadFile(url: string, contentType: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'x-requested-with': 'ci-web' } });
  if (!res.ok) {
    let message = `The download failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      /* the answer was not JSON: keep the generic message */
    }
    throw new ApiError(res.status, 'download_failed', message);
  }
  if (!(res.headers.get('content-type') ?? '').startsWith(contentType)) throw new ApiError(res.status, 'download_failed', 'The server did not send the file that was asked for. Nothing was saved.');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report';
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
  return name;
}
