import { useState } from 'react';
import { formatDateTime } from '@ci/shared';
import { api, errorMessage, orgPath } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { ProductSearchModal, RELATIONSHIP_CHOICES, type SearchCandidate } from '../product-search';
import { Card, DataState, EmptyState, SourceLink, useToast } from '../ui';

/**
 * The independent evaluation of matching. People (not the development process, and never Gemini) say which competitor product, if any, is the true counterpart of a sample of your variants; the
 * system is scored against those labels; and a class of automatic approval can be switched on only after it passes the release gate on cases kept out of development.
 */

interface Prop { hits: number; total: number }
interface SystemScore { found: Prop; correct: Prop; precision: Prop; falseOnNone: Prop }
export interface GroupScore { cases: number; positives: number; noCounterpart: number; candidateRecall: Prop; rule: SystemScore; ai: SystemScore; combined: SystemScore; autoPrecision: Prop; automaticCoverage: Prop; humanReviewShare: Prop; unresolvedShare: Prop }
interface ReportBody { overall: GroupScore; byDomain: Record<string, GroupScore>; bySite: Record<string, GroupScore>; byCategory: Record<string, GroupScore> }
export interface GateLine { name: string; interval: { estimate: number | null; low: number | null; high: number | null }; needed: number; examples: number; passed: boolean; why: string }
export interface Gate { domain: string; autoClass: string; result: { passed: boolean; lines: GateLine[] } }
interface Status {
  development: { pending: number; labelled: number; skipped: number };
  holdout: { pending: number; labelled: number; skipped: number };
  target: { minimumLabelled: number; perClassMinimum: number };
  latestReport: { id: string; createdAt: string; cases: number; report: { all: ReportBody; holdout: ReportBody; development: ReportBody; poolDepthPerSite: number; shortlistDepthPerSite: number; shortlistRecall: Prop }; gates: Gate[]; engineVersion: string | null; model: string | null } | null;
  autoApproval: { domain: string; autoClass: string; enabled: boolean; enabledAt: string | null; disabledReason: string | null }[];
}
interface Candidate { variantId: string; title: string; variantTitle: string | null; brand: string | null; mpn: string | null; sku: string | null; size: string | null; price: number | null; currency: string | null; url: string | null }
export interface CaseView {
  id: string; stratum: string; split: string; domain: string; status: string; siteId: string; siteName: string;
  source: { variantId: string; productId: string; title: string; variantTitle: string | null; brand: string | null; mpn: string | null; sku: string | null; size: string | null; price: number | null; currency: string | null; url: string | null };
  candidates: Candidate[];
}

