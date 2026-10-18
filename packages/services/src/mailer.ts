import nodemailer from 'nodemailer';
import { and, eq } from 'drizzle-orm';
import { describeSmtpError, type SmtpProblem, type SmtpSettings } from '@ci/core';
import { emailOutbox, type Db, type DbLike } from '@ci/database';
import type { JobQueue, Logger } from './context.ts';

export interface OutgoingEmail {
  orgId: string | null;
  to: string[];
  subject: string;
  html: string;
  text: string;
  kind: string;
  relatedId?: string | null;
}

/** What the mail server said when it accepted a message. Stored with the outbox row: it is the evidence that delivery to the provider happened. */
export interface DeliveryReceipt {
  messageId: string | null;
  response: string | null;
  accepted: string[];
  rejected: string[];
}

/** The part of a nodemailer transport the product uses. Tests may supply their own; production always uses nodemailer over SMTP. */
export interface MailTransport {
  sendMail(message: { from: string; to: string[]; subject: string; html: string; text: string }): Promise<{ messageId?: string; response?: string; accepted?: unknown[]; rejected?: unknown[] }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export type DeliveryOutcome = 'sent' | 'failed' | 'retrying' | 'skipped' | 'not_configured';

export type SendNowResult = { ok: true; receipt: DeliveryReceipt } | { ok: false; problem: SmtpProblem };

export interface Mailer {
  /** Whether a mail server is configured. When false nothing can be delivered, and the product says so. */
  readonly configured: boolean;
  /** The From header in use (a placeholder when not configured). */
  readonly from: string;
  /** The mail server's host name, for display. Null when not configured. */
  readonly host: string | null;
  /**
   * Records the email in the outbox and schedules delivery. Returns the outbox id. When email is not configured the row is recorded as
   * `not_configured` (never `sent`) and nothing is scheduled.
   */
  queue(db: DbLike, email: OutgoingEmail): Promise<string>;
  /** One delivery attempt for an outbox row. Safe to call repeatedly: delivered rows are skipped. Throws only when the queue should retry. */
  deliver(id: string): Promise<DeliveryOutcome>;
  /** Sends one message immediately (not through the queue) and returns exactly what the mail server answered. Used for the "send a test email" check. */
  sendNow(email: Omit<OutgoingEmail, 'kind'> & { kind?: string }): Promise<SendNowResult>;
  /** Connects and signs in to the mail server without sending anything. */
  verify(): Promise<{ ok: true } | { ok: false; problem: SmtpProblem }>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Delivery attempts before a message is given up on (the queue retries at 60 s intervals; see queue.ts). */
export const MAX_DELIVERY_ATTEMPTS = 6;
const NOT_CONFIGURED_TEXT = 'Email delivery is not configured on this server, so this message was not sent.';
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const isLoopbackHost = (h: string) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);

export function createSmtpTransport(smtp: SmtpSettings): MailTransport {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // A connection that starts in clear text MUST upgrade before credentials or mail are sent (no silent downgrade). Only a local relay may stay plain.
    requireTLS: !smtp.secure && !isLoopbackHost(smtp.host),
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  }) as unknown as MailTransport;
}

const receiptOf = (info: Awaited<ReturnType<MailTransport['sendMail']>>): DeliveryReceipt => ({
  messageId: info.messageId ?? null,
  response: info.response ? String(info.response).slice(0, 300) : null,
  accepted: (info.accepted ?? []).map(String),
  rejected: (info.rejected ?? []).map(String),
});

/**
 * Outbox-backed mailer. Every message is first written to `email_outbox`; the `send-email` job delivers it and records the outcome
 * (attempts, the mail server's answer, the last error). A message is `sent` only after the mail server accepted it. With no mail server
 * configured, rows are `not_configured` — never described as sent.
 */
