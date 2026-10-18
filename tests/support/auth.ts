import { expect } from 'vitest';
import type { ApiClient } from './api-client.ts';
import type { Harness } from './harness.ts';

export const TEST_PASSWORD = 'Correct-Horse-9-Battery';

/**
 * What a real person does, through the real API: register, receive the verification email, open the link, sign in. The email is read from
 * the test mail server's inbox; nothing about the account is marked verified except by using the emailed single-use link.
 */
export async function signUp(client: ApiClient, h: Pick<Harness, 'queue' | 'mail'>, creds: { email: string; password: string; displayName: string }) {
  const reg = await client.post('/api/v1/auth/register', creds);
  expect(reg.status, 'register').toBe(201);
  await h.queue.drain(); // the send-email job delivers the verification message
  const token = h.mail.tokenIn(creds.email, 'verify-email');
  expect(token, 'verification email received').toBeTruthy();
  expect((await client.post('/api/v1/auth/verify-email', { token })).status, 'verify').toBe(200);
  const session = await client.post('/api/v1/auth/login', { email: creds.email, password: creds.password });
  expect(session.status, 'sign in').toBe(200);
  return session.body as { user: { id: string; email: string } };
}
