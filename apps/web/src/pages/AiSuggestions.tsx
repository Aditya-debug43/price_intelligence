import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AI_TYPE_LABEL, AI_TYPE_TO_RELATIONSHIP, formatDateTime, type AiEvidenceItem, type AiMatchType, type AiProductView, type AiRunView, type AiStatusView, type AiSuggestionView } from '@ci/shared';
import { api, errorMessage, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, Card, DataState, EmptyState, Modal, Pager, SourceLink, useToast } from '../ui';

/**
 * The AI suggestions tab of Match review. Everything here is a SUGGESTION: it is kept apart from your matches and your prices, nothing on this tab changes either until a person
 * accepts or changes one, and then it is an ordinary decision of yours, recorded the way every other decision is.
 */

const TYPE_PILL: Record<AiMatchType, string> = { exact_item: 'good', same_product_different_pack: 'info', close_equivalent: 'info', substitute: 'warn', related: '', no_match_uncertain: '' };
const TYPE_HELP: Record<AiMatchType, string> = {
  exact_item: 'The same product from the same maker, in the same size and pack.',
  same_product_different_pack: 'The same product, but the size or the number in the pack differs. It is not compared on price.',
  close_equivalent: 'Another maker’s product verified to do the same job for the same use (the same bulb or socket code, position, function and fit). Saved as a compatible equivalent if you accept it: never the same product.',
  substitute: 'Does the same job, but differs in something meaningful.',
  related: 'Goes with the product, but cannot replace it.',
  no_match_uncertain: 'Nothing suitable here, or not enough information to say.',
};
const CONFIDENCE: Record<string, { label: string; cls: string }> = { high: { label: 'High confidence', cls: 'good' }, medium: { label: 'Medium confidence', cls: 'info' }, low: { label: 'Low confidence', cls: 'warn' } };
const REL_LABEL: Record<string, string> = { exact: 'the same product', variant: 'the same product, different pack', equivalent: 'a compatible equivalent', substitute: 'a substitute', related: 'related only', non_match: 'not a match', insufficient: 'not enough information' };
const RELATIONSHIPS = [
  ['exact', 'The same product'],
  ['variant', 'The same product, different pack, size or colour'],
  ['equivalent', 'A compatible equivalent (another maker, verified to do the same job)'],
  ['substitute', 'A substitute (not the same product)'],
  ['related', 'Related only (goes with it, not interchangeable)'],
] as const;
const METHOD: Record<string, string> = { identifier: 'barcode or part number', code: 'part code', fitment: 'vehicle fit', spec: 'specifications', keywords: 'distinctive words', text: 'name similarity', type: 'kind of product', rules: 'rule-based matcher', semantic: 'meaning' };
const EFFECT = {
  agree: { icon: '✓', label: 'Agrees', cls: 'good' },
  different: { icon: '△', label: 'Differs', cls: 'warn' },
  conflict: { icon: '✕', label: 'Conflicts', cls: 'bad' },
  unknown: { icon: '?', label: 'Not stated', cls: '' },
} as const;
const money = (p: number | null, c: string | null) => (p === null ? '—' : `${p.toFixed(2)} ${c ?? '?'}`);

/** What a person is told this suggestion would be if they accept it. */
export const acceptWords = (t: AiMatchType): string | null => {
  const rel = AI_TYPE_TO_RELATIONSHIP[t];
  return rel ? REL_LABEL[rel]! : null;
};

// ───────────────────────────────────────────────────────────── the attribute comparison