const CLASS_LABEL: Record<string, string> = { exact_item: 'Identical items (an equal barcode or part number, the same verified pack)', compatible_equivalent: 'Compatible equivalents (the same bulb code, nothing in doubt)' };

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
        <thead><tr><th>Domain and class</th><th>Release gate</th><th>Automatic approval</th></tr></thead>
        <tbody>
          {gates.map((g) => {
            const flag = flags.find((f) => f.domain === g.domain && f.autoClass === g.autoClass);
            return (
              <tr key={`${g.domain}-${g.autoClass}`}>
                <td><b>{g.domain === 'automotive' ? 'Automotive' : 'Grocery'}</b><div className="small muted">{CLASS_LABEL[g.autoClass] ?? g.autoClass}</div></td>
                <td>
                  <span className={`pill ${g.result.passed ? 'good' : 'warn'}`}>{g.result.passed ? 'passed' : 'not passed'}</span>
                  <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{g.result.lines.map((l) => <li key={l.name}>{l.name}: {l.why}</li>)}</ul>
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

const money = (p: number | null, c: string | null) => (p === null ? '—' : `${p.toFixed(2)} ${c ?? '?'}`);
const named = (v: string | null) => (v && v.toLowerCase() !== 'default title' ? v : null);

/** One case to label: the product, and what is at this website, with the system's opinion deliberately left out. */
export function LabelCase({ c, busy, onLabel, onSkip, onSearch, extra }: { c: CaseView; busy: boolean; onLabel: (v: { truthVariantId: string | null; relationship: string; expertise: string; note: string }) => void; onSkip: () => void; onSearch: () => void; extra: Candidate[] }) {
  const [choice, setChoice] = useState<string>('');
  const [rel, setRel] = useState('exact');
  const [expertise, setExpertise] = useState('general');
  const [note, setNote] = useState('');
  const list = [...c.candidates, ...extra.filter((e) => !c.candidates.some((x) => x.variantId === e.variantId))];
  return (
    <div className="stack-s" data-eval-case={c.id}>
      <div className="small muted">{c.split === 'holdout' ? 'Holdout case' : 'Development case'} · {c.domain} (why a case was selected is not shown: it could influence the label)</div>
      <div>
        <div className="small muted">Your product</div>
        <div className="title">{c.source.title}</div>
        <div className="sub">{[c.source.brand, named(c.source.variantTitle), c.source.size, c.source.mpn ? `Part ${c.source.mpn}` : null, c.source.sku ? `SKU ${c.source.sku}` : null].filter(Boolean).join(' · ')} · <b className="num">{money(c.source.price, c.source.currency)}</b> · <SourceLink href={c.source.url} product={c.source.title} text="View source" /></div>
      </div>
      <div className="small"><b>Which product at {c.siteName} is the true counterpart?</b> Look at the products and their pages; the system’s own suggestions are not shown, so they cannot influence you.</div>
      <div className="stack-s">
        {list.map((x) => (
          <label key={x.variantId} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="radio" name={`truth-${c.id}`} checked={choice === x.variantId} onChange={() => setChoice(x.variantId)} />
            <span><b>{x.title}</b>{named(x.variantTitle) ? ` — ${x.variantTitle}` : ''}<span className="small muted"> · {[x.brand, x.size, x.mpn ? `Part ${x.mpn}` : null, x.sku ? `SKU ${x.sku}` : null].filter(Boolean).join(' · ')} · {money(x.price, x.currency)} · </span><SourceLink href={x.url} product={x.title} text="View source" /></span>
          </label>
        ))}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="radio" name={`truth-${c.id}`} checked={choice === 'none'} onChange={() => setChoice('none')} /><span><b>None of these is a counterpart</b> (and I have searched {c.siteName})</span></label>
        <div><button className="btn btn-sm" onClick={onSearch}>Search {c.siteName} for another product…</button></div>
      </div>
      {choice && choice !== 'none' && <div className="field"><label htmlFor={`rel-${c.id}`}>The two products are</label><select id={`rel-${c.id}`} value={rel} onChange={(e) => setRel(e.target.value)}>{RELATIONSHIP_CHOICES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
      <div className="field"><label htmlFor={`exp-${c.id}`}>How well do you know these products?</label><select id={`exp-${c.id}`} value={expertise} onChange={(e) => setExpertise(e.target.value)}><option value="general">I can judge from the listings</option><option value="knowledgeable">I know these parts or products well</option></select></div>
      <div className="field"><label htmlFor={`note-${c.id}`}>Note (optional)</label><input id={`note-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !choice} onClick={() => onLabel({ truthVariantId: choice === 'none' ? null : choice, relationship: choice === 'none' ? 'none' : rel, expertise, note })}>Save label</button>
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
  const toggle = useOrgMutation((id, v: { domain: string; autoClass: string; enabled: boolean }) => api.post(orgPath(id, '/eval/auto-approval'), v), ['eval'], (_r, v) => toast.push(v.enabled ? 'Automatic approval is on for this class. Every approval is recorded and can be taken back.' : 'Automatic approval is off for this class.'));
  const s = status.data;
  const err = prepare.error ?? run.error ?? label.error ?? skip.error ?? toggle.error;
  const labelled = s ? s.development.labelled + s.holdout.labelled : 0;
  const c = next.data?.rows[0];
  return (
    <div className="stack-s">
      <div className="callout info" role="note">
        <b>How the system is measured.</b> A person (never Gemini, and never the development process) says which competitor product, if any, is the true counterpart of a sample of your variants. The system is then scored against those labels, separately on the cases used while developing and on a <b>holdout</b> that is kept out of tuning. A class of automatic approval can be switched on only when the holdout passes the release gate: candidate recall ≥ 95%, approval precision ≥ 98%, match recall ≥ 90%, with at least {s?.target.perClassMinimum ?? 100} labelled examples. With no labels, every gate stays closed.
      </div>
      {err && <div className="callout bad" role="alert">{errorMessage(err)}</div>}
      <Card title="Labels">
        {s ? (
          <div className="stack-s">
            <div className="small">Labelled <b>{labelled}</b> of about <b>{s.target.minimumLabelled}</b> needed to start (development {s.development.labelled}, holdout {s.holdout.labelled}); {s.development.pending + s.holdout.pending} waiting.</div>
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
            onLabel={(v) => label.mutate({ id: c.id, body: { relationship: v.relationship, truthVariantId: v.truthVariantId, expertise: v.expertise, ...(v.note ? { note: v.note } : {}) } })} /> : <p className="muted">An administrator labels the cases.</p>)}
        </DataState>
        <div className="small muted" style={{ marginTop: 6 }}>{next.data ? `${next.data.total} waiting.` : ''}</div>
      </Card>

      <Card title="Latest measurement">
        {!s?.latestReport ? <p className="muted small" style={{ margin: 0 }}>Not measured yet. Label cases, then measure.</p> : (
          <div className="stack-s">
            <div className="small muted">Measured {formatDateTime(s.latestReport.createdAt)} on {s.latestReport.cases} labelled cases · matcher {s.latestReport.engineVersion ?? '—'} · model {s.latestReport.model ?? '—'}. Candidate recall counts the true <b>variant</b> among up to {s.latestReport.report.poolDepthPerSite} candidates per website; at the {s.latestReport.report.shortlistDepthPerSite} the AI judges it is {pct(s.latestReport.report.shortlistRecall)}.</div>
            <ReportTable title="Holdout (kept out of development): the figures the gate uses" groups={{ 'All holdout cases': s.latestReport.report.holdout.overall, ...s.latestReport.report.holdout.byDomain }} />
            <ReportTable title="Development" groups={{ 'All development cases': s.latestReport.report.development.overall }} />
            <ReportTable title="By competitor website (all labelled cases)" groups={s.latestReport.report.all.bySite} />
            <ReportTable title="By product category (all labelled cases)" groups={s.latestReport.report.all.byCategory} />
            <div className="small muted"><b>Match recall</b> is the share of true counterparts the system pointed to; <b>precision</b> the share of its positive answers that were right; “wrong on no counterpart” the share of products with no counterpart that still got a positive answer. These are measured, not targets.</div>
            <GateTable gates={s.latestReport.gates} flags={s.autoApproval} isAdmin={isAdmin} busy={toggle.isPending} onToggle={(domain, autoClass, enabled) => toggle.mutate({ domain, autoClass, enabled })} />
          </div>
        )}
      </Card>
      {searching && <ProductSearchModal title={`Find another product at ${searching.siteName}`} sourceVariantId={searching.source.variantId} siteId={searching.siteId} withRelationship={false} onClose={() => setSearching(null)} onChosen={(x: SearchCandidate) => { setExtra((e) => ({ ...e, [searching.id]: [...(e[searching.id] ?? []), { variantId: x.variantId, title: x.title, variantTitle: x.variantTitle, brand: x.brand, mpn: null, sku: x.sku, size: x.sizeLabel, price: x.price, currency: x.currency, url: x.url }] })); setSearching(null); }} />}
    </div>
  );
}
