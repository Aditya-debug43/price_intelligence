/**
 * SMTP settings and the plain-language reading of SMTP failures. Pure: no I/O, so it can be unit-tested and shared by the API, the worker and scripts.
 *
 * Configuration is deliberately a handful of ordinary variables (not a connection URL): a Gmail App Password contains spaces and a Gmail address
 * contains "@", both of which must be escaped inside a URL, and a mistake there fails with a confusing authentication error.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS (port 465). When false the connection starts in clear text and MUST upgrade with STARTTLS before anything is sent. */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** The From header: "Display name <address>". */
  from: string;
  /** The bare sender address. */
  fromAddress: string;
}

export interface SmtpEnv {
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: number | undefined;
  SMTP_SECURE?: boolean | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  EMAIL_FROM?: string | undefined;
}

export class SmtpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpConfigError';
  }
}

export const isGmailHost = (host: string) => /^smtp\.(gmail|googlemail)\.com$/i.test(host.trim());

/** Google shows an App Password as four groups of four letters ("abcd efgh ijkl mnop"); the spaces are not part of it. */
export function normalizeSmtpPassword(host: string, password: string): string {
  return isGmailHost(host) ? password.replace(/\s+/g, '') : password;
}

/** The address inside "Name <address>" (or the whole string when it is only an address). */
export function addressOf(from: string): string {
  const m = from.match(/<([^<>]+)>\s*$/);
  return (m ? m[1]! : from).trim();
}

/** Null when email delivery is not configured. Throws SmtpConfigError for a configuration that cannot work. */
export function resolveSmtp(env: SmtpEnv): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) {
    if (env.SMTP_USER || env.SMTP_PASSWORD) throw new SmtpConfigError('SMTP_USER / SMTP_PASSWORD are set but SMTP_HOST is not. Set SMTP_HOST (for Gmail: smtp.gmail.com) or remove them.');
    return null;
  }
  const user = env.SMTP_USER?.trim() || null;
  const rawPassword = env.SMTP_PASSWORD ?? null;
  if (!!user !== !!rawPassword) throw new SmtpConfigError('SMTP_USER and SMTP_PASSWORD must be set together (or both left empty for a relay that needs no sign-in).');
  const secure = env.SMTP_SECURE ?? env.SMTP_PORT === 465;
  const port = env.SMTP_PORT ?? (secure ? 465 : 587);
  const password = rawPassword === null ? null : normalizeSmtpPassword(host, rawPassword);
  if (isGmailHost(host) && !user) throw new SmtpConfigError('Gmail needs SMTP_USER (your Gmail address) and SMTP_PASSWORD (a Google App Password, not your normal password).');
  const from = env.EMAIL_FROM?.trim() || (user ? `Shelfwatch <${user}>` : '');
  if (!from) throw new SmtpConfigError('EMAIL_FROM is required when SMTP_USER is not set (for example: Shelfwatch <reports@your-domain.com>).');
  const fromAddress = addressOf(from);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fromAddress)) throw new SmtpConfigError(`EMAIL_FROM must contain a valid address, for example: Shelfwatch <reports@your-domain.com> (got "${from}").`);
  if (isGmailHost(host) && user && fromAddress.toLowerCase() !== user.toLowerCase()) {
    throw new SmtpConfigError(`With Gmail the sender must be the signed-in account: EMAIL_FROM must use ${user} (Gmail replaces any other sender address). Change EMAIL_FROM or leave it empty.`);
  }
  return { host, port, secure, user, password, from, fromAddress };
}

export interface SmtpProblem {
  /** A stable machine-readable reason. */
  code: 'auth_failed' | 'app_password_required' | 'connection_refused' | 'host_not_found' | 'timeout' | 'tls_failed' | 'sender_rejected' | 'recipient_rejected' | 'rate_limited' | 'message_too_large' | 'unknown';
  /** What happened and what to do about it. Never contains credentials. */
  message: string;
  /** Whether trying again later can help. */
  retryable: boolean;
}