export class OutboxMailer implements Mailer {
  private readonly transport: MailTransport | null;
  readonly from: string;
  readonly host: string | null;
  constructor(
    private readonly workerDb: Db,
    private readonly queueRef: () => JobQueue,
    private readonly opts: { smtp: SmtpSettings | null; from: string; transport?: MailTransport },
    private readonly log: Logger,
  ) {
    this.transport = opts.transport ?? (opts.smtp ? createSmtpTransport(opts.smtp) : null);
    this.from = opts.smtp?.from ?? opts.from;
    this.host = opts.smtp?.host ?? (opts.transport ? 'test transport' : null);
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  async queue(db: DbLike, email: OutgoingEmail): Promise<string> {
    const [row] = await db
      .insert(emailOutbox)
      .values({
        orgId: email.orgId,
        toAddresses: email.to,
        subject: oneLine(email.subject),
        html: email.html,
        text: email.text,
        kind: email.kind,
        relatedId: email.relatedId ?? null,
        status: this.configured ? 'queued' : 'not_configured',
        error: this.configured ? null : NOT_CONFIGURED_TEXT,
      })
      .returning({ id: emailOutbox.id });
    if (this.configured) await this.queueRef().enqueue('send-email', { id: row!.id }, { singletonKey: `email:${row!.id}` });
    else this.log.warn('email not sent: no mail server is configured', { kind: email.kind });
    return row!.id;
  }

  async deliver(id: string): Promise<DeliveryOutcome> {
    const [row] = await this.workerDb.select().from(emailOutbox).where(eq(emailOutbox.id, id));
    if (!row || row.status === 'sent') return 'skipped';
    const now = new Date();
    const attempts = row.attempts + 1;
    if (!this.transport) {
      await this.workerDb.update(emailOutbox).set({ status: 'not_configured', attempts, lastAttemptAt: now, error: NOT_CONFIGURED_TEXT }).where(eq(emailOutbox.id, id));
      return 'not_configured';
    }
    try {
      const receipt = receiptOf(await this.transport.sendMail({ from: this.from, to: row.toAddresses, subject: row.subject, html: row.html, text: row.text }));
      // A server that accepted none of the recipients did not deliver anything.
      if (!receipt.accepted.length && receipt.rejected.length) throw Object.assign(new Error(`rejected: ${receipt.rejected.join(', ')}`), { code: 'EENVELOPE', responseCode: 550 });
      await this.workerDb
        .update(emailOutbox)
        .set({ status: 'sent', attempts, lastAttemptAt: now, sentAt: now, error: null, providerMessageId: receipt.messageId, providerResponse: receipt.response })
        .where(eq(emailOutbox.id, id));
      this.log.info('email delivered to the mail server', { kind: row.kind, messageId: receipt.messageId });
      return 'sent';
    } catch (e) {
      const problem = describeSmtpError(e, this.opts.smtp);
      const final = !problem.retryable || attempts >= MAX_DELIVERY_ATTEMPTS;
      await this.workerDb
        .update(emailOutbox)
        .set({ status: final ? 'failed' : 'retrying', attempts, lastAttemptAt: now, error: `${problem.code}: ${problem.message}`.slice(0, 600) })
        .where(and(eq(emailOutbox.id, id)));
      this.log.warn('email delivery failed', { kind: row.kind, attempts, final, code: problem.code });
      if (final) return 'failed';
      throw new Error(`email delivery failed (${problem.code}); will retry`, { cause: e }); // lets the queue retry later
    }
  }

  async sendNow(email: Omit<OutgoingEmail, 'kind'> & { kind?: string }): Promise<SendNowResult> {
    const kind = email.kind ?? 'test-email';
    if (!this.transport) return { ok: false, problem: { code: 'unknown', message: NOT_CONFIGURED_TEXT, retryable: false } };
    const now = new Date();
    const [row] = await this.workerDb
      .insert(emailOutbox)
      .values({ orgId: email.orgId, toAddresses: email.to, subject: oneLine(email.subject), html: email.html, text: email.text, kind, relatedId: email.relatedId ?? null, status: 'queued', attempts: 1, lastAttemptAt: now })
      .returning({ id: emailOutbox.id });
    try {
      const receipt = receiptOf(await this.transport.sendMail({ from: this.from, to: email.to, subject: oneLine(email.subject), html: email.html, text: email.text }));
      if (!receipt.accepted.length) throw Object.assign(new Error(`rejected: ${receipt.rejected.join(', ')}`), { code: 'EENVELOPE', responseCode: 550 });
      await this.workerDb.update(emailOutbox).set({ status: 'sent', sentAt: now, providerMessageId: receipt.messageId, providerResponse: receipt.response }).where(eq(emailOutbox.id, row!.id));
      return { ok: true, receipt };
    } catch (e) {
      const problem = describeSmtpError(e, this.opts.smtp);
      await this.workerDb.update(emailOutbox).set({ status: 'failed', error: `${problem.code}: ${problem.message}`.slice(0, 600) }).where(eq(emailOutbox.id, row!.id));
      return { ok: false, problem };
    }
  }

  async verify(): Promise<{ ok: true } | { ok: false; problem: SmtpProblem }> {
    if (!this.transport) return { ok: false, problem: { code: 'unknown', message: NOT_CONFIGURED_TEXT, retryable: false } };
    if (!this.transport.verify) return { ok: true };
    try {
      await this.transport.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, problem: describeSmtpError(e, this.opts.smtp) };
    }
  }
}

