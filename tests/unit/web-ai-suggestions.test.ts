import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AiProductView, AiStatusView, AiSuggestionView } from '@ci/shared';

// The web app is compiled by its own project (DOM + JSX settings), so this root-level test loads its screen components at run time.
type Component = FunctionComponent<Record<string, unknown>>;
const AI_MODULE: string = '../../apps/web/src/pages/AiSuggestions.tsx';
const TEXT_MODULE: string = '../../apps/web/src/match-text.ts';
let AiSuggestionCard: Component;
let AiStatusPanel: Component;
let AttributeTable: Component;
let comparisonRows: (a: AiProductView, b: AiProductView) => { label: string; a: string; b: string; differs: boolean }[];
let showValue: (v: unknown) => string;
let acceptWords: (t: string) => string | null;
let awaitingNote: (n: number, include?: 'suggested' | 'confirmed') => string | null;
beforeAll(async () => {
  ({ AiSuggestionCard, AiStatusPanel, AttributeTable, comparisonRows, showValue, acceptWords } = (await import(/* @vite-ignore */ AI_MODULE)) as never);
  ({ awaitingNote } = (await import(/* @vite-ignore */ TEXT_MODULE)) as never);
});

const product = (over: Partial<AiProductView> = {}): AiProductView => ({
  variantId: 'v1', productId: 'p1', siteName: 'Rival Lights', title: 'Rival H11 LED Headlight Bulbs', variantTitle: 'Low beam', brand: 'Rival', price: 59.99, currency: 'USD', url: 'https://rival.example/products/h11',
  productType: 'bulb', identifiers: { mpn: 'RV-H11' }, attributes: { part_codes: { value: ['H11'], source: 'title' }, power_w: { value: 55, source: 'title' }, lamp_position: { value: ['low beam'], source: 'variant option' } }, unknown: ['model_years'], domain: 'automotive', ...over,
});
const suggestion = (over: Partial<AiSuggestionView> = {}): AiSuggestionView => ({
  id: 's1', status: 'pending', matchType: 'close_equivalent', aiMatchType: 'close_equivalent', confidence: 'medium', priceComparable: false, requiresReview: true, explanation: 'Both are H11 low-beam LED bulbs of 55 W.',
  supporting: [{ attribute: 'part codes', source_value: 'H11', candidate_value: 'H11', result: 'agree', grounded: true }], conflicting: [{ attribute: 'power w', source_value: '55', candidate_value: '60', result: 'different', grounded: true }], missing: ['model years'],
  guards: [], foundBy: [{ method: 'code', rank: 1, detail: 'codes H11' }], engine: { relationship: 'substitute', tier: 'medium', conflicts: [], summary: 'x' }, policy: { quantity: { verdict: 'unknown', note: 'n' }, bundle: null },
  source: product({ variantId: 'v0', productId: 'p0', siteName: 'Your shop', title: 'Sealight H11 LED Headlight Bulbs', brand: 'Sealight', identifiers: {}, attributes: { part_codes: { value: ['H11'], source: 'title' }, power_w: { value: 60, source: 'title' } } }), candidate: product(),
  existingMatch: null, model: 'gemini-3.5-flash-lite', promptVersion: 'ai-match-prompt-3', analysedAt: '2026-11-04T10:00:00.000Z', review: null, ...over,
});
const html = (c: Component, props: Record<string, unknown>) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(c, props)));
const actions = { onAccept() {}, onChange() {}, onUncertain() {}, onNone() {}, onFindAnother() {}, busy: false };

