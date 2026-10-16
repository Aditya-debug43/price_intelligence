import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { emailOutbox } from '@ci/database';
import { OutboxMailer } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';

/**
 * Real SMTP delivery path (nodemailer) against a minimal in-process SMTP server. This verifies our mailer — queueing, delivery,
 * recorded failures and retry — not any real mail provider.
 */
interface FakeSmtp {
  port: number;
  messages: { from: string; to: string[]; data: string }[];
  mode: 'accept' | 'reject';
  close(): Promise<void>;
}

async function startSmtp(): Promise<FakeSmtp> {
  const messages: FakeSmtp['messages'] = [];
  const sockets = new Set<net.Socket>();
  const state = { mode: 'accept' as FakeSmtp['mode'] };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let cur = { from: '', to: [] as string[], data: '' };
    const send = (s: string) => sock.write(s + '\r\n');
    send('220 fake.smtp ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push(cur);
          cur = { from: '', to: [], data: '' };
          send('250 2.0.0 queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) send('250 fake.smtp');
        else if (cmd.startsWith('MAIL FROM')) {
          if (state.mode === 'reject') send('550 5.7.1 sender rejected');
          else {
            cur.from = line.slice(10);
            send('250 ok');
          }
        } else if (cmd.startsWith('RCPT TO')) {
          cur.to.push(line.slice(8));
          send('250 ok');
        } else if (cmd === 'DATA') {
          inData = true;
          send('354 end with <CRLF>.<CRLF>');
        } else if (cmd === 'QUIT') {
          send('221 bye');
          sock.end();
        } else send('250 ok');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    get mode() {
      return state.mode;
    },
    set mode(m) {
      state.mode = m;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Reads the Subject header, undoing line folding and RFC 2047 encoded-words (non-ASCII subjects are encoded on the wire). */
function subjectOf(data: string): string {
  const unfolded = data.replace(/\r\n[ \t]+/g, ' ');
  const raw = /^Subject: (.*)$/m.exec(unfolded)?.[1] ?? '';
  return raw.replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_m, enc: string, body: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(body, 'base64').toString('utf8')
      : Buffer.from(body.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
  );
}

describe('email delivery over SMTP', () => {
  let h: Harness;
  let smtp: FakeSmtp;
  let mailer: OutboxMailer;

  beforeAll(async () => {
    h = await createHarness();
    smtp = await startSmtp();
    mailer = new OutboxMailer(h.db.worker, () => h.queue, { smtpUrl: `smtp://127.0.0.1:${smtp.port}`, from: 'Shelfwatch <reports@example.test>' }, h.svc.log);
  });
  afterAll(async () => {
    await smtp.close();
    await h.close();
  });

  const rowOf = async (id: string) => (await h.db.worker.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0]!;
  const mail = { orgId: null, to: ['owner@example.test', 'manager@example.test'], subject: 'Daily report ready — 2026-10-14', html: '<p>Hello <b>there</b></p>', text: 'Hello there', kind: 'daily-summary' };

  it('delivers a queued message through SMTP to every recipient and records it as sent', async () => {
    const id = await mailer.queue(h.db.worker, mail);
    expect((await rowOf(id)).status).toBe('queued');
    expect(await mailer.deliver(id)).toBe('sent');

    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'sent', attempts: 1, error: null });
    expect(row.sentAt).not.toBeNull();
    expect(smtp.messages).toHaveLength(1);
    const m = smtp.messages[0]!;
    expect(m.from).toContain('reports@example.test');
    expect(m.to.join(' ')).toContain('owner@example.test');
    expect(m.to.join(' ')).toContain('manager@example.test');
    expect(subjectOf(m.data)).toBe('Daily report ready — 2026-10-14');
    expect(m.data).toContain('Hello there');
  });

  it('is idempotent: delivering an already-sent message again sends nothing', async () => {
    const id = await mailer.queue(h.db.worker, { ...mail, subject: 'Once only' });
    expect(await mailer.deliver(id)).toBe('sent');
    const count = smtp.messages.length;
    expect(await mailer.deliver(id)).toBe('skipped');
    expect(smtp.messages).toHaveLength(count);
  });

  it('records a failure with its reason, then delivers on a later attempt (so the queue can retry)', async () => {
    smtp.mode = 'reject';
    const id = await mailer.queue(h.db.worker, { ...mail, subject: 'Retry me' });
    await expect(mailer.deliver(id)).rejects.toThrow();
    expect(await rowOf(id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await rowOf(id)).error).toMatch(/550|sender rejected/i);

    smtp.mode = 'accept';
    expect(await mailer.deliver(id)).toBe('sent');
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('without SMTP configured nothing leaves the machine: rows are marked dev_logged', async () => {
    const local = new OutboxMailer(h.db.worker, () => h.queue, { from: 'x@example.test' }, h.svc.log);
    const before = smtp.messages.length;
    const id = await local.queue(h.db.worker, { ...mail, subject: 'Local only' });
    expect(await local.deliver(id)).toBe('dev_logged');
    expect(smtp.messages).toHaveLength(before);
  });
});
