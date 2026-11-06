import { desc, eq, sql } from 'drizzle-orm';
import { AUTO_POLICY_VERSION, SUPPORTED_POLICIES, wilson } from '@ci/core';
import type { CoverageTarget, FunnelReason, FunnelStage, MatchFunnelView } from '@ci/shared';
import { aiMatchSuggestions, matchAutoApproval, matchEvalReports, type DbLike } from '@ci/database';
import { OWN } from './match-eval.ts';

/**
 * Where the catalogue stands in matching, counted as DISTINCT own variants: active → a candidate counterpart was found → the AI judged it → an automatic-approval class qualified → an approved
 * counterpart exists (by anyone / automatically) → it is visible in the comparison. Each variant that is not approved has one reason. The headline measure is variants with a current approved
 * counterpart over all active variants: a variant that merely has a SUGGESTED substitute is a candidate, not an automated match, and is never counted as one.
 */

const REASON_LABEL: Record<string, string> = {
  not_worked: 'Not worked on yet',
  waiting_quota: 'Waiting for the free quota',
  retry: 'Will be tried again',
  unanswered: 'The model did not answer for some candidates; will be tried again',
  no_candidate: 'No candidate counterpart found at the competitors',
  no_acceptable_candidate: 'Candidates found, none is a counterpart',
  awaiting_review: 'A counterpart is suggested; waiting for a person (or a policy that has passed its gate)',
  policy_not_enabled: 'Qualifies for a policy that is not switched on',
  unsupported_category: 'Outside the products the policy covers',
  kit: 'A multi-part kit (not covered by the bulb policy)',
  missing_fitment: 'Needs more evidence: code, function or colour is not stated',
  ambiguous_variant: 'Needs more evidence: the chosen option is unclear',
  conflicting_fitment: 'Candidates differ in code, function or colour',
  ambiguous_candidate: 'Two candidates qualify as the identical item',
  stale_analysis: 'The products changed; being re-checked',
  human_decision: 'A person decided',
  not_eligible: 'The conditions for automatic approval are not met',
};
const reasonLabel = (k: string) => REASON_LABEL[k] ?? k.replace(/_/g, ' ');

const share = (n: number, d: number) => (d > 0 ? n / d : 0);
const target = (active: number, covered: number, s: number): CoverageTarget => {
  const variants = Math.ceil(active * s);
  return { share: s, variants, met: covered >= variants && active > 0, shortfall: Math.max(0, variants - covered) };
};

interface Flags {
  vid: string;
  pid: string;
  domain: string;
  candidate: boolean;
  judged: boolean;
  eligible: boolean;
  approved: boolean;
  auto: boolean;
  status: string | null;
  reason: string | null;
}

