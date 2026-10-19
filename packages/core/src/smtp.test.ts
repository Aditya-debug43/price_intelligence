import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';
import { SmtpConfigError, addressOf, describeSmtpError, isGmailHost, normalizeSmtpPassword, resolveSmtp, isUnroutableRecipient } from './smtp.ts';

describe('resolving email settings', () => {
  it('is not configured when no host is set', () => {
    expect(resolveSmtp({})).toBeNull();
    expect(resolveSmtp({ EMAIL_FROM: 'Shelfwatch <a@b.example>' })).toBeNull();
  });

  it('configures Gmail from the address and an App Password: port 587 + STARTTLS by default, sender = the account', () => {
    const s = resolveSmtp({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASSWORD: 'abcd efgh ijkl mnop' })!;
    expect(s).toMatchObject({ host: 'smtp.gmail.com', port: 587, secure: false, user: 'me@gmail.com', password: 'abcdefghijklmnop', from: 'Shelfwatch <me@gmail.com>', fromAddress: 'me@gmail.com' });
  });

  it('port 465 means implicit TLS; SMTP_SECURE can say so explicitly', () => {
    expect(resolveSmtp({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_USER: 'me@gmail.com', SMTP_PASSWORD: 'x' })).toMatchObject({ port: 465, secure: true });
    expect(resolveSmtp({ SMTP_HOST: 'smtp.example.com', SMTP_SECURE: true, SMTP_USER: 'u', SMTP_PASSWORD: 'p', EMAIL_FROM: 'Shop <shop@example.com>' })).toMatchObject({ port: 465, secure: true });
  });

  it('only removes the spaces of a Google App Password, never from other providers’ passwords', () => {
    expect(normalizeSmtpPassword('smtp.gmail.com', 'abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
    expect(normalizeSmtpPassword('smtp.example.com', 'pass word with spaces')).toBe('pass word with spaces');
    expect(isGmailHost('SMTP.GMAIL.COM')).toBe(true);
    expect(isGmailHost('smtp.gmail.com.evil.test')).toBe(false);
  });

  it('refuses configurations that cannot work, with the reason', () => {
    expect(() => resolveSmtp({ SMTP_HOST: 'smtp.gmail.com' })).toThrow(/SMTP_USER/);
    expect(() => resolveSmtp({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u' })).toThrow(/together/);
    expect(() => resolveSmtp({ SMTP_USER: 'u', SMTP_PASSWORD: 'p' })).toThrow(/SMTP_HOST/);
    expect(() => resolveSmtp({ SMTP_HOST: 'relay.example.com' })).toThrow(/EMAIL_FROM/);
    expect(() => resolveSmtp({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASSWORD: 'x', EMAIL_FROM: 'Shop <someone-else@shop.example>' })).toThrow(/must use me@gmail.com/);
    expect(() => resolveSmtp({ SMTP_HOST: 'relay.example.com', EMAIL_FROM: 'not an address' })).toThrow(SmtpConfigError);
  });

  it('extracts the address from a From header', () => {
    expect(addressOf('Shelfwatch <reports@example.com>')).toBe('reports@example.com');
    expect(addressOf('reports@example.com')).toBe('reports@example.com');
  });

  it('flows through the environment loader, and an invalid email setting fails the start with a clear message', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASSWORD: 'abcd efgh ijkl mnop', SMTP_PORT: '465' } as unknown as NodeJS.ProcessEnv);
    expect(c.smtp).toMatchObject({ port: 465, secure: true, password: 'abcdefghijklmnop' });
    expect(c.emailFrom).toBe('Shelfwatch <me@gmail.com>');
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', SMTP_HOST: 'smtp.gmail.com' } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(loadConfig({ DATABASE_URL: 'postgres://x' } as unknown as NodeJS.ProcessEnv).smtp).toBeNull();
  });

  it('never carries the password in its error messages', () => {
    for (const env of [{ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASSWORD: 'SuperSecretValue123', EMAIL_FROM: 'x <x@y.example>' }]) {
      try {
        resolveSmtp(env);
      } catch (e) {
        expect((e as Error).message).not.toContain('SuperSecretValue123');
      }
    }
  });
});

describe('reading SMTP failures in plain language', () => {
  const gmail = { host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com' };
  it('Google refusing a normal password / requiring an App Password', () => {
    const p = describeSmtpError({ code: 'EAUTH', responseCode: 534, response: '534-5.7.9 Application-specific password required' }, gmail);
    expect(p).toMatchObject({ code: 'app_password_required', retryable: false });
    expect(p.message).toMatch(/2-Step Verification/);
    expect(p.message).toMatch(/apppasswords/);
  });

  it('bad credentials: not retryable, tells what to check, does not echo the server text', () => {
    const p = describeSmtpError({ code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted. BadCredentials hunter2' }, gmail);
    expect(p).toMatchObject({ code: 'auth_failed', retryable: false });
    expect(p.message).toMatch(/App Password/);
    expect(p.message).not.toContain('hunter2');
  });

  it('network problems are retryable and name the setting to check', () => {
    expect(describeSmtpError({ code: 'ECONNREFUSED' }, gmail)).toMatchObject({ code: 'connection_refused', retryable: true });
    expect(describeSmtpError({ code: 'ETIMEDOUT', message: 'Connection timeout' }, gmail)).toMatchObject({ code: 'timeout', retryable: true });
    expect(describeSmtpError({ code: 'ENOTFOUND' }, { ...gmail, host: 'smtp.gmial.com' }).message).toContain('smtp.gmial.com');
  });

  it('TLS mismatches say which setting to change', () => {
    const p = describeSmtpError({ code: 'ESOCKET', message: 'wrong version number' }, gmail);
    expect(p.code).toBe('tls_failed');
    expect(p.message).toMatch(/SMTP_SECURE/);
  });

  it('daily limits and throttling are retried; rejected recipients and unknown errors are explained without secrets', () => {
    expect(describeSmtpError({ responseCode: 550, response: '550-5.4.5 Daily user sending quota exceeded' }, gmail)).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(describeSmtpError({ responseCode: 550, response: '550 5.1.1 no such mailbox' }, gmail)).toMatchObject({ code: 'recipient_rejected', retryable: false });
    const u = describeSmtpError({ message: 'weird failure password=hunter2 happened' }, null);
    expect(u.message).not.toContain('hunter2');
  });
});

describe('addresses that can never receive mail', () => {
  it('reserved names (RFC 2606 / 6761) are unroutable; ordinary and subdomain addresses are not', () => {
    for (const a of ['owner@localhost.test', 'audit@example.test', 'x@example.com', 'x@mail.example.org', 'x@foo.invalid', 'x@something.localhost', 'Owner <o@shop.example.net>', 'no-at-sign', '']) {
      expect(isUnroutableRecipient(a), a).toBe(true);
    }
    for (const a of ['someone@gmail.com', 'chai+tag@gmail.com', 'info@groceriestogoaruba.com', 'Sam <sam@my-example.com>', 'a@testing.io', 'a@exampleshop.com']) {
      expect(isUnroutableRecipient(a), a).toBe(false);
    }
  });
});
