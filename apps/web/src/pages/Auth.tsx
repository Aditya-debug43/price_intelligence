import { formatDateTime } from '@ci/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, errorMessage, fieldErrors } from '../api';
import { useMe } from '../app-shell';
import { Field, Spinner, useDocumentTitle } from '../ui';
import type { Me } from '../types';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="auth-wrap">
      <div className="auth-side">
        <div className="row" style={{ gap: 10 }}>
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="6" fill="#ffd43b" />
            <rect x="5" y="8" width="22" height="16" rx="2" fill="#10252b" />
            <rect x="8" y="11" width="9" height="3.5" fill="#ffd43b" />
            <rect x="8" y="17" width="16" height="3.5" fill="#0e6e73" />
          </svg>
          <b style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: '#fff' }}>Shelfwatch</b>
        </div>
        <div>
          <h1>Know what everyone else charges before you open the shop.</h1>
          <p style={{ maxWidth: '44ch', marginTop: 14, color: '#b6cdcb' }}>
            Prices, stock risks, offers and campaigns from your competitors — every number with its source and the time we saw it.
          </p>
        </div>
        <ul className="small" style={{ color: '#9bb3b6', maxWidth: '46ch', margin: 0, paddingLeft: 18 }}>
          <li>Every price shows the page it came from and when we saw it.</li>
          <li>A website that cannot be collected is reported as not collected — never as empty or cheap.</li>
          <li>Nothing is estimated or invented.</li>
        </ul>
      </div>
      <div className="auth-form">
        <h2 style={{ fontSize: 26 }}>{title}</h2>
        {subtitle && <p className="muted" style={{ marginTop: 6 }}>{subtitle}</p>}
        <div style={{ marginTop: 18 }}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Where to go after signing in: back to an invitation the person was opening. Only an invitation path is accepted — anything else in the
 * address is ignored, so the sign-in page can never be used to bounce someone to another site.
 */
export function nextOf(sp: URLSearchParams): string | null {
  const n = sp.get('next') ?? '';
  return /^\/invite\?token=[A-Za-z0-9_-]{20,200}$/.test(n) ? n : null;
}

function useAuthSuccess(next: string | null = null) {
  const nav = useNavigate();
  const qc = useQueryClient();
  return async (res: Me) => {
    qc.setQueryData(['me'], res);
    if (next) {
      nav(next, { replace: true });
      return;
    }
    const last = localStorage.getItem('sw.org');
    const m = res.memberships.find((x) => x.orgId === last) ?? res.memberships[0];
    if (m) {
      localStorage.setItem('sw.org', m.orgId);
      nav(`/o/${m.orgId}`, { replace: true });
    } else nav('/onboarding', { replace: true });
  };
}

