import { DateTime } from 'luxon';

/**
 * Timezone-aware scheduling math. Always uses IANA identifiers (e.g. "America/Aruba"); never a fixed UTC offset.
 */

export function isValidIana(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given zone. */
export function localDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

/** The instant at which `hhmm` (e.g. "09:00") occurs on local calendar date `date` in `zone`. */
export function deadlineInstant(date: string, hhmm: string, zone: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const dt = DateTime.fromISO(date, { zone }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`Invalid schedule: ${date} ${hhmm} ${zone}`);
  return dt.toJSDate();
}

/** The next report deadline that is still in the future (or exactly now). */
export function nextDeadline(now: Date, hhmm: string, zone: string): { date: string; at: Date } {
  const today = localDate(now, zone);
  const todays = deadlineInstant(today, hhmm, zone);
  if (todays.getTime() >= now.getTime()) return { date: today, at: todays };
  const tomorrow = DateTime.fromISO(today, { zone }).plus({ days: 1 }).toISODate()!;
  return { date: tomorrow, at: deadlineInstant(tomorrow, hhmm, zone) };
}

export interface StartTimeInput {
  deadline: Date;
  /** Measured durations (ms) of recent complete collection runs per site, newest first. Empty => unknown. */
  siteDurationsMs: number[][];
  /** Fallback estimate per site when nothing has been measured yet. */
  defaultSiteDurationMs: number;
  /** Time to match, analyse, build the snapshot and send emails. */
  assemblyMs: number;
  /** Multiplier applied to the slowest site's P90 duration. */
  safetyFactor: number;
  minLeadMs: number;
  maxLeadMs: number;
}

export interface StartTimePlan {
  startAt: Date;
  /** Latest moment collection may still be running; after this a partial report is assembled. */
  assembleAt: Date;
  slowestSiteMs: number;
  leadMs: number;
  basis: string;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

/**
 * Sites are collected in parallel, so the schedule is driven by the slowest site's measured P90 duration
 * (not the sum), multiplied by a safety factor, plus report assembly time.
 */
export function planStartTime(i: StartTimeInput): StartTimePlan {
  const perSite = i.siteDurationsMs.map((d) => (d.length ? percentile(d, 90) : i.defaultSiteDurationMs));
  const slowest = perSite.length ? Math.max(...perSite) : i.defaultSiteDurationMs;
  const measured = i.siteDurationsMs.some((d) => d.length > 0);
  const raw = slowest * i.safetyFactor + i.assemblyMs;
  const lead = Math.min(i.maxLeadMs, Math.max(i.minLeadMs, raw));
  return {
    startAt: new Date(i.deadline.getTime() - lead),
    assembleAt: new Date(i.deadline.getTime() - i.assemblyMs),
    slowestSiteMs: slowest,
    leadMs: lead,
    basis: measured
      ? `P90 of measured runs (slowest site ${Math.round(slowest / 60000)} min) × ${i.safetyFactor} + ${Math.round(i.assemblyMs / 60000)} min assembly`
      : `no measured runs yet; default ${Math.round(i.defaultSiteDurationMs / 60000)} min per site × ${i.safetyFactor} + assembly`,
  };
}

export interface RefreshBudgetInput {
  availableMs: number;
  crawlDelayMs: number;
  avgLatencyMs: number;
  maxConcurrency: number;
  policyMaxRequests: number;
}

/** How many requests a site can be given in the available window while honouring its crawl delay. */
export function requestBudget(i: RefreshBudgetInput): number {
  const perRequest = Math.max(i.crawlDelayMs, 1) + Math.max(i.avgLatencyMs / Math.max(i.maxConcurrency, 1), 0);
  const byTime = Math.floor(i.availableMs / perRequest);
  return Math.max(0, Math.min(byTime, i.policyMaxRequests));
}

export type DailyAction = 'wait' | 'collect' | 'assemble' | 'done';

/**
 * Decide what the scheduler tick should do for an org for today's deadline:
 *  - `collect`  : start time reached and nothing started yet (also when we are already late — better a partial report than none);
 *  - `assemble` : collection started but the assembly cut-off has been reached, so publish what exists (flagged partial if incomplete);
 *  - `wait`     : not yet time, or collection is in progress and still within budget;
 *  - `done`     : today's report already exists.
 */
export function decideDailyAction(
  now: Date,
  plan: StartTimePlan,
  state: { collectionStarted: boolean; reportExists: boolean },
): DailyAction {
  if (state.reportExists) return 'done';
  if (now < plan.startAt) return 'wait';
  if (!state.collectionStarted) return 'collect';
  if (now >= plan.assembleAt) return 'assemble';
  return 'wait';
}