/** Turns a nodemailer/SMTP error into advice a person can act on. The raw server text is included only after credential-like parts are removed. */
export function describeSmtpError(err: unknown, settings?: Pick<SmtpSettings, 'host' | 'port' | 'user'> | null): SmtpProblem {
  const e = err as { code?: string; responseCode?: number; response?: string; command?: string; message?: string };
  const raw = `${e?.response ?? ''} ${e?.message ?? ''}`.trim();
  const code = String(e?.code ?? '');
  const rc = e?.responseCode ?? 0;
  const gmail = settings ? isGmailHost(settings.host) : /gmail|googlemail|google\.com/i.test(raw);
  const safe = (s: string) => s.replace(/(pass(word)?|pwd|secret|token|key)\s*[=:]\s*\S+/gi, '$1=[hidden]').replace(/[A-Za-z0-9+/=_-]{40,}/g, '[hidden]').slice(0, 240);

  if (rc === 534 || /application-specific password required|5\.7\.9|app password/i.test(raw)) {
    return {
      code: 'app_password_required',
      message: 'Google refused the sign-in: this account needs an App Password. Turn on 2-Step Verification for the Google account, create an App Password at https://myaccount.google.com/apppasswords, and put it in SMTP_PASSWORD (not your normal Google password).',
      retryable: false,
    };
  }
  if (rc === 535 || code === 'EAUTH' || /invalid login|authentication failed|username and password not accepted|5\.7\.8|badcredentials/i.test(raw)) {
    return {
      code: 'auth_failed',
      message: gmail
        ? 'Gmail rejected the username or password. Check that SMTP_USER is the full Gmail address and SMTP_PASSWORD is a current Google App Password (16 letters, generated for this purpose). A normal account password never works, and an App Password stops working if 2-Step Verification is turned off or the password was revoked.'
        : 'The mail server rejected the username or password. Check SMTP_USER and SMTP_PASSWORD.',
      retryable: false,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EDNS') return { code: 'host_not_found', message: `The mail server name ${settings?.host ? `"${settings.host}" ` : ''}could not be found. Check SMTP_HOST (for Gmail: smtp.gmail.com).`, retryable: false };
  if (code === 'ECONNREFUSED') return { code: 'connection_refused', message: `The mail server refused the connection${settings ? ` on port ${settings.port}` : ''}. Check SMTP_HOST and SMTP_PORT (Gmail: 587 with STARTTLS, or 465 with SMTP_SECURE=true) and that outgoing connections on that port are not blocked by a firewall.`, retryable: true };
  if (code === 'ETIMEDOUT' || /time(d)? ?out/i.test(raw)) {
    return { code: 'timeout', message: 'The mail server did not answer in time. Check the network and SMTP_PORT; some networks block ports 587 and 465.', retryable: true };
  }
  if (code === 'ETLS' || /tls|ssl|certificate|wrong version number|starttls/i.test(raw)) {
    return { code: 'tls_failed', message: 'The secure connection to the mail server failed. For port 587 leave SMTP_SECURE unset (STARTTLS); for port 465 set SMTP_SECURE=true.', retryable: false };
  }
  if (rc === 550 && /5\.4\.5|daily|quota|limit/i.test(raw) || rc === 421 || rc === 450 || rc === 451 || rc === 452 || /rate|too many|try again|temporar/i.test(raw) && rc >= 400 && rc < 500) {
    return { code: 'rate_limited', message: 'The mail server is limiting how much can be sent right now (Gmail allows roughly 500 messages a day on a normal account). The message will be retried automatically.', retryable: true };
  }
  if (rc === 552 || /message size|too large/i.test(raw)) return { code: 'message_too_large', message: 'The message was too large for the mail server.', retryable: false };
  if (code === 'EENVELOPE' || rc === 553 || rc === 550 || rc === 551 || rc === 554) {
    return { code: /sender|from/i.test(raw) ? 'sender_rejected' : 'recipient_rejected', message: `The mail server did not accept the message: ${safe(raw)}`, retryable: false };
  }
  return { code: 'unknown', message: `Sending failed: ${safe(raw) || 'unknown error'}`, retryable: true };
}
