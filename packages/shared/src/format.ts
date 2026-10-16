// Display helpers shared by the web app, PDF/Excel exports and email summaries.
// Keeping one implementation guarantees every output renders the same value identically.

export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  const code = currency ?? '';
  const n = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return code ? `${code} ${n}` : n;
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatDateTime(iso: string | null | undefined, timeZone = 'America/Aruba'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function ageHours(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

/** "3 h ago", "2 d ago" — used next to every observed value so freshness is always visible. */
export function formatAge(iso: string | null | undefined, now: Date = new Date()): string {
  const h = ageHours(iso, now);
  if (h === null) return 'never observed';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export const CAPABILITY_LABELS: Record<string, string> = {
  full: 'Full',
  partial: 'Partial',
  limited: 'Limited',
  blocked: 'Blocked',
  failed: 'Failed',
};

export const CAPABILITY_EXPLANATIONS: Record<string, string> = {
  full: 'The main requested information is accessible with good coverage.',
  partial: 'Useful information is available, but some fields or products are missing.',
  limited: 'Only a restricted subset of the analysis is feasible.',
  blocked: 'Collection cannot proceed under the permitted access conditions.',
  failed: 'A temporary or unexpected technical error occurred. This is not an empty catalogue.',
};