export function LoginPage() {
  const [sp] = useSearchParams();
  const next = nextOf(sp);
  const [email, setEmail] = useState(next ? (sp.get('email') ?? '') : '');
  const [password, setPassword] = useState('');
  const done = useAuthSuccess(next);
  const m = useMutation({ mutationFn: () => api.post<Me>('/api/v1/auth/login', { email, password }), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <AuthFrame title="Sign in" subtitle="Welcome back. Your latest report is waiting.">
      <form className="stack" onSubmit={submit}>
        <Field label="Email">{(id) => <input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <Field label="Password">{(id) => <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
        <button className="btn btn-primary" disabled={m.isPending}>{m.isPending ? 'Signing in…' : 'Sign in'}</button>
        <div className="row between small">
          <Link to="/forgot">Forgot your password?</Link>
          <span>New here? <Link to={next ? `/register?next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}` : '/register'}>Create an account</Link></span>
        </div>
      </form>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const [sp] = useSearchParams();
  const next = nextOf(sp);
  const invitedEmail = next ? (sp.get('email') ?? '') : '';
  const [form, setForm] = useState({ displayName: '', email: invitedEmail, password: '' });
  const [sent, setSent] = useState(false);
  const done = useAuthSuccess(next);
  const m = useMutation({
    mutationFn: () => api.post<{ user: Me['user']; verificationRequired: boolean }>('/api/v1/auth/register', form),
    onSuccess: (r) => (r.verificationRequired ? setSent(true) : void done({ user: r.user, memberships: [] })),
  });
  const fe = fieldErrors(m.error);
  if (sent)
    return (
      <AuthFrame title="Check your email">
        <div className="callout good">We sent a verification link to <b>{form.email}</b>. Open it, then <Link to={next ? `/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(form.email)}` : '/login'}>sign in</Link>{next ? ' to join the workspace you were invited to' : ''}.</div>
      </AuthFrame>
    );
  return (
    <AuthFrame title="Create your account" subtitle={next ? 'Use the email address the invitation was sent to.' : 'You’ll set up your business and add your competitors next.'}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Your name" error={fe.displayName}>{(id) => <input id={id} type="text" autoComplete="name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />}</Field>
        <Field label="Email" error={fe.email}>{(id) => <input id={id} type="email" autoComplete="username" value={form.email} readOnly={!!invitedEmail} onChange={(e) => setForm({ ...form, email: e.target.value })} required />}</Field>
        <Field label="Password" hint="At least 10 characters. Avoid common words." error={fe.password}>
          {(id) => <input id={id} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={10} required />}
        </Field>
        {m.error && !Object.keys(fe).length && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
        <button className="btn btn-primary" disabled={m.isPending}>{m.isPending ? 'Creating…' : 'Create account'}</button>
        <span className="small">Already registered? <Link to={next ? `/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(form.email)}` : '/login'}>Sign in</Link></span>
      </form>
    </AuthFrame>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/api/v1/auth/forgot-password', { email }) });
  return (
    <AuthFrame title="Reset your password" subtitle="Enter your email and we’ll send a reset link if an account exists.">
      {m.isSuccess ? (
        <div className="callout good">If an account exists for <b>{email}</b>, a reset link is on its way. It expires in one hour.</div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
          {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
          <button className="btn btn-primary" disabled={m.isPending}>Send reset link</button>
        </form>
      )}
      <p className="small" style={{ marginTop: 14 }}><Link to="/login">Back to sign in</Link></p>
    </AuthFrame>
  );
}

export function ResetPage() {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const [password, setPassword] = useState('');
  const nav = useNavigate();
  const m = useMutation({ mutationFn: () => api.post('/api/v1/auth/reset-password', { token, password }), onSuccess: () => setTimeout(() => nav('/login'), 1500) });
  return (
    <AuthFrame title="Choose a new password">
      {m.isSuccess ? (
        <div className="callout good">Password updated. Taking you to sign in…</div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          {!token && <div className="callout bad">This link is missing its token. Request a new reset email.</div>}
          <Field label="New password" hint="At least 10 characters.">{(id) => <input id={id} type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
          {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
          <button className="btn btn-primary" disabled={m.isPending || !token}>Save password</button>
        </form>
      )}
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const m = useMutation({ mutationFn: () => api.post('/api/v1/auth/verify-email', { token }) });
  return (
    <AuthFrame title="Verify your email">
      {m.isSuccess ? (
        <div className="callout good">Email verified. <Link to="/login">Sign in</Link></div>
      ) : (
        <div className="stack">
          <p>Confirm that this is your email address.</p>
          {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
          <button className="btn btn-primary" disabled={m.isPending || !token} onClick={() => m.mutate()}>{m.isPending ? <Spinner /> : 'Verify my email'}</button>
        </div>
      )}
    </AuthFrame>
  );
}

export function OnboardingPage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<{ organization: { id: string } }>('/api/v1/orgs', { name }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      localStorage.setItem('sw.org', r.organization.id);
      nav(`/o/${r.organization.id}/setup`, { replace: true });
    },
  });
  if (me.isLoading) return null;
  if (!me.data) {
    nav('/login', { replace: true });
    return null;
  }
  return (
    <AuthFrame title="Name your business" subtitle="This creates your private workspace. Everything you add stays visible only to the people you invite.">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Business name" hint="For example: Groceries To Go Aruba">{(id) => <input id={id} type="text" value={name} onChange={(e) => setName(e.target.value)} minLength={2} required />}</Field>
        {m.error instanceof ApiError && <div className="callout bad" role="alert">{m.error.message}</div>}
        <button className="btn btn-primary" disabled={m.isPending}>Create workspace</button>
      </form>
    </AuthFrame>
  );
}

interface InvitationPreviewView { workspace: string; role: 'owner' | 'admin' | 'staff'; email: string; invitedBy: string | null; expiresAt: string }

/** The page an invitation link opens. It says what the invitation is for, and only lets the invited address accept it. */
export function InvitePage() {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const preview = useQuery({
    queryKey: ['invitation', token],
    enabled: !!token,
    retry: false,
    queryFn: async () => (await api.get<{ invitation: InvitationPreviewView }>(`/api/v1/invitations/preview?token=${encodeURIComponent(token)}`)).invitation,
  });
  const accept = useMutation({
    mutationFn: () => api.post<{ orgId: string }>('/api/v1/invitations/accept', { token }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      localStorage.setItem('sw.org', r.orgId);
      nav(`/o/${r.orgId}`, { replace: true });
    },
  });
  const logout = useMutation({
    mutationFn: () => api.post('/api/v1/auth/logout'),
    onSuccess: async () => {
      qc.clear();
      window.location.reload();
    },
  });
  const here = `/invite?token=${token}`;
  const inv = preview.data;
  const roleText = { owner: 'an owner', admin: 'an admin (can manage data)', staff: 'staff (view only)' };

  if (!token) return <AuthFrame title="Invitation"><div className="callout bad" role="alert">This link is missing its invitation code. Open the link from the invitation email again.</div></AuthFrame>;
  if (preview.isLoading || me.isLoading) return <AuthFrame title="Invitation"><Spinner label="Opening your invitation" /></AuthFrame>;
  if (preview.isError || !inv) {
    return (
      <AuthFrame title="This invitation can’t be used">
        <div className="callout bad" role="alert">{errorMessage(preview.error)}</div>
        <p className="small muted" style={{ marginTop: 12 }}>Ask whoever invited you to send a new one. Already have an account? <Link to="/login">Sign in</Link>.</p>
      </AuthFrame>
    );
  }
  const signedInAs = me.data?.user.email.trim().toLowerCase();
  const isInvitee = signedInAs === inv.email.trim().toLowerCase();
  return (
    <AuthFrame title={`Join ${inv.workspace}`} subtitle={`${inv.invitedBy ?? 'A colleague'} invited ${inv.email} to join as ${roleText[inv.role]}.`}>
      <div className="stack">
        {!me.data ? (
          <>
            <p>Sign in — or create an account — with <b>{inv.email}</b> to join. The invitation only works for that address.</p>
            <div className="row">
              <Link className="btn btn-primary" to={`/login?next=${encodeURIComponent(here)}&email=${encodeURIComponent(inv.email)}`}>Sign in</Link>
              <Link className="btn" to={`/register?next=${encodeURIComponent(here)}&email=${encodeURIComponent(inv.email)}`}>Create an account</Link>
            </div>
          </>
        ) : isInvitee ? (
          <>
            <p>You’re signed in as <b>{me.data.user.email}</b>. Join <b>{inv.workspace}</b> to see its prices, stock and reports.</p>
            {accept.error && <div className="callout bad" role="alert">{errorMessage(accept.error)}</div>}
            <button className="btn btn-primary" onClick={() => accept.mutate()} disabled={accept.isPending}>{accept.isPending ? 'Joining…' : `Join ${inv.workspace}`}</button>
          </>
        ) : (
          <>
            <div className="callout warn" role="alert">You’re signed in as <b>{me.data.user.email}</b>, but this invitation is for <b>{inv.email}</b>. Sign out, then sign in or register with that address.</div>
            <button className="btn" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</button>
          </>
        )}
        <p className="small muted" style={{ margin: 0 }}>The link works once and expires on {formatDateTime(inv.expiresAt)}.</p>
      </div>
    </AuthFrame>
  );
}
