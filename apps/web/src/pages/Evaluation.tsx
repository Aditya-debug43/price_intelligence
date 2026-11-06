import { useState } from 'react';
import { formatDateTime } from '@ci/shared';
import { api, errorMessage, orgPath } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { ProductSearchModal, type SearchCandidate } from '../product-search';
import { Card, DataState, EmptyState, SourceLink, useToast } from '../ui';

/**
 * The independent evaluation of matching. People (not the development process, and never Gemini) judge the competitor products at a sample of your variants: which are acceptable counterparts
 * (and what each one is), which are not, and whether that list is complete. The system is scored against those judgments on the PRODUCT FAMILY (sibling variants and duplicate listings count
 * once), separately for the cases used while developing and for a holdout that is kept out of tuning. A narrow policy of automatic approval can be switched on only after it passes the release
 * gate on that holdout, for the rules in force now.
 */

interface Prop { hits: number; total: number }
interface SystemScore { found: Prop; correct: Prop; precision: Prop; falseOnNone: Prop }
export interface GroupScore { cases: number; positives: number; noCounterpart: number; candidateRecall: Prop; rule: SystemScore; ai: SystemScore; combined: SystemScore; autoPrecision: Prop; automaticCoverage: Prop; humanReviewShare: Prop; unresolvedShare: Prop; eligibleDecisions?: { pairs: number; correct: number; wrong: number; unjudged: number } }
interface ReportBody { overall: GroupScore; byDomain: Record<string, GroupScore>; bySite: Record<string, GroupScore>; byCategory: Record<string, GroupScore> }
export interface GateLine { name: string; interval: { estimate: number | null; low: number | null; high: number | null }; needed: number; examples: number; passed: boolean; why: string; required?: boolean }
export interface Gate {
  domain: string;
  autoClass: string;
  policyVersion?: string;
  /** How the independent units were counted: families judged, those fully correct, critical mistakes, answers nobody judged. */
  units?: { families: number; correct: number; critical: number; unjudgedAnswers: number; incompleteFamilies: number };
  /** How many more independent families the gate still needs. */
  needed?: { toMinimum: number; toCertainty: number | null };
  result: { passed: boolean; lines: GateLine[] };
}
interface Stratum { name: string; kind: 'uniform' | 'enriched'; population: number; selected: number; labelled: number }
interface Status {
  development: { pending: number; labelled: number; skipped: number; families?: number };
  holdout: { pending: number; labelled: number; skipped: number; families?: number };
  target: { minimumLabelled: number; perClassMinimum: number; unit?: string };
  policyVersion?: string;
  latestReport: { id: string; createdAt: string; cases: number; report: { all: ReportBody; holdout: ReportBody; development: ReportBody; poolDepthPerSite: number; shortlistDepthPerSite: number; shortlistRecall: Prop; strata?: Stratum[]; populationEstimate?: { basis: string; cases: number; score: GroupScore } }; gates: Gate[]; engineVersion: string | null; model: string | null } | null;
  autoApproval: { domain: string; autoClass: string; enabled: boolean; enabledAt: string | null; disabledReason: string | null; policyVersion?: string | null }[];
}
interface Candidate { variantId: string; title: string; variantTitle: string | null; brand: string | null; mpn: string | null; sku: string | null; size: string | null; price: number | null; currency: string | null; url: string | null }
export interface CaseView {
  id: string; stratum: string; split: string; domain: string; status: string; siteId: string; siteName: string;
  source: { variantId: string; productId: string; title: string; variantTitle: string | null; brand: string | null; mpn: string | null; sku: string | null; size: string | null; price: number | null; currency: string | null; url: string | null };
  candidates: Candidate[];
}
export interface LabelPayload { judgments: { variantId: string; relationship: string; critical?: boolean }[]; complete: boolean; expertise: string; note: string }