describe('an AI suggestion card says what the AI answered, why, and what it is not', () => {
  it('shows the match type, the confidence (not a probability), the reason, the evidence and both sources', () => {
    const out = html(AiSuggestionCard, { s: suggestion(), orgId: 'o1', isAdmin: true, actions });
    expect(out).toContain('Close equivalent');
    expect(out).toContain('Medium confidence');
    expect(out).toContain('It is not a probability');
    expect(out).toContain('Both are H11 low-beam LED bulbs of 55 W.');
    expect(out).toContain('Facts that agree');
    expect(out).toContain('Facts that differ or conflict');
    expect(out).toContain('model years');
    expect(out).toContain('Rival H11 LED Headlight Bulbs');
    expect(out).toContain('View source');
    expect(out).toContain('gemini-3.5-flash-lite');
  });

  it('offers every review action to an administrator, and none to anyone else', () => {
    const admin = html(AiSuggestionCard, { s: suggestion(), orgId: 'o1', isAdmin: true, actions });
    for (const word of ['Yes — a compatible equivalent', 'Change to this', 'Not sure yet', 'Find another product', 'None of these']) expect(admin).toContain(word);
    const member = html(AiSuggestionCard, { s: suggestion(), orgId: 'o1', isAdmin: false, actions });
    expect(member).not.toContain('Change to this');
    expect(member).not.toContain('None of these');
    expect(member).toContain('View source');
  });

  it('a close equivalent is accepted as a compatible equivalent: never "the same product", never a mere substitute', () => {
    expect(acceptWords('close_equivalent')).toBe('a compatible equivalent');
    expect(acceptWords('exact_item')).toBe('the same product');
    expect(acceptWords('substitute')).toBe('a substitute');
    expect(acceptWords('no_match_uncertain')).toBeNull();
    const none = html(AiSuggestionCard, { s: suggestion({ matchType: 'no_match_uncertain', aiMatchType: 'no_match_uncertain' }), orgId: 'o1', isAdmin: true, actions });
    expect(none).not.toContain('Yes —');
  });

  it('says when the safeguards changed the AI’s answer, and why', () => {
    const out = html(AiSuggestionCard, { s: suggestion({ matchType: 'substitute', aiMatchType: 'close_equivalent', guards: [{ code: 'compat_gate', note: 'Not a verified compatible equivalent (the bulb or part code is not shown to be the same), so it is a substitute.' }] }), orgId: 'o1', isAdmin: true, actions });
    expect(out).toContain('The AI first answered “Close equivalent”; Shelfwatch’s checks changed it to “Substitute”');
    expect(out).toContain('Safeguard:');
    expect(out).toContain('not shown to be the same');
  });

  it('a pair a person already decided shows that the decision stands, and offers no action on it', () => {
    const out = html(AiSuggestionCard, { s: suggestion({ existingMatch: { id: 'm1', status: 'accepted', relationship: 'exact' } }), orgId: 'o1', isAdmin: true, actions });
    expect(out).toContain('Your decision stands');
    expect(out).not.toContain('None of these');
  });

  it('a different-pack suggestion is labelled and says the price comparison is unchanged', () => {
    const out = html(AiSuggestionCard, { s: suggestion({ matchType: 'same_product_different_pack', aiMatchType: 'same_product_different_pack' }), orgId: 'o1', isAdmin: false });
    expect(out).toContain('Different pack');
    expect(out).toContain('the price comparison is unchanged');
  });

  it('a value the AI quoted that is not in the facts it was given is shown as not counted', () => {
    const out = html(AiSuggestionCard, { s: suggestion({ supporting: [{ attribute: 'warranty', source_value: '5 years', candidate_value: '5 years', result: 'agree', grounded: false }] }), orgId: 'o1', isAdmin: false });
    expect(out).toContain('not found in the facts the AI was given, so it is not counted');
  });
});

describe('the attribute comparison follows what matters for the kind of product', () => {
  it('compares bulb code, power and lamp position for a vehicle part, and highlights what differs', () => {
    const s = suggestion();
    const rows = comparisonRows(s.source, s.candidate);
    const by = (l: string) => rows.find((r) => r.label === l);
    expect(by('Bulb / socket code')).toMatchObject({ a: 'H11', b: 'H11', differs: false });
    expect(by('Power (W)')).toMatchObject({ a: '60', b: '55', differs: true });
    expect(by('Brand')).toMatchObject({ a: 'Sealight', b: 'Rival', differs: true });
    expect(by('Part number')).toMatchObject({ a: '', b: 'RV-H11' });
    const out = html(AttributeTable, { s });
    expect(out).toContain('Bulb / socket code');
    expect(out).toContain('read from title');
    expect(out).toContain('“Not stated” means the listing does not say; it is never guessed.');
  });

  it('compares quantity, pack count and flavour for groceries', () => {
    const g = (over: Partial<AiProductView>) => product({ domain: 'grocery', productType: null, identifiers: { gtin: '0123456789012' }, ...over });
    const a = g({ brand: 'Heineken', attributes: { quantity: { value: '330 ml (volume)', source: 'title' }, pack_count: { value: 24, source: 'title' }, flavour_or_variety: { value: ['lager'], source: 'title' } } });
    const b = g({ brand: null, attributes: { quantity: { value: '330 ml (volume)', source: 'title' }, pack_count: { value: 6, source: 'title' }, title_begins_with: { value: 'Belga Star Lager', source: 'title' } } });
    const rows = comparisonRows(a, b);
    expect(rows.find((r) => r.label === 'Pack count')).toMatchObject({ a: '24', b: '6', differs: true });
    expect(rows.find((r) => r.label === 'Quantity')).toMatchObject({ differs: false });
    expect(rows.find((r) => r.label === 'Barcode')?.a).toBe('0123456789012');
  });

  it('shows values as people read them', () => {
    expect(showValue(['H11', 'H8'])).toBe('H11, H8');
    expect(showValue(true)).toBe('yes');
    expect(showValue({ is_bundle: true, parts: ['2x headlight', 'brake light'], without: ['fog light'] })).toBe('bundle: 2x headlight + brake light (without fog light)');
    expect(showValue(null)).toBe('');
  });
});

