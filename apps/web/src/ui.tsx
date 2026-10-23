import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { type SiteStatusView, CAPABILITY_EXPLANATIONS, CAPABILITY_LABELS, PROVENANCE_HELP, PROVENANCE_LABELS, formatAge, formatDateTime, formatMoney, formatPct, type PriceView, type Provenance, type UnitPriceView } from '@ci/shared';
import { ApiError, errorMessage } from './api';

// ───────────────────────────────────────────────────────────── icons
const PATHS: Record<string, string> = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  prices: 'M3 12l9-9 9 9-9 9zM9 9h.01',
  offers: 'M20 12l-8 8-9-9V4h7zM8 8h.01',
  stock: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  megaphone: 'M3 11v2a1 1 0 001 1h3l8 4V6L7 10H4a1 1 0 00-1 1zM19 9a4 4 0 010 6',
  report: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  quality: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5L16 9.5',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-2-4-2 1a7 7 0 00-2-1l-.5-2h-5L9 7a7 7 0 00-2 1l-2-1-2 4 2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1l.5 2h5l.5-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z',
  bell: 'M18 16v-5a6 6 0 10-12 0v5l-2 2h16zM10 21h4',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  refresh: 'M20 11a8 8 0 10-2 6M20 4v7h-7',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 006 0zM19 7l-3 7a3 3 0 006 0z',
  users: 'M16 19v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3 3 0 100-6 3 3 0 000 6zM20 19v-1a3 3 0 00-2-2.8',
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.dashboard} />
    </svg>
  );
}

// ───────────────────────────────────────────────────────────── toasts
interface Toast {
  id: number;
  text: string;
  bad?: boolean;
}
const ToastCtx = createContext<{ push: (text: string, bad?: boolean) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 8000 : 4500);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────────────────────────────────────────────────────────── small pieces
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="spinner" role="progressbar" aria-label={label ?? 'Loading'} />
      {label && <span className="muted small">{label}</span>}
    </span>
  );
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} aria-hidden="true" />;
}

export function CapabilityPill({ status, big }: { status: string | null | undefined; big?: boolean }) {
  if (!status) return <span className="pill">Not checked</span>;
  return (
    <span className={`pill ${status}`} title={CAPABILITY_EXPLANATIONS[status]} style={big ? { fontSize: 14, padding: '3px 12px' } : undefined}>
      {CAPABILITY_LABELS[status] ?? status}
    </span>
  );
}

/** The one honest collection state of a website. Colour follows severity; the sentence explains it. */
export function SiteStatusPill({ status }: { status: SiteStatusView | null | undefined }) {
  if (!status) return <span className="pill">Unknown</span>;
  const cls = status.severity === 'ok' ? 'good' : status.severity === 'bad' ? 'bad' : status.severity === 'warn' ? 'warn' : 'info';
  return (
    <span className={`pill ${cls}`} title={status.detail}>
      {status.label}
    </span>
  );
}

/** Where a fact came from: a public page, an authorised connection, an official API, a person, a rate service or a configured value. */
export function ProvenancePill({ value }: { value: Provenance | string | null | undefined }) {
  if (!value) return null;
  const v = value as Provenance;
  const cls = v === 'authorised_api' || v === 'official_api' ? 'info' : '';
  return (
    <span className={`pill ${cls}`} title={PROVENANCE_HELP[v] ?? ''}>
      {PROVENANCE_LABELS[v] ?? value}
    </span>
  );
}

export function Card({ title, actions, children, pad = true, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; id?: string }) {
  return (
    <section className="card" id={id}>
      {title && (
        <div className="card-h">
          <h2>{title}</h2>
          <div className="row">{actions}</div>
        </div>
      )}
      <div className={pad ? 'card-b' : undefined}>{children}</div>
    </section>
  );
}

/** Sets the browser tab / history title, so every page is identifiable (and a screen reader announces it on navigation). */
export function useDocumentTitle(text: string | null | undefined) {
  useEffect(() => {
    if (text) document.title = `${text} · Shelfwatch`;
  }, [text]);
}

