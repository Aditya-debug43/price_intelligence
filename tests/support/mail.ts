import type { MailTransport } from '@ci/services';

export interface CapturedMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/**
 * TEST-ONLY mail server stand-in: records every message handed to it, like an inbox, and can be told to fail so the product's retry and
 * error reporting can be exercised. The product never imports this. (Delivery over a real SMTP conversation is tested separately against an
 * in-process SMTP server in tests/e2e/email-smtp.test.ts, and against Gmail only by the owner's own check.)
 */
export class CaptureTransport implements MailTransport {
  readonly sent: CapturedMail[] = [];
  /** When set, every send throws what this returns (for example an object shaped like nodemailer's error). */
  failWith: (() => unknown) | null = null;
  private n = 0;

  async sendMail(message: { from: string; to: string[]; subject: string; html: string; text: string }) {
    if (this.failWith) throw this.failWith();
    this.sent.push({ from: message.from, to: [...message.to], subject: message.subject, text: message.text, html: message.html });
    return { messageId: `<test-${++this.n}@mail.test>`, response: '250 2.0.0 OK (test mail server)', accepted: [...message.to], rejected: [] };
  }

  async verify() {
    if (this.failWith) throw this.failWith();
    return true;
  }

  /** Messages delivered to one address, newest last. */
  inboxOf(address: string): CapturedMail[] {
    return this.sent.filter((m) => m.to.some((t) => t.toLowerCase() === address.toLowerCase()));
  }

  /** Reads the single-use token out of the newest message to `address` whose text contains `path` (what a person does by clicking the link). */
  tokenIn(address: string, path: 'verify-email' | 'reset-password'): string | null {
    const mails = this.inboxOf(address).filter((m) => m.text.includes(`/${path}?token=`));
    const last = mails[mails.length - 1];
    return last?.text.match(new RegExp(`/${path}[?]token=([A-Za-z0-9_-]+)`))?.[1] ?? null;
  }

  linkIn(address: string, path: 'verify-email' | 'reset-password' | 'invite'): string | null {
    const mails = this.inboxOf(address).filter((m) => m.text.includes(`/${path}?token=`));
    return mails[mails.length - 1]?.text.match(new RegExp(`https?://[^ \n]+/${path}[?]token=[A-Za-z0-9_-]+`))?.[0] ?? null;
  }
}