// ───────────────────────────────────────────────────── message templates

export function layout(title: string, bodyHtml: string, footer = 'Shelfwatch'): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#10252b"><div style="max-width:620px;margin:0 auto;padding:28px 20px"><div style="font:600 12px/1 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#0e6e73;margin-bottom:14px">${esc(footer)}</div><h1 style="font-size:24px;line-height:1.25;margin:0 0 16px">${esc(title)}</h1>${bodyHtml}<p style="font:12px Arial,sans-serif;color:#5f7378;margin-top:28px">You receive this because you are a member of this workspace. Manage notifications in Settings.</p></div></body></html>`;
}

export const verificationEmail = (name: string, link: string) => ({
  subject: 'Verify your email address',
  text: `Hi ${name},\n\nConfirm your email address to finish setting up your account (the link works once and expires in 48 hours):\n${link}\n\nIf you did not create an account you can ignore this message.`,
  html: layout('Verify your email', `<p>Hi ${esc(name)},</p><p>Confirm your email address to finish setting up your account.</p><p><a href="${esc(link)}" style="background:#0e6e73;color:#fff;padding:10px 16px;text-decoration:none;font:600 14px Arial,sans-serif;border-radius:4px">Verify email</a></p>`),
});

export const invitationEmail = (inviter: string, workspace: string, role: string, link: string) => ({
  subject: `${inviter} invited you to ${workspace} on Shelfwatch`,
  text: `${inviter} invited you to join "${workspace}" on Shelfwatch as ${role}.\n\nAccept the invitation (the link works once and expires in 7 days):\n${link}\n\nYou need to sign in or create an account with this email address. If you were not expecting this, you can ignore the message.`,
  html: layout(`Join ${workspace}`, `<p>${esc(inviter)} invited you to join <b>${esc(workspace)}</b> on Shelfwatch as <b>${esc(role)}</b>.</p><p><a href="${esc(link)}" style="background:#0e6e73;color:#fff;padding:10px 16px;text-decoration:none;font:600 14px Arial,sans-serif;border-radius:4px">View the invitation</a></p><p style="color:#5d574b">The link works once and expires in 7 days. You need to sign in or create an account with this email address. If you were not expecting this, you can ignore the message.</p>`),
});

export const resetEmail = (name: string, link: string) => ({
  subject: 'Reset your password',
  text: `Hi ${name},\n\nUse this link within one hour to choose a new password:\n${link}\n\nIf you did not request this you can ignore this message.`,
  html: layout('Reset your password', `<p>Hi ${esc(name)},</p><p>Use the button below within one hour to choose a new password.</p><p><a href="${esc(link)}" style="background:#0e6e73;color:#fff;padding:10px 16px;text-decoration:none;font:600 14px Arial,sans-serif;border-radius:4px">Choose a new password</a></p>`),
});

export const accountExistsEmail = (name: string, signInUrl: string, resetUrl: string) => ({
  subject: 'Someone tried to register with your email address',
  text: `Hi ${name},\n\nSomeone just tried to create a Shelfwatch account with this email address, but you already have one.\n\nSign in: ${signInUrl}\nForgot your password? ${resetUrl}\n\nIf this was not you, you can ignore this message; your account has not changed.`,
  html: layout('You already have an account', `<p>Hi ${esc(name)},</p><p>Someone just tried to create a Shelfwatch account with this email address, but you already have one.</p><p><a href="${esc(signInUrl)}" style="background:#0e6e73;color:#fff;padding:10px 16px;text-decoration:none;font:600 14px Arial,sans-serif;border-radius:4px">Sign in</a> &nbsp; <a href="${esc(resetUrl)}">Forgot your password?</a></p><p style="color:#5d574b">If this was not you, you can ignore this message; your account has not changed.</p>`),
});

export const testEmail = (who: string, from: string, host: string) => ({
  subject: 'Shelfwatch test email',
  text: `Hi ${who},\n\nThis is a test message from Shelfwatch. If you can read it, email delivery works: it was sent as ${from} through ${host}.`,
  html: layout('Email delivery works', `<p>Hi ${esc(who)},</p><p>This is a test message from Shelfwatch. If you can read it, email delivery works: it was sent as <b>${esc(from)}</b> through <b>${esc(host)}</b>.</p>`),
});