type Row = { label: string; keys: string[] };
/** Which facts matter for which kind of product. A new category adds a list here (and a paragraph in the prompt). */
const ATTRIBUTE_ROWS: Record<AiProductView['domain'], Row[]> = {
  automotive: [
    { label: 'Bulb / socket code', keys: ['part_codes'] },
    { label: 'Same part also written as', keys: ['same_part_also_written_as'] },
    { label: 'Vehicle', keys: ['vehicle'] },
    { label: 'Model years', keys: ['model_years'] },
    { label: 'Lamp position', keys: ['lamp_position'] },
    { label: 'Beam / function', keys: ['beam_or_function'] },
    { label: 'Housing', keys: ['housing_mentioned'] },
    { label: 'Power (W)', keys: ['power_w'] },
    { label: 'Brightness (lm)', keys: ['lumens'] },
    { label: 'Voltage (V)', keys: ['voltage_v'] },
    { label: 'Colour temperature (K)', keys: ['colour_temperature_k'] },
    { label: 'Colour', keys: ['colour'] },
    { label: 'CAN-bus', keys: ['canbus_mentioned'] },
    { label: 'Bundle contents', keys: ['bundle'] },
    { label: 'Pack count', keys: ['pack_count'] },
    { label: 'Accessory, not a bulb', keys: ['is_accessory_not_bulb'] },
  ],
  grocery: [
    { label: 'Flavour / variety', keys: ['flavour_or_variety'] },
    { label: 'Form / formulation', keys: ['product_form'] },
    { label: 'Edition', keys: ['edition'] },
    { label: 'Quantity', keys: ['quantity'] },
    { label: 'Pack count', keys: ['pack_count'] },
    { label: 'Percentages stated', keys: ['percent_claims'] },
    { label: 'Numbers that are part of the name', keys: ['numbers_that_belong_to_the_name'] },
    { label: 'Vintage', keys: ['vintage_year'] },
    { label: 'Not for', keys: ['not_for'] },
  ],
  general: [
    { label: 'Quantity', keys: ['quantity'] },
    { label: 'Pack count', keys: ['pack_count'] },
  ],
};

/** A value as a person reads it (lists joined, a yes/no as words, a bundle as its parts). */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(showValue).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    const b = v as { is_bundle?: boolean; parts?: string[]; without?: string[] };
    if ('parts' in b) return `${b.is_bundle ? 'bundle' : 'single item'}${b.parts?.length ? `: ${b.parts.join(' + ')}` : ''}${b.without?.length ? ` (without ${b.without.join(', ')})` : ''}`;
    return JSON.stringify(v);
  }
  return String(v);
}

export function comparisonRows(source: AiProductView, candidate: AiProductView): { label: string; a: string; b: string; src: string; srcB: string; differs: boolean }[] {
  const out: { label: string; a: string; b: string; src: string; srcB: string; differs: boolean }[] = [];
  const add = (label: string, a: string | null | undefined, b: string | null | undefined, src = '', srcB = '') => {
    if (!a && !b) return;
    out.push({ label, a: a ?? '', b: b ?? '', src, srcB, differs: !!a && !!b && a.toLowerCase() !== b.toLowerCase() });
  };
  add('Brand', source.brand, candidate.brand);
  add('Kind of product', source.productType, candidate.productType);
  for (const row of ATTRIBUTE_ROWS[source.domain === 'general' ? candidate.domain : source.domain]) {
    const key = row.keys[0]!;
    const x = source.attributes[key];
    const y = candidate.attributes[key];
    add(row.label, showValue(x?.value), showValue(y?.value), x?.source, y?.source);
  }
  add('Barcode', source.identifiers.gtin, candidate.identifiers.gtin);
  add('Part number', source.identifiers.mpn, candidate.identifiers.mpn);
  return out;
}

