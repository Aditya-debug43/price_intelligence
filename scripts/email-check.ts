/**
 * Checks real email delivery from this machine, the same way the application sends: reads SMTP_* from .env, signs in to the mail server and
 * (optionally) sends one test message.
 *
 *   npm run email:check                       # connect and sign in only — nothing is sent
 *   npm run email:check -- you@example.com    # also send a real test message to that address
 *
 * It prints what it is using (never the password) and, on failure, the plain-language reason and what to change.
 */
import { describeSmtpError, loadConfig, loadDotEnv } from '@ci/core';
import { createSmtpTransport, testEmail } from '@ci/services';
import { root } from './lib/root.ts';

loadDotEnv(root);
let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`\nThe configuration is not valid:\n${(e as Error).message}\n`);
  process.exit(1);
}

const smtp = config.smtp;
if (!smtp) {
  console.log(`
Email delivery is NOT configured: no message can be sent, and nobody can register or reset a password until it is.

Add these to the .env file in the project folder (see docs/integrations.md), then run this check again:

  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_USER=<your Gmail address>
  SMTP_PASSWORD=<a Google App Password — not your normal password>
  APP_BASE_URL=<the address people open the app at, used inside email links>
`);
  process.exit(2);
}

console.log('\nUsing:');
console.log(`  server    ${smtp.host}:${smtp.port}  (${smtp.secure ? 'implicit TLS' : 'STARTTLS'})`);
console.log(`  sign in   ${smtp.user ?? '(no sign-in)'}   password: ${smtp.password ? `set (${smtp.password.length} characters)` : 'none'}`);
console.log(`  sender    ${smtp.from}`);
console.log(`  links in emails point to   ${config.APP_BASE_URL}`);
if (/localhost|127\.0\.0\.1/.test(config.APP_BASE_URL)) console.log('  (these links only work on this computer; set APP_BASE_URL to the public address for other people)');

const transport = createSmtpTransport(smtp);
console.log('\n1. Connecting and signing in…');
try {
  await transport.verify?.();
  console.log('   OK — the mail server accepted the connection and the sign-in.');
} catch (e) {
  const p = describeSmtpError(e, smtp);
  console.error(`   FAILED (${p.code}): ${p.message}\n`);
  process.exit(3);
}

const to = process.argv.slice(2).find((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
if (!to) {
  console.log('\nNothing was sent. To send a real test message run:  npm run email:check -- you@example.com\n');
  process.exit(0);
}
console.log(`\n2. Sending a test message to ${to}…`);
try {
  const m = testEmail('there', smtp.from, smtp.host);
  const info = await transport.sendMail({ from: smtp.from, to: [to], subject: m.subject, html: m.html, text: m.text });
  console.log(`   Accepted by the mail server.  Message-ID ${info.messageId ?? '(none)'}   server said: ${info.response ?? '(nothing)'}`);
  console.log(`\nNow check the inbox of ${to} (and its spam folder). If it arrived, email delivery works.\n`);
} catch (e) {
  const p = describeSmtpError(e, smtp);
  console.error(`   FAILED (${p.code}): ${p.message}\n`);
  process.exit(4);
}
transport.close?.();
