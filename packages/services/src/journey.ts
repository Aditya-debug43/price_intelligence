import { and, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULTS } from '@ci/shared';
import { productMatches, reports, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { loadCoverage } from './coverage.ts';

export type JourneyStepState = 'done' | 'current' | 'todo' | 'optional';

export interface JourneyStep {
  id: 'workspace' | 'own_site' | 'competitors' | 'capabilities' | 'permissions' | 'collection' | 'matches' | 'report' | 'alerts';
  title: string;
  state: JourneyStepState;
  /** One plain sentence about where this step stands, computed from real data. */
  detail: string;
  /** Where the customer goes to act on it, relative to the workspace (e.g. "setup", "websites", "matches"). */
  action: { label: string; to: string } | null;
}

export interface Journey {
  steps: JourneyStep[];
  /** True once every required step is done (the optional alerts step does not count). */
  complete: boolean;
  next: JourneyStep | null;
}

/**
 * The guided path from an empty workspace to a first report. Every state is derived from what really exists in the database — a step is
 * only "done" when the thing it describes has actually happened, never because a page was visited.
 */
export async function loadJourney(svc: Pick<Services, 'config' | 'clock'>, db: DbLike, orgId: string): Promise<Journey> {
  const coverage = (await loadCoverage(db, orgId, svc.clock(), DEFAULTS.staleAfterHours)).filter((c) => c.status?.state !== 'inactive');
  const source = coverage.filter((c) => c.role === 'source');
  const competitors = coverage.filter((c) => c.role === 'competitor');

  const profiled = coverage.filter((c) => c.status?.state !== 'not_profiled');
  // Websites that refuse automated access cannot be given permission to; they are reported, not blocking.
  const collectable = coverage.filter((c) => c.status?.state !== 'access_denied' && c.status?.state !== 'unsupported');
  // Permission is judged from the recorded consent itself — a website that has not been checked yet can still be waiting for it.
  const awaitingPermission = collectable.filter((c) => c.consent !== 'confirmed');
  const collecting = coverage.filter((c) => c.status?.state === 'collecting');
  const haveData = coverage.filter((c) => c.productsKnown > 0);
  const needData = collectable.filter((c) => c.productsKnown === 0);
  const cannot = coverage.filter((c) => c.status?.state === 'access_denied' || c.status?.state === 'unsupported' || c.status?.state === 'failed');

  const [review] = await db.select({ n: sql<number>`count(*)::int` }).from(productMatches).where(and(eq(productMatches.orgId, orgId), eq(productMatches.status, 'needs_review')));
  const [anyMatch] = await db.select({ n: sql<number>`count(*)::int` }).from(productMatches).where(and(eq(productMatches.orgId, orgId), inArray(productMatches.status, ['auto', 'accepted'])));
  const [reportCount] = await db.select({ n: sql<number>`count(*)::int` }).from(reports).where(and(eq(reports.orgId, orgId), inArray(reports.status, ['ready', 'partial'])));
  const needsReview = review?.n ?? 0;
  const hasReport = (reportCount?.n ?? 0) > 0;

  const steps: { step: JourneyStep; done: boolean }[] = [];
  const add = (step: Omit<JourneyStep, 'state'>, done: boolean, optional = false) => steps.push({ step: { ...step, state: optional ? 'optional' : done ? 'done' : 'todo' }, done });

  add({ id: 'workspace', title: 'Create your workspace', detail: 'Your private workspace exists.', action: null }, true);
  add(
    { id: 'own_site', title: 'Add your own website', detail: source.length ? `${source[0]!.name} (${source[0]!.hostname})` : 'The shop whose prices and stock you want to protect.', action: source.length ? null : { label: 'Add your website', to: 'setup' } },
    source.length > 0,
  );
  add(
    {
      id: 'competitors',
      title: `Add ${DEFAULTS.minCompetitors}–${DEFAULTS.maxCompetitors} competitors`,
      detail:
        competitors.length === 0
          ? 'Add the websites you compete with.'
          : competitors.length < DEFAULTS.minCompetitors
            ? `${competitors.length} added. Add at least ${DEFAULTS.minCompetitors} for comparisons that mean something.`
            : `${competitors.length} competitors added.`,
      action: competitors.length >= DEFAULTS.minCompetitors ? null : { label: 'Add competitors', to: 'setup' },
    },
    competitors.length >= DEFAULTS.minCompetitors,
  );
  add(
    {
      id: 'capabilities',
      title: 'Check what each website allows',
      detail: coverage.length === 0 ? 'Runs after you add websites.' : profiled.length === coverage.length ? `All ${coverage.length} websites checked.` : `${profiled.length} of ${coverage.length} websites checked.`,
      action: coverage.length && profiled.length < coverage.length ? { label: 'Check websites', to: 'websites' } : null,
    },
    coverage.length > 0 && profiled.length === coverage.length,
  );
  add(
    {
      id: 'permissions',
      title: 'Record permission to collect',
      detail:
        profiled.length < coverage.length || coverage.length === 0
          ? 'Runs after the websites have been checked.'
          : awaitingPermission.length
            ? `${awaitingPermission.length} website${awaitingPermission.length === 1 ? '' : 's'} still need${awaitingPermission.length === 1 ? 's' : ''} permission. Nothing is collected without it.`
            : 'Permission is recorded for every website that can be collected.',
      action: awaitingPermission.length && profiled.length === coverage.length ? { label: 'Record permission', to: 'websites' } : null,
    },
    collectable.length > 0 && awaitingPermission.length === 0 && profiled.length === coverage.length,
  );
  const collectionDone = collectable.length > 0 && needData.length === 0 && collecting.length === 0;
  add(
    {
      id: 'collection',
      title: 'Collect the catalogues',
      detail: collecting.length
        ? `Collection is running for ${collecting.length} website${collecting.length === 1 ? '' : 's'}.`
        : collectionDone
          ? `Collected from ${haveData.length} website${haveData.length === 1 ? '' : 's'}.${cannot.length ? ` ${cannot.length} could not be collected and is reported as such.` : ''}`
          : needData.length
            ? `${needData.length} website${needData.length === 1 ? '' : 's'} not collected yet.`
            : 'Runs after permission is recorded.',
      action: !collectionDone && !collecting.length && awaitingPermission.length === 0 && needData.length ? { label: 'Start collection', to: 'websites' } : null,
    },
    collectionDone,
  );
  add(
    {
      id: 'matches',
      title: 'Review product matches',
      detail: needsReview ? `${needsReview} match${needsReview === 1 ? '' : 'es'} need your decision; they are not used for price conclusions until you decide.` : (anyMatch?.n ?? 0) > 0 ? 'No matches are waiting for review.' : 'Runs once your products and a competitor’s are collected.',
      action: needsReview ? { label: 'Review matches', to: 'matches' } : null,
    },
    (anyMatch?.n ?? 0) > 0 && needsReview === 0,
  );
  add(
    {
      id: 'report',
      title: 'Generate your first report',
      detail: hasReport && haveData.length ? 'You have a saved report.' : haveData.length ? 'Create a report from what has been collected.' : hasReport ? 'Earlier reports were created before anything was collected and contain no findings.' : 'Needs collected data.',
      action: (hasReport && haveData.length) || !haveData.length ? null : { label: 'Generate report', to: 'reports' },
    },
    // A report only counts once it can contain findings: an empty workspace's report is not progress.
    hasReport && haveData.length > 0,
  );
  add(
    {
      id: 'alerts',
      title: 'Set alerts and the daily schedule',
      detail: svc.config.SMTP_URL ? 'Choose who gets email alerts and when the daily report is ready.' : 'Email delivery is not configured on this server, so alerts stay in the app. Reports are still ready each morning.',
      action: { label: 'Open settings', to: 'settings?tab=notifications' },
    },
    false,
    true,
  );

  // The first required step that is not done is "current"; everything after it that is not done stays "todo".
  let currentSet = false;
  const out = steps.map(({ step, done }) => {
    if (step.state === 'optional' || done) return step;
    if (!currentSet) {
      currentSet = true;
      return { ...step, state: 'current' as const };
    }
    return step;
  });
  const required = out.filter((s) => s.state !== 'optional');
  return { steps: out, complete: required.every((s) => s.state === 'done'), next: out.find((s) => s.state === 'current') ?? null };
}