export function AttributeTable({ s }: { s: AiSuggestionView }) {
  const rows = comparisonRows(s.source, s.candidate);
  const missing = [...new Set([...s.source.unknown, ...s.candidate.unknown])];
  return (
    <details className="ev">
      <summary>Compare the facts the AI was given</summary>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th /><th>Your product</th><th>{s.candidate.siteName}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="muted small">{r.label}</td>
                <td style={r.differs ? { background: 'var(--amber-wash, #fff4c2)' } : undefined}>{r.a || <span className="muted">not stated</span>}{r.a && r.src && <span className="small muted"> · read from {r.src}</span>}</td>
                <td style={r.differs ? { background: 'var(--amber-wash, #fff4c2)' } : undefined}>{r.b || <span className="muted">not stated</span>}{r.b && r.srcB && <span className="small muted"> · read from {r.srcB}</span>}</td>
              </tr>
            ))}
            <tr><td className="muted small">Product page</td><td><SourceLink href={s.source.url} product={s.source.title} /></td><td><SourceLink href={s.candidate.url} product={s.candidate.title} /></td></tr>
          </tbody>
        </table>
      </div>
      <div className="small muted">Highlighted rows differ. “Not stated” means the listing does not say; it is never guessed.{missing.length > 0 && <> Not stated on at least one product: {missing.map((m) => m.replace(/_/g, ' ')).join(', ')}.</>}</div>
    </details>
  );
}

// ───────────────────────────────────────────────────────────── one suggestion