/** `docTitle` is for pages whose visible title is rich (a name beside a badge); a plain string title is used as is. */
export function PageHead({ eyebrow, title, subtitle, actions, docTitle }: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; docTitle?: string }) {
  useDocumentTitle(typeof title === 'string' ? title : docTitle);
  return (
    <div className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="row">{actions}</div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="callout bad" role="alert">
      <b>That didn’t load.</b> {errorMessage(error)}
      {error instanceof ApiError && error.status === 404 ? ' It may have been removed, or you may not have access.' : ''}
      {retry && (
        <>
          {' '}
          <button className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

/** Loading → error → empty → content, so every list handles all four states the same way. */
export function DataState<T>({ q, empty, isEmpty, children, skeletonRows = 4 }: { q: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; empty?: ReactNode; isEmpty?: (d: T) => boolean; children: (d: T) => ReactNode; skeletonRows?: number }) {
  if (q.isLoading)
    return (
      <div className="stack-s" aria-busy="true">
        {Array.from({ length: skeletonRows }, (_, i) => (
          <Skeleton key={i} h={22} w={`${95 - i * 9}%`} />
        ))}
      </div>
    );
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.data === undefined) return null;
  if (isEmpty?.(q.data)) return <>{empty}</>;
  return <>{children(q.data)}</>;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  // Callers pass inline closures; keeping the latest one in a ref means the effect below runs exactly once per dialog. (Depending on
  // onClose re-ran it on every parent re-render: focus was pulled back to the dialog frame and the "element to return to" went stale.)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Captured during the first render, i.e. before commit: React's autoFocus moves focus into the dialog at commit time, so by the time an
  // effect runs, document.activeElement is already the dialog's own control rather than the button that opened it.
  const openerRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  useEffect(() => {
    const opener = openerRef.current;
    const dialog = ref.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus(); // an autofocused control inside keeps its focus
    const focusable = () =>
      [...(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => el.offsetParent !== null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      // Keep Tab inside the dialog: wrap from the last control to the first and back.
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        dialog.focus();
      } else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus(); // back to the button that opened it
    };
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div className="modal-h">
          <h2 id={id}>{title}</h2>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className="tab" onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        {total === 0 ? 'No rows' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <span className="row">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── values with provenance
export function Age({ iso, now }: { iso: string | null | undefined; now?: Date }) {
  if (!iso) return <span className="muted">never observed</span>;
  return (
    <time dateTime={iso} title={`Observed ${formatDateTime(iso)}`}>
      {formatAge(iso, now)}
    </time>
  );
}

export function Pct({ value, invert }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const dir = value > 0.5 ? (invert ? 'bad' : 'good') : value < -0.5 ? (invert ? 'good' : 'bad') : '';
  return <span className={`num ${dir === 'good' ? '' : ''}`} style={{ color: dir === 'good' ? 'var(--palm)' : dir === 'bad' ? 'var(--coral)' : undefined, fontWeight: 600 }}>{formatPct(value)}</span>;
}

/**
 * The shelf-edge price tag: shows the price AS DISPLAYED (original currency), the unit-price strip, how it compares, and when it
 * was last observed. Stale observations get a dashed border and are never styled as fresh.
 */
export function PriceTag({ site, price, unit, diffPct, unitDiffPct, directlyComparable, you, stale, matchLabel, href, note, availability, offer, reporting }: {
  site: string;
  price: PriceView;
  unit?: UnitPriceView;
  diffPct?: number | null;
  unitDiffPct?: number | null;
  directlyComparable?: boolean;
  you?: boolean;
  stale?: boolean;
  matchLabel?: string;
  href?: string;
  note?: string;
  availability?: string;
  offer?: string | null;
  reporting: string;
}) {
  const isStale = stale ?? price.stale;
  const shown = price.amount === null ? '—' : price.amount.toFixed(2);
  const diff = directlyComparable ? diffPct : unitDiffPct;
  const cls = diff === null || diff === undefined ? 'na' : diff > 0.5 ? 'down' : diff < -0.5 ? 'up' : '';
  const different = price.currency && price.currency !== reporting;
  return (
    <div className={`ptag${you ? ' you' : ''}${isStale ? ' stale' : ''}`} aria-label={`${site}: ${shown} ${price.currency ?? ''}`}>
      <div className="ptag-top">
        <span className="site" title={site}>{site}</span>
        {matchLabel && <span title="Match class and confidence">{matchLabel}</span>}
      </div>
      <div className="ptag-price">
        <small>{price.currency ?? ''}</small>
        {shown}
        {price.compareAt && <s>{price.compareAt.toFixed(2)}</s>}
        {availability === 'out_of_stock' && <small style={{ color: 'var(--coral)' }}>out of stock</small>}
        {availability === 'limited' || availability === 'low_quantity_claim' ? <small style={{ color: 'var(--amber)' }}>limited</small> : null}
      </div>
      {!you ? (
        <div className={`ptag-strip ${cls}`}>
          <span>{directlyComparable ? (diff === null || diff === undefined ? 'no comparison' : `${formatPct(diff)} vs you`) : unit?.value != null && unitDiffPct != null ? `${formatPct(unitDiffPct)} per unit` : unit?.value != null ? `${unit.value.toFixed(2)} ${unit.unit ?? ''}` : 'unit price n/a'}</span>
          {different && price.normalized !== null && <span className="num" title={`Converted: ${formatMoney(price.normalized, reporting)} (${price.fxSource ?? 'rate'})`}>≈{price.normalized.toFixed(2)} {reporting}</span>}
        </div>
      ) : (
        <div className="ptag-strip">
          <span>Your price</span>
          {unit?.value != null && <span className="num">{unit.value.toFixed(2)} {unit.unit}</span>}
        </div>
      )}
      <div className="ptag-foot">
        <span>
          {isStale && <span className="stale-mark" title="Older than the freshness window — shown with its original observation time">stale · </span>}
          <Age iso={price.observedAt} />
        </span>
        {href && (
          <a href={href} target="_blank" rel="noreferrer noopener" title={`Open the source page${note ? ` — ${note}` : ''}`}>
            source ↗
          </a>
        )}
      </div>
      {offer && <div className="ptag-foot" style={{ background: 'var(--tag-wash)', color: 'var(--ink-2)' }}>{offer}</div>}
    </div>
  );
}

export function StandingBar({ cheap, par, dear }: { cheap: number; par: number; dear: number }) {
  const total = cheap + par + dear;
  if (!total) return <div className="muted small">No confirmed identical matches with comparable prices yet.</div>;
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="standing" role="img" aria-label={`${cheap} products cheaper at your shop, ${par} about equal, ${dear} pricier`}>
      {cheap > 0 && <div className="cheap" style={{ width: w(cheap) }}>{cheap}</div>}
      {par > 0 && <div className="par" style={{ width: w(par) }}>{par}</div>}
      {dear > 0 && <div className="dear" style={{ width: w(dear) }}>{dear}</div>}
    </div>
  );
}

export const money = formatMoney;
export const pct = formatPct;
export const fmtDate = (iso: string | null | undefined) => formatDateTime(iso);

export const ArrowIcon = () => <span aria-hidden="true">↗</span>;

export const COMMON_ZONES = ['America/Aruba', 'America/Curacao', 'America/Bogota', 'America/Panama', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Mexico_City', 'America/Sao_Paulo', 'Europe/Amsterdam', 'Europe/London', 'UTC'];
export const PLATFORM_LABEL: Record<string, string> = { site: 'Website', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', shopify: 'Shopify' };
export const COMMON_CURRENCIES = ['USD', 'AWG', 'EUR', 'ANG', 'CAD', 'GBP', 'COP', 'MXN'];