export async function loadMatchFunnel(db: DbLike, orgId: string, opts: { domain?: 'automotive' | 'grocery'; visible?: Set<string> | null; now: Date }): Promise<MatchFunnelView> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select o.vid, o.pid, o.domain,
      (exists (select 1 from ai_match_suggestions a where a.source_variant_id = o.vid and a.match_type in ('exact_item','same_product_different_pack','close_equivalent','substitute'))
        or exists (select 1 from product_matches m where m.source_variant_id = o.vid and m.status <> 'rejected' and m.superseded_at is null and m.match_class <> 'not_comparable')) as candidate,
      exists (select 1 from ai_match_suggestions a where a.source_variant_id = o.vid) as judged,
      exists (select 1 from ai_match_suggestions a where a.source_variant_id = o.vid and a.auto_class is not null and a.auto_policy_version = ${AUTO_POLICY_VERSION}) as eligible,
      exists (select 1 from product_matches m where m.source_variant_id = o.vid and m.status = 'accepted'
        and coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' else 'none' end) in ('exact','variant','equivalent')) as approved,
      exists (select 1 from product_matches m where m.source_variant_id = o.vid and m.status = 'accepted' and m.method = 'ai_auto' and m.auto_confirmed_at is not null
        and coalesce(m.relationship, 'none') in ('exact','variant','equivalent')) as auto,
      w.status as status, w.reason as reason
    from ${OWN(orgId)} o left join ai_match_work w on w.source_variant_id = o.vid
    ${opts.domain ? sql`where o.domain = ${opts.domain}` : sql``}`);
  const all: Flags[] = rows.rows.map((r) => ({ vid: String(r['vid']), pid: String(r['pid']), domain: String(r['domain']), candidate: !!r['candidate'], judged: !!r['judged'], eligible: !!r['eligible'], approved: !!r['approved'], auto: !!r['auto'], status: (r['status'] as string | null) ?? null, reason: (r['reason'] as string | null) ?? null }));
  const active = all.length;
  const parents = new Set(all.map((f) => f.pid)).size;
  const count = (f: (x: Flags) => boolean) => all.filter(f).length;
  const parentsOf = (f: (x: Flags) => boolean) => new Set(all.filter(f).map((x) => x.pid)).size;
  const visible = opts.visible ? count((f) => opts.visible!.has(f.vid)) : count((f) => f.approved);
  const stage = (key: FunnelStage['key'], label: string, variants: number): FunnelStage => ({ key, label, variants, share: share(variants, active) });
  const stages: FunnelStage[] = [
    stage('active', 'Active products', active),
    stage('candidate', 'A candidate counterpart was found', count((f) => f.candidate)),
    stage('judged', 'The AI judged the candidates', count((f) => f.judged)),
    stage('eligible', 'Qualifies for an automatic-approval policy', count((f) => f.eligible)),
    stage('approved', 'Has an approved counterpart (anyone)', count((f) => f.approved)),
    stage('approved_automatic', 'Has an automatically approved counterpart', count((f) => f.auto)),
    stage('visible', 'Visible in the price comparison', visible),
  ];

  // one reason for every variant that is not approved
  const why = (f: Flags): string => {
    if (f.approved) return 'approved';
    if (f.status === null) return f.judged ? (f.candidate ? 'awaiting_review' : 'no_acceptable_candidate') : 'not_worked';
    if (f.status === 'waiting_quota') return 'waiting_quota';
    if (f.status === 'queued' || f.status === 'running') return 'not_worked';
    if (f.status === 'retry') return f.reason === 'unanswered' ? 'unanswered' : 'retry';
    return f.reason ?? 'no_acceptable_candidate';
  };
  const reasons = new Map<string, number>();
  for (const f of all) {
    const k = why(f);
    if (k !== 'approved') reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  const notApproved: FunnelReason[] = [...reasons].sort((a, b) => b[1] - a[1]).map(([key, variants]) => ({ key, label: reasonLabel(key), variants }));

  const autoVariants = count((f) => f.auto);
  const approvedVariants = count((f) => f.approved);
  const autoParents = parentsOf((f) => f.auto);
  const approvedParents = parentsOf((f) => f.approved);
  const domain: MatchFunnelView['domain'] = opts.domain ?? 'all';
  // the delivery targets belong to automotive catalogues: asked for explicitly, or because most of the workspace's active products are automotive
  const mostlyAutomotive = !opts.domain && active > 0 && count((f) => f.domain === 'automotive') >= active / 2;
  const targets = domain === 'automotive' || mostlyAutomotive ? { floor: target(active, autoVariants, 0.5), stretch: target(active, autoVariants, 0.6), parentFloor: target(parents, autoParents, 0.5), parentStretch: target(parents, autoParents, 0.6) } : null;

  // when below the floor: what stands between the catalogue and the target, by cause (each unapproved variant counted once)
  const cause = (k: string): string =>
    ['not_worked', 'waiting_quota', 'retry', 'unanswered'].includes(k) ? 'quota_backlog'
    : ['no_candidate', 'no_acceptable_candidate'].includes(k) ? 'no_counterpart_found'
    : ['missing_fitment', 'ambiguous_variant', 'conflicting_fitment'].includes(k) ? 'missing_specs'
    : ['unsupported_category', 'kit', 'policy_not_enabled', 'awaiting_review', 'not_eligible', 'ambiguous_candidate', 'stale_analysis'].includes(k) ? 'policy_scope'
    : 'other';
  const CAUSE_LABEL: Record<string, string> = {
    quota_backlog: 'Quota and backlog: not yet worked through with the free quota',
    no_counterpart_found: 'No counterpart found: the competitors may not stock it, or retrieval missed it (see candidate recall)',
    missing_specs: 'Missing or conflicting specifications: the code, function or colour is not stated or differs',
    policy_scope: 'Policy scope: outside what the policy covers, not switched on, or waiting for review',
    other: 'Other: a person decided, or another reason',
  };
  const causes = new Map<string, number>();
  for (const f of all) {
    const k = why(f);
    if (k === 'approved' || f.auto) continue;
    const c = cause(k);
    causes.set(c, (causes.get(c) ?? 0) + 1);
  }
  const attribution = targets && !targets.floor.met ? [...causes].sort((a, b) => b[1] - a[1]).map(([key, variants]): FunnelReason => ({ key, label: CAUSE_LABEL[key] ?? key, variants })) : null;

  const [sugg] = await db.select({ n: sql<number>`count(*)::int` }).from(aiMatchSuggestions).where(sql`${aiMatchSuggestions.orgId} = ${orgId} and ${aiMatchSuggestions.status} = 'pending' and ${aiMatchSuggestions.matchType} in ('exact_item','same_product_different_pack','close_equivalent','substitute')`);
  const workload = {
    pendingSuggestions: sugg?.n ?? 0,
    needsEvidence: count((f) => f.status === 'needs_evidence'),
    waitingForQuota: count((f) => f.status === 'waiting_quota'),
    notYetWorked: count((f) => !f.approved && f.status === null && !f.judged),
  };

  // audited precision of each policy, from the latest evaluation (never a number made up here)
  const [rep] = await db.select().from(matchEvalReports).where(eq(matchEvalReports.orgId, orgId)).orderBy(desc(matchEvalReports.createdAt)).limit(1);
  const flags = await db.select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, orgId));
  // A measurement made before families and policy versions existed has gates without `units` (and one for a policy that is not offered): it counts for nothing now, and is shown as "not measured for the current rules".
  type Gate = { domain: string; autoClass: string; policyVersion?: string; units?: { families: number; correct: number; critical: number }; result: { passed: boolean }; needed?: { toMinimum: number; toCertainty: number | null } };
  const precision = ((rep?.gates ?? []) as unknown as Gate[])
    .filter((g) => (!opts.domain || g.domain === opts.domain) && SUPPORTED_POLICIES.some((p) => p.domain === g.domain && p.autoClass === g.autoClass))
    .map((g) => {
      const current = !!g.units && g.policyVersion === AUTO_POLICY_VERSION;
      const u = current ? g.units! : { families: 0, correct: 0, critical: 0 };
      const iv = wilson(u.correct, u.families);
      return {
        domain: g.domain, autoClass: g.autoClass, policyVersion: g.policyVersion ?? '', families: u.families, correct: u.correct, observed: iv.estimate, low: iv.low, high: iv.high, passed: current && g.result.passed, critical: u.critical,
        enabled: flags.some((f) => f.domain === g.domain && f.autoClass === g.autoClass && f.enabled), needed: current && g.needed ? g.needed : { toMinimum: Math.max(0, 100 - u.families), toCertainty: null },
      };
    });
  const recall = (rep?.report as { shortlistRecall?: { hits: number; total: number } } | undefined)?.shortlistRecall ?? null;

  return {
    generatedAt: opts.now.toISOString(), policyVersion: AUTO_POLICY_VERSION, domain, active, parents, stages,
    coverage: {
      automatic: { variants: autoVariants, share: share(autoVariants, active), parents: autoParents, parentShare: share(autoParents, parents) },
      approved: { variants: approvedVariants, share: share(approvedVariants, active), parents: approvedParents, parentShare: share(approvedParents, parents) },
      candidate: { variants: count((f) => f.candidate), share: share(count((f) => f.candidate), active) },
    },
    targets, notApproved, attribution, workload, precision, candidateRecall: recall && recall.total > 0 ? recall : null,
  };
}