export function AiEvidence({ items, empty }: { items: AiEvidenceItem[]; empty: string }) {
  if (!items.length) return <div className="small muted">{empty}</div>;
  return (
    <ul className="ev-list" style={{ listStyle: 'none', margin: '4px 0', padding: 0 }}>
      {items.map((e, n) => {
        const f = EFFECT[e.result];
        return (
          <li key={n} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
            <span className={`pill ${f.cls}`} title={f.label} aria-label={f.label} style={{ minWidth: 22, textAlign: 'center' }}>{f.icon}</span>
            <span>
              <b>{e.attribute.replace(/_/g, ' ')}</b>
              {(e.source_value || e.candidate_value) && <span className="small muted"> — yours: {e.source_value ?? 'not stated'} · theirs: {e.candidate_value ?? 'not stated'}</span>}
              {e.grounded === false && <span className="small" style={{ color: 'var(--bad, #a33)' }}> (not found in the facts the AI was given, so it is not counted)</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface AiActions {
  onAccept: () => void;
  onChange: (relationship: string) => void;
  onUncertain: () => void;
  onNone: () => void;
  onFindAnother: () => void;
  busy: boolean;
}

const STATUS_WORDS: Record<string, string> = { accepted: 'You accepted this', changed: 'You changed this', uncertain: 'You marked this as unsure', none_of_these: 'You said none of these fits', stale: 'The products changed since' };

export function AiSuggestionCard({ s, orgId, isAdmin, actions }: { s: AiSuggestionView; orgId: string; isAdmin: boolean; actions?: AiActions }) {
  const [rel, setRel] = useState<string>(AI_TYPE_TO_RELATIONSHIP[s.matchType] ?? 'substitute');
  const conf = CONFIDENCE[s.confidence] ?? CONFIDENCE.low!;
  const accept = acceptWords(s.matchType);
  const decidedByPerson = s.existingMatch && (s.existingMatch.status === 'accepted' || s.existingMatch.status === 'rejected');
  const changedByGuard = s.matchType !== s.aiMatchType;
  const canAct = isAdmin && !!actions && !decidedByPerson;
  const differentPack = s.matchType === 'same_product_different_pack';
  return (
    <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line-2)' }} data-ai-suggestion={s.id}>
      <div className="grid2" style={{ gridTemplateColumns: '1fr auto', alignItems: 'start' }}>
        <div>
          <div className="small muted">{s.candidate.siteName}</div>
          <Link className="title" to={`/o/${orgId}/products/${s.candidate.productId}`}>{s.candidate.title}</Link>
          <div className="sub">{[s.candidate.brand, s.candidate.variantTitle].filter(Boolean).join(' · ')} · <b className="num">{money(s.candidate.price, s.candidate.currency)}</b> · <SourceLink href={s.candidate.url} product={s.candidate.title} text="View source" /></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`pill ${TYPE_PILL[s.matchType]}`} title={TYPE_HELP[s.matchType]}>{AI_TYPE_LABEL[s.matchType]}</span>
          <div className="small" style={{ marginTop: 4 }}><span className={`pill ${conf.cls}`} title="How well the facts the AI was given support its answer. It is not a probability.">{conf.label}</span></div>
        </div>
      </div>

      {decidedByPerson && s.existingMatch && (
        <div className="callout info" role="status" style={{ margin: '8px 0' }}>
          This pair is already {s.existingMatch.status === 'accepted' ? 'confirmed' : 'rejected'} in Match review{s.existingMatch.relationship && s.existingMatch.status === 'accepted' ? ` as ${REL_LABEL[s.existingMatch.relationship] ?? s.existingMatch.relationship}` : ''}. <b>Your decision stands</b>; this suggestion is shown so you can compare the AI with it.
        </div>
      )}
      {s.status !== 'pending' && (
        <div className="callout info" role="status" style={{ margin: '8px 0' }}>
          {STATUS_WORDS[s.status] ?? s.status}{s.review?.relationship ? ` as ${REL_LABEL[s.review.relationship] ?? s.review.relationship}` : ''}{s.review?.by ? ` — ${s.review.by}` : ''}{s.review ? `, ${formatDateTime(s.review.at)}` : ''}{s.review?.note ? `: ${s.review.note}` : ''}.
        </div>
      )}

      <div style={{ margin: '6px 0' }}><b>Why:</b> {s.explanation}</div>
      {changedByGuard && (
        <div className="callout warn" role="status" style={{ margin: '6px 0' }}>
          The AI first answered “{AI_TYPE_LABEL[s.aiMatchType]}”; Shelfwatch’s checks changed it to “{AI_TYPE_LABEL[s.matchType]}”.
        </div>
      )}
      {s.guards.length > 0 && (
        <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
          {s.guards.map((g, i) => <li key={i}><b>Safeguard:</b> {g.note}</li>)}
        </ul>
      )}
      {differentPack && <div className="small" style={{ margin: '4px 0' }}><span className="pill info">Different pack</span> Shown here on its own. It is not compared on price, and the price comparison is unchanged.</div>}

      <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div><div className="small muted">Facts that agree</div><AiEvidence items={s.supporting} empty="None named." /></div>
        <div><div className="small muted">Facts that differ or conflict</div><AiEvidence items={s.conflicting} empty="None named." /></div>
      </div>
      {s.missing.length > 0 && <div className="small" style={{ margin: '4px 0' }}><b>Not stated, and would settle it:</b> {s.missing.join(' · ')}</div>}

      <div className="small muted" style={{ margin: '4px 0' }}>
        {s.policy.quantity && <>Quantity check: <b>{s.policy.quantity.verdict === 'same' ? 'the same quantity' : s.policy.quantity.verdict === 'different' ? 'different quantities' : 'not established'}</b>. </>}
        {s.policy.bundle && <>Bundle check: <b>{s.policy.bundle.verdict === 'equivalent' ? 'same contents' : s.policy.bundle.verdict === 'mismatch' ? 'different contents' : 'contents not established'}</b>. </>}
        {s.engine && <>Rule-based matcher: <b>{REL_LABEL[s.engine.relationship] ?? s.engine.relationship}</b>{s.engine.tier ? ` (${s.engine.tier})` : ''}. </>}
        {s.foundBy.length > 0 && <>Found by: {[...new Set(s.foundBy.map((f) => METHOD[f.method] ?? f.method))].join(', ')}. </>}
        {s.existingMatch && !decidedByPerson && <>Also suggested by the matcher ({s.existingMatch.status.replace(/_/g, ' ')}). </>}
        <span title={`${s.model}, ${s.promptVersion}`}>Analysed <Age iso={s.analysedAt} /> by {s.model}.</span>
      </div>

      <AttributeTable s={s} />

      {canAct && actions && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {accept && s.matchType !== 'no_match_uncertain' && (
            <button className="btn btn-sm btn-primary" disabled={actions.busy} onClick={actions.onAccept} title={`Saves your decision: ${accept}.`}>Yes — {accept}</button>
          )}
          <select aria-label="Change what these products are" value={rel} onChange={(e) => setRel(e.target.value)} style={{ maxWidth: 260 }}>
            {RELATIONSHIPS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
          </select>
          <button className="btn btn-sm" disabled={actions.busy} onClick={() => actions.onChange(rel)}>Change to this</button>
          <button className="btn btn-sm" disabled={actions.busy} onClick={actions.onUncertain}>Not sure yet</button>
          <button className="btn btn-sm" disabled={actions.busy} onClick={actions.onFindAnother}>Find another product…</button>
          <button className="btn btn-sm btn-danger" disabled={actions.busy} onClick={actions.onNone} title="Closes every waiting AI suggestion for this product. Your matches are not changed.">None of these</button>
        </div>
      )}
    </div>
  );
}

/** The shop's own product the suggestions below belong to. */
export function SourceHeader({ s, orgId }: { s: AiProductView; orgId: string }) {
  return (
    <div style={{ padding: '12px 18px', background: 'var(--panel-2, #f6f6f3)' }}>
      <div className="small muted">Your product</div>
      <Link className="title" to={`/o/${orgId}/products/${s.productId}`}>{s.title}</Link>
      <div className="sub">{[s.brand, s.variantTitle].filter(Boolean).join(' · ')} · <b className="num">{money(s.price, s.currency)}</b> · <SourceLink href={s.url} product={s.title} text="View source" /></div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── the status panel

const STATE_PILL: Record<AiStatusView['state'], { label: string; cls: string }> = {
  not_configured: { label: 'not set up', cls: '' },
  idle: { label: 'ready', cls: 'good' },
  running: { label: 'analysing…', cls: 'info' },
  paused: { label: 'waiting for quota', cls: 'warn' },
  stopped: { label: 'stopped', cls: 'bad' },
};

export function AiStatusPanel({ status, isAdmin, onResumeGemini, busy }: { status: AiStatusView; isAdmin: boolean; onResumeGemini?: () => void; busy?: boolean }) {
  const st = STATE_PILL[status.state];
  const t = status.today;
  const l = status.limits;
  return (
    <div className="stack-s">
      <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
        <b>Gemini (free tier)</b>
        <span className={`pill ${st.cls}`}>{st.label}</span>
        {status.configured && <span className="small muted">{status.model}</span>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{status.note}</p>
      {status.configured && (
        <div className="small">
          Today (Pacific Time): <b>{t.requests}</b> request{t.requests === 1 ? '' : 's'} sent of <b>{l.dailyBudget}</b> Shelfwatch allows itself · <b>{t.inputTokens.toLocaleString()}</b> tokens in, <b>{t.outputTokens.toLocaleString()}</b> out · {t.cachedResults} answer{t.cachedResults === 1 ? '' : 's'} reused instead of asked again · {t.rateLimited} rate-limit answer{t.rateLimited === 1 ? '' : 's'} · {t.failures} failed.
          <div className="muted">Shelfwatch sends at most {l.rpm} requests a minute{l.learned.rpm ? `; Google’s own answers say its limit is ${l.learned.rpm} a minute` : ''}{l.learned.rpd ? ` and ${l.learned.rpd} a day` : ''}. Google does not tell us how much of its free quota is left.</div>
        </div>
      )}
      {status.state === 'paused' && status.pausedUntil && <div className="callout info" role="status">Paused until {formatDateTime(status.pausedUntil)}{status.pauseReason ? `: ${status.pauseReason}` : ''}. Everything else in Shelfwatch works as usual.</div>}
      {status.state === 'stopped' && (
        <div className="callout bad" role="alert">
          Gemini processing is stopped: {status.stopped}
          {isAdmin && onResumeGemini && <> <button className="btn btn-sm" disabled={busy} onClick={onResumeGemini}>I have fixed this: allow it to continue</button></>}
        </div>
      )}
    </div>
  );
}

export function AiRunPanel({ run, isAdmin, onPause, onResume, onCancel, busy }: { run: AiRunView; isAdmin: boolean; onPause: () => void; onResume: () => void; onCancel: () => void; busy: boolean }) {
  const p = run.progress;
  const pct = p.sources ? Math.round((100 * p.sourcesDone) / p.sources) : 0;
  return (
    <div className="stack-s" role="status">
      <div><b>Analysis {run.status === 'paused' ? 'paused' : run.status === 'queued' ? 'waiting for the worker' : 'in progress'}</b> — {p.sourcesDone} of {p.sources} products ({pct}%), {p.answered} competitor products judged, {p.cachedResults} reused from earlier answers.</div>
      <div className="small muted">{run.usage.requests} request{run.usage.requests === 1 ? '' : 's'} · {run.usage.inputTokens.toLocaleString()} tokens in, {run.usage.outputTokens.toLocaleString()} out{run.usage.rateLimited ? ` · waited out ${run.usage.rateLimited} rate limit${run.usage.rateLimited === 1 ? '' : 's'}` : ''}</div>
      {run.pauseReason && <div className="small">{run.pauseReason}{run.resumeAt ? ` It continues by itself after ${formatDateTime(run.resumeAt)}.` : ''}</div>}
      {isAdmin && (
        <div className="row">
          {run.status === 'paused' ? <button className="btn btn-sm" disabled={busy} onClick={onResume}>Resume</button> : <button className="btn btn-sm" disabled={busy} onClick={onPause}>Pause</button>}
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── choosing another product

interface Candidate { variantId: string; title: string; variantTitle: string | null; brand: string | null; sizeLabel: string | null; sku: string | null; price: number | null; currency: string | null; availability: string; observedAt: string | null; url: string; siteName: string; suggestion: { relationship: string; summary: string } | null }

function FindAnother({ s, onClose, onChosen }: { s: AiSuggestionView; onClose: () => void; onChosen: (c: Candidate, relationship: string) => void }) {
  const [text, setText] = useState('');
  const [needle, setNeedle] = useState('');
  const [rel, setRel] = useState<string>('exact');
  useEffect(() => {
    const t = setTimeout(() => setNeedle(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  // the whole competitor catalogue, not only what the AI looked at
  const q = useOrgQuery<{ candidates: Candidate[] }>(['match-candidates', s.source.variantId, needle, 'ai'], `/matches/candidates${qs({ sourceVariantId: s.source.variantId, q: needle, limit: 20 })}`);
  return (
    <Modal title={`Which product matches “${s.source.title}”?`} onClose={onClose}>
      <div className="stack-s">
        <div className="field"><label htmlFor="ai-cand-q">Search the competitors’ products</label><input id="ai-cand-q" type="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, brand, SKU or barcode" /></div>
        <div className="field"><label htmlFor="ai-cand-c">These products are</label><select id="ai-cand-c" value={rel} onChange={(e) => setRel(e.target.value)}>{RELATIONSHIPS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></div>
        <DataState q={q} isEmpty={(d) => d.candidates.length === 0} empty={<p className="muted">No product matches that search.</p>}>
          {(d) => (
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="table">
                <tbody>
                  {d.candidates.map((c) => (
                    <tr key={c.variantId}>
                      <td>
                        <div className="title">{c.title}{c.variantTitle ? ` — ${c.variantTitle}` : ''}</div>
                        <div className="sub">{[c.siteName, c.brand, c.sizeLabel, c.sku].filter(Boolean).join(' · ')} · <b className="num">{money(c.price, c.currency)}</b> · <SourceLink href={c.url} product={c.title} text="View source" /></div>
                        {c.suggestion && <div className="small muted">{c.suggestion.summary}</div>}
                      </td>
                      <td className="r"><button className="btn btn-sm btn-primary" disabled={c.variantId === s.candidate.variantId} onClick={() => onChosen(c, rel)}>{c.variantId === s.candidate.variantId ? 'The AI’s suggestion' : 'Use this product'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
        <p className="small muted" style={{ margin: 0 }}>Your choice is recorded as your own decision, exactly as when you choose a product in the other tabs.</p>
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── the tab

const STATUS_FILTERS = [['pending', 'Waiting for you'], ['accepted', 'Accepted'], ['changed', 'Changed'], ['uncertain', 'Not sure yet'], ['none_of_these', 'None of these'], ['all', 'All']] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number][0];

export function AiSuggestionsTab() {
  const { orgId, isAdmin } = useOrg();
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [type, setType] = useState<AiMatchType | ''>('');
  const [decided, setDecided] = useState<'hide' | 'only' | 'all'>('hide');
  const [page, setPage] = useState(1);
  const [finding, setFinding] = useState<AiSuggestionView | null>(null);
  const [limit, setLimit] = useState(20);
  const [scope, setScope] = useState<'sample' | 'unmatched'>('sample');
  const active = (r?: AiRunView | null) => !!r && (r.status === 'queued' || r.status === 'running');
  const st = useOrgQuery<AiStatusView>(['ai', 'status'], '/ai/status', { refetchInterval: (q) => (active(q.state.data?.activeRun) ? 5000 : false) });
  const list = useOrgQuery<{ rows: AiSuggestionView[]; total: number }>(['ai', 'suggestions', status, type, decided, page], `/ai/suggestions${qs({ status, matchType: type, decided, page, pageSize: 10 })}`, { placeholderData: (p) => p, refetchInterval: active(st.data?.activeRun) ? 8000 : false });
  const refresh = ['ai', 'matches', 'comparison', 'dashboard', 'journey'];
  const start = useOrgMutation((id, _: void) => api.post<{ selected: number }>(orgPath(id, '/ai/runs'), { scope, limit, perSite: 3 }), ['ai'], (r) => toast.push(`Analysis started for ${r.selected} product${r.selected === 1 ? '' : 's'}. Suggestions appear here as they are judged.`));
  const control = useOrgMutation((id, v: { run: string; action: 'pause' | 'resume' | 'cancel' }) => api.post(orgPath(id, `/ai/runs/${v.run}/${v.action}`)), ['ai']);
  const resumeGemini = useOrgMutation((id, _: void) => api.post(orgPath(id, '/ai/resume-gemini')), ['ai'], () => toast.push('Gemini processing is allowed to continue.'));
  const review = useOrgMutation(
    (id, v: { id: string; body: Record<string, unknown> }) => api.post<{ status: string; affected: number }>(orgPath(id, `/ai/suggestions/${v.id}/review`), v.body),
    refresh,
    (r, v) => toast.push(v.body['action'] === 'none_of_these' ? `Closed ${r.affected} suggestion${r.affected === 1 ? '' : 's'} for this product. Your matches are unchanged.` : v.body['action'] === 'uncertain' ? 'Saved. Nothing else changed.' : 'Saved as your decision. It is kept every time matching runs again.'),
  );
  const s = st.data;
  const run = s?.activeRun ?? null;
  const err = start.error ?? control.error ?? review.error ?? resumeGemini.error;
  return (
    <div className="stack-s">
      <div className="callout info" role="note">
        <b>AI suggestions are only suggestions.</b> They are kept apart from your matches and your price comparison, and nothing changes until you accept or change one — then it is your decision, recorded like any other. The AI uses only what the listings say; what they do not say stays “not stated”, and price is never evidence.
      </div>
      {err && <div className="callout bad" role="alert">{errorMessage(err)}</div>}
      <Card title="Analysis">
        {s ? <AiStatusPanel status={s} isAdmin={isAdmin} onResumeGemini={() => resumeGemini.mutate(undefined)} busy={resumeGemini.isPending} /> : <div className="muted small">Loading…</div>}
        {run && <div style={{ marginTop: 10 }}><AiRunPanel run={run} isAdmin={isAdmin} busy={control.isPending} onPause={() => control.mutate({ run: run.id, action: 'pause' })} onResume={() => control.mutate({ run: run.id, action: 'resume' })} onCancel={() => control.mutate({ run: run.id, action: 'cancel' })} /></div>}
        {isAdmin && s?.configured && !run && s.state !== 'stopped' && (
          <div className="row" style={{ alignItems: 'end', marginTop: 10, flexWrap: 'wrap' }}>
            <div className="field"><label htmlFor="ai-scope">Analyse</label><select id="ai-scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="sample">A spread of your products, from every part of Match review</option><option value="unmatched">Products the matcher found nothing for</option></select></div>
            <div className="field"><label htmlFor="ai-limit">How many products</label><input id="ai-limit" type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} style={{ width: 90 }} /></div>
            <button className="btn btn-primary" disabled={start.isPending} onClick={() => start.mutate(undefined)}>Analyse with AI</button>
          </div>
        )}
        {isAdmin && s?.configured && !run && <p className="small muted" style={{ margin: '6px 0 0' }}>A product costs about one request. The free tier allows few requests a day, so start small; answers are kept and never asked for twice unless a product changes.</p>}
      </Card>

      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field"><label htmlFor="ai-status">Show</label><select id="ai-status" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1); }}>{STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="ai-type">AI answer</label><select id="ai-type" value={type} onChange={(e) => { setType(e.target.value as AiMatchType | ''); setPage(1); }}><option value="">Any</option>{(Object.keys(AI_TYPE_LABEL) as AiMatchType[]).map((k) => <option key={k} value={k}>{AI_TYPE_LABEL[k]}</option>)}</select></div>
        <div className="field"><label htmlFor="ai-decided">Pairs you already decided</label><select id="ai-decided" value={decided} onChange={(e) => { setDecided(e.target.value as typeof decided); setPage(1); }}><option value="hide">Hide them</option><option value="only">Only those (compare with the AI)</option><option value="all">Show them too</option></select></div>
      </div>

      <DataState
        q={list}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState title={s?.counts.total ? 'Nothing matches this filter' : 'No AI suggestions yet'}>
              {s?.configured ? 'Start an analysis above. Suggestions are judged in the background and appear here; you can keep using Shelfwatch meanwhile.' : 'AI analysis is not set up on this server. Everything else in Match review works without it.'}
            </EmptyState>
          </Card>
        }
      >
        {(d) => (
          <Card pad={false}>
            {d.rows.map((r, i) => (
              <div key={r.id}>
                {(i === 0 || d.rows[i - 1]!.source.variantId !== r.source.variantId) && <SourceHeader s={r.source} orgId={orgId} />}
                <AiSuggestionCard
                  s={r}
                  orgId={orgId}
                  isAdmin={isAdmin}
                  actions={{
                    busy: review.isPending,
                    onAccept: () => review.mutate({ id: r.id, body: { action: 'accept' } }),
                    onChange: (relationship) => review.mutate({ id: r.id, body: { action: 'change', relationship } }),
                    onUncertain: () => review.mutate({ id: r.id, body: { action: 'uncertain' } }),
                    onNone: () => review.mutate({ id: r.id, body: { action: 'none_of_these' } }),
                    onFindAnother: () => setFinding(r),
                  }}
                />
              </div>
            ))}
            <Pager page={page} pageSize={10} total={d.total} onPage={setPage} />
          </Card>
        )}
      </DataState>
      {finding && (
        <FindAnother s={finding} onClose={() => setFinding(null)} onChosen={(c, relationship) => { review.mutate({ id: finding.id, body: { action: 'choose_other', competitorVariantId: c.variantId, relationship } }); setFinding(null); }} />
      )}
    </div>
  );
}