describe('the status panel is honest about quota and stops', () => {
  const status = (over: Partial<AiStatusView> = {}): AiStatusView => ({
    configured: true, model: 'gemini-3.5-flash-lite', limits: { rpm: 12, tpm: 150000, dailyBudget: 200, learned: { rpm: 15 } }, today: { day: '2026-11-04', requests: 6, inputTokens: 11868, outputTokens: 9608, failures: 0, rateLimited: 0, cachedResults: 3 },
    state: 'idle', pausedUntil: null, pauseReason: null, stopped: null, activeRun: null, counts: { pending: 44, accepted: 0, changed: 0, uncertain: 0, noneOfThese: 0, total: 44 }, note: 'Google does not tell us how much of its quota is left.', ...over,
  });
  it('reports what was sent, the limits, and that the remaining quota is unknown', () => {
    const out = html(AiStatusPanel, { status: status(), isAdmin: true });
    expect(out).toContain('Gemini (free tier)');
    expect(out).toContain('ready');
    expect(out).toContain('<b>6</b> requests sent of <b>200</b>');
    expect(out).toContain('Google’s own answers say its limit is 15 a minute');
    expect(out).toContain('Google does not tell us how much of its free quota is left');
  });
  it('a stop is an alert and an administrator can clear it after fixing the cause; a member cannot', () => {
    const stopped = status({ state: 'stopped', stopped: 'Google reports a non-free-tier quota for this project.' });
    expect(html(AiStatusPanel, { status: stopped, isAdmin: true, onResumeGemini() {} })).toContain('I have fixed this');
    const member = html(AiStatusPanel, { status: stopped, isAdmin: false });
    expect(member).toContain('Gemini processing is stopped');
    expect(member).not.toContain('I have fixed this');
  });
  it('without a key it says everything else still works', () => {
    const out = html(AiStatusPanel, { status: status({ configured: false, state: 'not_configured', note: 'No Gemini API key is configured on the server. Everything else in Shelfwatch works without it.' }), isAdmin: true });
    expect(out).toContain('not set up');
    expect(out).toContain('works without it');
  });
});

describe('the price page no longer contradicts itself about suggestions', () => {
  it('says suggestions ARE shown (marked, never counted) when the filter includes them, and are NOT shown when it does not', () => {
    const shown = awaitingNote(3, 'suggested')!;
    expect(shown).toContain('shown below marked “suggested”');
    expect(shown).not.toContain('not shown here');
    const hidden = awaitingNote(3, 'confirmed')!;
    expect(hidden).toContain('not shown here');
    expect(awaitingNote(0)).toBeNull();
  });
});

describe('the status panel shows each key by label, never the key', () => {
  const status = (over: Partial<AiStatusView> = {}): AiStatusView => ({
    configured: true, model: 'gemini-3.5-flash-lite', continuous: true,
    keys: [
      { id: 'k1', label: 'Key 1', state: 'ready', pausedUntil: null, pauseReason: null, stopped: null, today: { requests: 120, inputTokens: 90_000, outputTokens: 12_000, failures: 0, rateLimited: 0 }, learned: { rpd: 250 } },
      { id: 'k2', label: 'Key 2', state: 'paused', pausedUntil: '2026-11-07T08:00:00.000Z', pauseReason: 'The daily quota is used up.', stopped: null, today: { requests: 250, inputTokens: 180_000, outputTokens: 20_000, failures: 2, rateLimited: 3 }, learned: {} },
    ],
    limits: { rpm: 24, tpm: 500_000, dailyBudget: 400, learned: {} }, today: { day: '2026-11-06', requests: 370, inputTokens: 270_000, outputTokens: 32_000, failures: 2, rateLimited: 3, cachedResults: 14 },
    state: 'running', pausedUntil: null, pauseReason: null, stopped: null, activeRun: null, counts: { pending: 4, accepted: 1, changed: 0, uncertain: 0, noneOfThese: 0, total: 5 }, note: 'Work is spread over 2 keys.', ...over,
  });
  it('lists both keys with their own use and state', () => {
    const out = html(AiStatusPanel, { status: status(), isAdmin: true });
    expect(out).toContain('Key 1');
    expect(out).toContain('Key 2');
    expect(out).toContain('120 requests today');
    expect(out).toContain('250 requests today');
    expect(out).toContain('waiting for quota');
    expect(out).toContain('Google’s answers say 250 a day');
    expect(out).not.toMatch(/AIza|AQ\./);
  });
  it('shows a stopped key and why', () => {
    const out = html(AiStatusPanel, { status: status({ keys: [{ id: 'k1', label: 'Key 1', state: 'stopped', pausedUntil: null, pauseReason: null, stopped: 'Google refused this key.', today: { requests: 0, inputTokens: 0, outputTokens: 0, failures: 1, rateLimited: 0 }, learned: {} }], state: 'stopped', stopped: 'Google refused this key.' }), isAdmin: true, onResumeGemini() {} });
    expect(out).toContain('Google refused this key.');
    expect(out).toContain('stopped');
  });
});