const CLASS_LABEL: Record<string, string> = { exact_item: 'Identical items (an equal barcode or part number, the same verified pack)', compatible_equivalent: 'Compatible equivalents (the same bulb code and job, nothing in doubt)' };

/** "12 of 40 (30.0%)", or an honest "no examples". */
export const pct = (p: Prop): string => (p.total === 0 ? 'no examples' : `${p.hits} of ${p.total} (${((100 * p.hits) / p.total).toFixed(1)}%)`);

export function ReportTable({ title, groups }: { title: string; groups: Record<string, GroupScore> }) {
  const rows = Object.entries(groups).filter(([, g]) => g.cases > 0);
  if (!rows.length) return null;
  return (
    <div>
      <div className="small muted" style={{ margin: '8px 0 2px' }}><b>{title}</b></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th /><th className="r">Cases</th><th className="r">Candidate recall (the true variant reached the candidates)</th><th className="r">Match recall</th><th className="r">Precision</th><th className="r">Wrong on “no counterpart”</th><th className="r">Auto-approval precision</th><th className="r">Correct automatic decisions</th><th className="r">Left to a person</th><th className="r">Unresolved</th></tr></thead>
          <tbody>
            {rows.map(([name, g]) => (
              <tr key={name}>
                <td>{name}</td><td className="r num">{g.cases}</td><td className="r num">{pct(g.candidateRecall)}</td><td className="r num">{pct(g.combined.found)}</td><td className="r num">{pct(g.combined.precision)}</td>
                <td className="r num">{pct(g.combined.falseOnNone)}</td><td className="r num">{pct(g.autoPrecision)}</td><td className="r num">{pct(g.automaticCoverage)}</td><td className="r num">{pct(g.humanReviewShare)}</td><td className="r num">{pct(g.unresolvedShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function GateTable({ gates, flags, isAdmin, busy, onToggle }: { gates: Gate[]; flags: Status['autoApproval']; isAdmin: boolean; busy?: boolean; onToggle?: (domain: string, autoClass: string, enabled: boolean) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Domain and policy</th><th>Release gate</th><th>Automatic approval</th></tr></thead>
        <tbody>
          {gates.map((g) => {
            const flag = flags.find((f) => f.domain === g.domain && f.autoClass === g.autoClass);
            return (
              <tr key={`${g.domain}-${g.autoClass}`}>
                <td><b>{g.domain === 'automotive' ? 'Automotive' : 'Grocery'}</b><div className="small muted">{CLASS_LABEL[g.autoClass] ?? g.autoClass}</div>{g.policyVersion && <div className="small muted">Rules {g.policyVersion}</div>}</td>
                <td>
                  <span className={`pill ${g.result.passed ? 'good' : 'warn'}`}>{g.result.passed ? 'passed' : 'not passed'}</span>
                  {g.units && <div className="small" style={{ marginTop: 4 }}><b>{g.units.families}</b> independent product famil{g.units.families === 1 ? 'y' : 'ies'} judged, <b>{g.units.correct}</b> fully correct{g.units.critical > 0 && <>, <b style={{ color: 'var(--coral)' }}>{g.units.critical} critical mistake{g.units.critical === 1 ? '' : 's'}</b></>}{g.units.unjudgedAnswers > 0 && <>; {g.units.unjudgedAnswers} answer{g.units.unjudgedAnswers === 1 ? '' : 's'} nobody has judged yet ({g.units.incompleteFamilies} famil{g.units.incompleteFamilies === 1 ? 'y' : 'ies'} held out until judged)</>}.</div>}
                  {g.needed && (g.needed.toMinimum > 0 || g.needed.toCertainty) ? <div className="small muted">{g.needed.toMinimum > 0 ? `${g.needed.toMinimum} more famil${g.needed.toMinimum === 1 ? 'y' : 'ies'} needed to reach the minimum.` : ''}{g.needed.toCertainty ? ` About ${g.needed.toCertainty} more would bring the lower bound above the line at the observed rate.` : ''}</div> : null}
                  <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{g.result.lines.map((l) => <li key={l.name}>{l.name}{l.required === false ? ' (a goal, does not block)' : ''}: {l.why}</li>)}</ul>
                </td>
                <td>
                  {flag?.enabled ? <><span className="pill good">on</span><div className="small muted">since {flag.enabledAt ? formatDateTime(flag.enabledAt) : '—'}</div></> : <span className="pill">off</span>}
                  {flag?.disabledReason && !flag.enabled && <div className="small muted">{flag.disabledReason}</div>}
                  {isAdmin && onToggle && (flag?.enabled
                    ? <div><button className="btn btn-sm" disabled={busy} onClick={() => onToggle(g.domain, g.autoClass, false)}>Switch off</button></div>
                    : <div><button className="btn btn-sm btn-primary" disabled={busy || !g.result.passed} title={g.result.passed ? '' : 'Closed: the measurement has not passed the release gate.'} onClick={() => onToggle(g.domain, g.autoClass, true)}>Switch on</button></div>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What the sample is made of: only the uniform sample describes the whole catalogue; the others were chosen because they are interesting. */
export function SampleTable({ strata, estimate }: { strata: Stratum[]; estimate?: { basis: string; cases: number } }) {
  if (!strata.length) return null;
  return (
    <div>
      <div className="small muted" style={{ margin: '8px 0 2px' }}><b>What the sample is made of</b></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Kind of case</th><th>Describes</th><th className="r">Could be drawn from</th><th className="r">Selected</th><th className="r">Labelled</th></tr></thead>
          <tbody>
            {strata.map((s) => (
              <tr key={s.name}><td>{s.name.replace(/_/g, ' ')}</td><td>{s.kind === 'uniform' ? <span className="pill good">the whole catalogue</span> : <span className="pill">only itself (chosen on purpose)</span>}</td><td className="r num">{s.population.toLocaleString()}</td><td className="r num">{s.selected}</td><td className="r num">{s.labelled}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {estimate && <div className="small muted">Estimates for the whole catalogue come only from the uniform sample ({estimate.cases} labelled): {estimate.basis}.</div>}
    </div>
  );
}

const money = (p: number | null, c: string | null) => (p === null ? '—' : `${p.toFixed(2)} ${c ?? '?'}`);
const named = (v: string | null) => (v && v.toLowerCase() !== 'default title' ? v : null);

const JUDGE_OPTIONS: [string, string][] = [
  ['', 'Not judged'],
  ['exact', 'The same product'],
  ['variant', 'The same product, different pack, size or colour'],
  ['equivalent', 'A compatible equivalent (another maker, verified to do the same job)'],
  ['substitute', 'A substitute (not the same product)'],
  ['related', 'Related only (goes with it, not interchangeable)'],
  ['incorrect', 'NOT a counterpart'],
  ['critical', 'NOT a counterpart: approving it would be a serious mistake (wrong fit or function)'],
];

/**
 * What a person's judgments become. A product left unjudged is simply absent (never right, never wrong). "None of these is a counterpart" judges every product shown as not a counterpart and says the
 * list is complete. A "critical" judgment is a product that is NOT a counterpart and would be a serious mistake to approve (wrong fit or function): the gate blocks a rule that does it.
 */
export function labelPayload(list: { variantId: string }[], judged: Record<string, string>, none: boolean, complete: boolean, expertise: string, note: string): LabelPayload {
  if (none) return { judgments: list.map((x) => ({ variantId: x.variantId, relationship: 'incorrect' })), complete: true, expertise, note };
  const made = Object.entries(judged).filter(([, v]) => v);
  return { judgments: made.map(([variantId, v]) => ({ variantId, relationship: v === 'critical' ? 'incorrect' : v, ...(v === 'critical' ? { critical: true } : {}) })), complete, expertise, note };
}

/** One case to label: the product, and each product at this website to be judged, with the system's opinion deliberately left out. */
export function LabelCase({ c, busy, onLabel, onSkip, onSearch, extra }: { c: CaseView; busy: boolean; onLabel: (v: LabelPayload) => void; onSkip: () => void; onSearch: () => void; extra: Candidate[] }) {
  const [judged, setJudged] = useState<Record<string, string>>({});
  const [none, setNone] = useState(false);
  const [complete, setComplete] = useState(false);
  const [expertise, setExpertise] = useState('general');
  const [note, setNote] = useState('');
  const list = [...c.candidates, ...extra.filter((e) => !c.candidates.some((x) => x.variantId === e.variantId))];
  const made = Object.entries(judged).filter(([, v]) => v);
  const ready = none || made.length > 0;
  const save = () => onLabel(labelPayload(list, judged, none, complete, expertise, note));
  return (
    <div className="stack-s" data-eval-case={c.id}>
      <div className="small muted">{c.split === 'holdout' ? 'Holdout case' : 'Development case'} · {c.domain} (why a case was selected is not shown: it could influence the label)</div>
      <div>
        <div className="small muted">Your product</div>
        <div className="title">{c.source.title}</div>
        <div className="sub">{[c.source.brand, named(c.source.variantTitle), c.source.size, c.source.mpn ? `Part ${c.source.mpn}` : null, c.source.sku ? `SKU ${c.source.sku}` : null].filter(Boolean).join(' · ')} · <b className="num">{money(c.source.price, c.source.currency)}</b> · <SourceLink href={c.source.url} product={c.source.title} text="View source" /></div>
      </div>
      <div className="small"><b>Judge each product at {c.siteName}.</b> There can be several valid counterparts; say what each one is, or that it is not one. A product you leave unjudged is never counted as right or wrong. Look at the products and their pages; the system’s own suggestions are not shown, so they cannot influence you.</div>
      <div className="stack-s">
        {list.map((x) => (
          <div key={x.variantId} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 320px' }}><b>{x.title}</b>{named(x.variantTitle) ? ` — ${x.variantTitle}` : ''}<span className="small muted"> · {[x.brand, x.size, x.mpn ? `Part ${x.mpn}` : null, x.sku ? `SKU ${x.sku}` : null].filter(Boolean).join(' · ')} · {money(x.price, x.currency)} · </span><SourceLink href={x.url} product={x.title} text="View source" /></span>
            <select aria-label={`What is ${x.title}?`} disabled={none} value={none ? 'incorrect' : (judged[x.variantId] ?? '')} onChange={(e) => setJudged((j) => ({ ...j, [x.variantId]: e.target.value }))}>{JUDGE_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </div>
        ))}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} /><span><b>None of these is a counterpart</b> (and I have searched {c.siteName})</span></label>
        {!none && <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} /><span>I have judged every product I could find here: <b>no other product at {c.siteName} is a counterpart</b></span></label>}
        <div><button className="btn btn-sm" onClick={onSearch}>Search {c.siteName} for another product…</button></div>
      </div>
      <div className="field"><label htmlFor={`exp-${c.id}`}>How well do you know these products?</label><select id={`exp-${c.id}`} value={expertise} onChange={(e) => setExpertise(e.target.value)}><option value="general">I can judge from the listings</option><option value="knowledgeable">I know these parts or products well</option></select></div>
      <div className="field"><label htmlFor={`note-${c.id}`}>Note (optional)</label><input id={`note-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !ready} onClick={save}>Save label</button>
        <button className="btn" disabled={busy} onClick={onSkip}>Skip: I cannot tell</button>
      </div>
    </div>
  );
}

export function EvaluationTab() {
  const { isAdmin } = useOrg();
  const toast = useToast();
  const [size, setSize] = useState(300);
  const [searching, setSearching] = useState<CaseView | null>(null);
  const [extra, setExtra] = useState<Record<string, Candidate[]>>({});
  const status = useOrgQuery<Status>(['eval', 'status'], '/eval/status');
  const next = useOrgQuery<{ rows: CaseView[]; total: number }>(['eval', 'next'], '/eval/cases?status=pending&pageSize=1');
  const prepare = useOrgMutation((id, _: void) => api.post<{ selected: number }>(orgPath(id, '/eval/prepare'), { size }), ['eval'], (r) => toast.push(`${r.selected} case${r.selected === 1 ? '' : 's'} selected to label.`));
  const run = useOrgMutation((id, _: void) => api.post(orgPath(id, '/eval/run')), ['eval'], () => toast.push('The measurement is running in the background. Refresh in a minute.'));
  const label = useOrgMutation((id, v: { id: string; body: Record<string, unknown> }) => api.post(orgPath(id, `/eval/cases/${v.id}/label`), v.body), ['eval'], () => toast.push('Label saved.'));
  const skip = useOrgMutation((id, v: { id: string }) => api.post(orgPath(id, `/eval/cases/${v.id}/skip`), {}), ['eval']);
  const toggle = useOrgMutation((id, v: { domain: string; autoClass: string; enabled: boolean }) => api.post(orgPath(id, '/eval/auto-approval'), v), ['eval', 'ai', 'matches', 'comparison'], (_r, v) => toast.push(v.enabled ? 'The policy is on. Every stored answer that qualifies is being approved now, without asking the model again; every approval is recorded and can be taken back.' : 'The policy is off. Its automatic approvals are being taken back; your own decisions are untouched.'));
  const s = status.data;
  const err = prepare.error ?? run.error ?? label.error ?? skip.error ?? toggle.error;
  const labelled = s ? s.development.labelled + s.holdout.labelled : 0;
  const c = next.data?.rows[0];
  return (
    <div className="stack-s">
      <div className="callout info" role="note">
        <b>How the system is measured.</b> A person (never Gemini, and never the development process) judges the competitor products at a sample of your variants: which are counterparts and what each is, which are not. The system is scored against those judgments, counting each <b>product family</b> once (sibling variants and duplicate listings are one), on a <b>holdout</b> kept out of tuning. A narrow policy of automatic approval can be switched on only when, for the rules in force now, it has at least {s?.target.perClassMinimum ?? 100} independent judged families, an observed precision of at least 98% with a 95% lower bound above 90%, and <b>no</b> critical compatibility mistake. Coverage and recall are reported beside it as goals; they do not block a precise policy. With no labels, every gate stays closed.
      </div>
      {err && <div className="callout bad" role="alert">{errorMessage(err)}</div>}
      <Card title="Labels">
        {s ? (
          <div className="stack-s">
            <div className="small">Labelled <b>{labelled}</b> of about <b>{s.target.minimumLabelled}</b> needed to start (development {s.development.labelled}, holdout {s.holdout.labelled} across {s.holdout.families ?? '—'} famil{s.holdout.families === 1 ? 'y' : 'ies'}); {s.development.pending + s.holdout.pending} waiting. The gate counts <b>independent product families</b> in the holdout: at least {s.target.perClassMinimum} are needed per policy.</div>
            {isAdmin && (
              <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
                <div className="field"><label htmlFor="ev-size">Sample size</label><input id="ev-size" type="number" min={20} max={1000} value={size} onChange={(e) => setSize(Math.max(20, Math.min(1000, Number(e.target.value) || 20)))} style={{ width: 100 }} /></div>
                <button className="btn" disabled={prepare.isPending} onClick={() => prepare.mutate(undefined)}>Select cases to label</button>
                <button className="btn btn-primary" disabled={run.isPending || labelled === 0} onClick={() => run.mutate(undefined)}>Measure the system now</button>
              </div>
            )}
          </div>
        ) : <div className="muted small">Loading…</div>}
      </Card>

      <Card title="Label the next case">
        <DataState q={next} isEmpty={(d) => d.rows.length === 0} empty={<EmptyState title="Nothing is waiting to be labelled">{isAdmin ? 'Select cases to label above.' : 'An administrator selects the cases to label.'}</EmptyState>}>
          {() => c && (isAdmin ? <LabelCase key={c.id} c={c} busy={label.isPending || skip.isPending} extra={extra[c.id] ?? []} onSearch={() => setSearching(c)} onSkip={() => skip.mutate({ id: c.id })}
            onLabel={(v) => label.mutate({ id: c.id, body: { judgments: v.judgments, complete: v.complete, expertise: v.expertise, ...(v.note ? { note: v.note } : {}) } })} /> : <p className="muted">An administrator labels the cases.</p>)}
        </DataState>
        <div className="small muted" style={{ marginTop: 6 }}>{next.data ? `${next.data.total} waiting.` : ''}</div>
      </Card>

      <Card title="Latest measurement">
        {!s?.latestReport ? <p className="muted small" style={{ margin: 0 }}>Not measured yet. Label cases, then measure.</p> : (
          <div className="stack-s">
            <div className="small muted">Measured {formatDateTime(s.latestReport.createdAt)} on {s.latestReport.cases} labelled cases · matcher {s.latestReport.engineVersion ?? '—'} · model {s.latestReport.model ?? '—'}. Candidate recall counts the true <b>variant</b> among up to {s.latestReport.report.poolDepthPerSite} candidates per website; at the {s.latestReport.report.shortlistDepthPerSite} the AI judges it is {pct(s.latestReport.report.shortlistRecall)}.</div>
            <GateTable gates={s.latestReport.gates} flags={s.autoApproval} isAdmin={isAdmin} busy={toggle.isPending} onToggle={(domain, autoClass, enabled) => toggle.mutate({ domain, autoClass, enabled })} />
            <ReportTable title="Holdout (kept out of development): the figures the gate uses" groups={{ 'All holdout cases': s.latestReport.report.holdout.overall, ...s.latestReport.report.holdout.byDomain }} />
            {s.latestReport.report.holdout.overall.eligibleDecisions && s.latestReport.report.holdout.overall.eligibleDecisions.pairs > 0 && (
              <div className="small muted">Every answer a policy would approve was scored, not only the strongest at each website: {s.latestReport.report.holdout.overall.eligibleDecisions.pairs} in all, {s.latestReport.report.holdout.overall.eligibleDecisions.correct} right, {s.latestReport.report.holdout.overall.eligibleDecisions.wrong} wrong, {s.latestReport.report.holdout.overall.eligibleDecisions.unjudged} not judged yet.</div>
            )}
            <ReportTable title="Development" groups={{ 'All development cases': s.latestReport.report.development.overall }} />
            <ReportTable title="By competitor website (all labelled cases)" groups={s.latestReport.report.all.bySite} />
            <ReportTable title="By product category (all labelled cases)" groups={s.latestReport.report.all.byCategory} />
            <SampleTable strata={s.latestReport.report.strata ?? []} estimate={s.latestReport.report.populationEstimate} />
            <div className="small muted"><b>Match recall</b> is the share of true counterparts the system pointed to; <b>precision</b> the share of its positive answers that were right; “wrong on no counterpart” the share of products with no counterpart that still got a positive answer. These are measured, not targets.</div>
          </div>
        )}
      </Card>
      {searching && <ProductSearchModal title={`Find another product at ${searching.siteName}`} sourceVariantId={searching.source.variantId} siteId={searching.siteId} withRelationship={false} onClose={() => setSearching(null)} onChosen={(x: SearchCandidate) => { setExtra((e) => ({ ...e, [searching.id]: [...(e[searching.id] ?? []), { variantId: x.variantId, title: x.title, variantTitle: x.variantTitle, brand: x.brand, mpn: null, sku: x.sku, size: x.sizeLabel, price: x.price, currency: x.currency, url: x.url }] })); setSearching(null); }} />}
    </div>
  );
}
