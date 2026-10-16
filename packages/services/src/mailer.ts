import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
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

export interface Mailer {
  /** Records the email in the outbox and schedules delivery. Returns the outbox id. */
  queue(db: DbLike, email: OutgoingEmail): Promise<string>;
  /** Delivers one outbox row. Safe to call repeatedly: delivered rows are skipped. */
  deliver(id: string): Promise<'sent' | 'dev_logged' | 'failed' | 'skipped'>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Outbox-backed mailer. Without SMTP_URL nothing leaves the machine: rows are marked `dev_logged`.
 * With SMTP_URL, delivery is attempted by the `send-email` job and retried by the queue on failure.
 */
export class OutboxMailer implements Mailer {
  private transport: nodemailer.Transporter | null;
  constructor(
    private readonly workerDb: Db,
    private readonly queueRef: () => JobQueue,
    private readonly opts: { smtpUrl?: string; from: string },
    private readonly log: Logger,
  ) {
    this.transport = opts.smtpUrl ? nodemailer.createTransport(opts.smtpUrl) : null;
  }

  async queue(db: DbLike, email: OutgoingEmail): Promise<string> {
    const [row] = await db
      .insert(emailOutbox)
      .values({ orgId: email.orgId, toAddresses: email.to, subject: email.subject, html: email.html, text: email.text, kind: email.kind, relatedId: email.relatedId ?? null })
      .returning({ id: emailOutbox.id });
    await this.queueRef().enqueue('send-email', { id: row!.id }, { singletonKey: `email:${row!.id}` });
    return row!.id;
  }

  async deliver(id: string): Promise<'sent' | 'dev_logged' | 'failed' | 'skipped'> {
    const [row] = await this.workerDb.select().from(emailOutbox).where(eq(emailOutbox.id, id));
    if (!row || row.status === 'sent' || row.status === 'dev_logged') return 'skipped';
    if (!this.transport) {
      await this.workerDb.update(emailOutbox).set({ status: 'dev_logged', attempts: row.attempts + 1, sentAt: new Date() }).where(eq(emailOutbox.id, id));
      this.log.info('email recorded in outbox (no SMTP configured)', { to: row.toAddresses, subject: row.subject });
      return 'dev_logged';
    }
    try {
      await this.transport.sendMail({ from: this.opts.from, to: row.toAddresses, subject: row.subject, html: row.html, text: row.text });
      await this.workerDb.update(emailOutbox).set({ status: 'sent', attempts: row.attempts + 1, sentAt: new Date(), error: null }).where(eq(emailOutbox.id, id));
      return 'sent';
    } catch (e) {
      await this.workerDb.update(emailOutbox).set({ status: 'failed', attempts: row.attempts + 1, error: (e as Error).message.slice(0, 500) }).where(eq(emailOutbox.id, id));
      this.log.warn('email delivery failed', { id, error: (e as Error).message });
      throw e; // let the queue retry
    }
  }
}

// ───────────────────────────────────────────────────── message templates

export function layout(title: string, bodyHtml: string, footer = 'Shelfwatch'): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#10252b"><div style="max-width:620px;margin:0 auto;padding:28px 20px"><div style="font:600 12px/1 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#0e6e73;margin-bottom:14px">${esc(footer)}</div><h1 style="font-size:24px;line-height:1.25;margin:0 0 16px">${esc(title)}</h1>${bodyHtml}<p style="font:12px Arial,sans-serif;color:#5f7378;margin-top:28px">You receive this because you are a member of this workspace. Manage notifications in Settings.</p></div></body></html>`;
}

export const verificationEmail = (name: string, link: string) => ({
  subject: 'Verify your email address',
  text: `Hi ${name},\n\nConfirm your email address to finish setting up your account:\n${link}\n\nIf you did not create an account you can ignore this message.`,
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
