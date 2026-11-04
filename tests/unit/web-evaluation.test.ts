import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MatchCounts } from '@ci/shared';

// The web app is compiled by its own project (DOM + JSX settings), so this root-level test loads its screen components at run time.
type Component = FunctionComponent<Record<string, unknown>>;
const EVAL_MODULE: string = '../../apps/web/src/pages/Evaluation.tsx';
const COUNTS_MODULE: string = '../../apps/web/src/match-counts.tsx';
const AI_MODULE: string = '../../apps/web/src/pages/AiSuggestions.tsx';
let ReportTable: Component;
let GateTable: Component;
let LabelCase: Component;
let MatchCountsPanel: Component;
let AiSuggestionCard: Component;
let pct: (p: { hits: number; total: number }) => string;
beforeAll(async () => {
  ({ ReportTable, GateTable, LabelCase, pct } = (await import(/* @vite-ignore */ EVAL_MODULE)) as never);
  ({ MatchCountsPanel } = (await import(/* @vite-ignore */ COUNTS_MODULE)) as never);
  ({ AiSuggestionCard } = (await import(/* @vite-ignore */ AI_MODULE)) as never);
});
const html = (c: Component, props: Record<string, unknown>) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(c, props)));
const P = (hits: number, total: number) => ({ hits, total });
const system = { found: P(0, 0), correct: P(0, 0), precision: P(0, 0), falseOnNone: P(0, 0) };
const group = (over: Record<string, unknown> = {}) => ({ cases: 12, positives: 8, noCounterpart: 4, candidateRecall: P(7, 8), rule: system, ai: system, combined: { found: P(6, 8), correct: P(5, 8), precision: P(5, 6), falseOnNone: P(1, 4) }, autoPrecision: P(0, 0), automaticCoverage: P(0, 8), humanReviewShare: P(4, 8), unresolvedShare: P(4, 8), ...over });

describe('the evaluation screens report measured numbers, not claims', () => {
  it('shows "of" counts with percentages, and "no examples" instead of a made-up figure', () => {
    expect(pct(P(7, 8))).toBe('7 of 8 (87.5%)');
    expect(pct(P(0, 0))).toBe('no examples');
    const out = html(ReportTable, { title: 'Holdout', groups: { 'All holdout cases': group() } });
    expect(out).toContain('7 of 8 (87.5%)');
    expect(out).toContain('1 of 4 (25.0%)');
    expect(out).toContain('no examples'); // auto-approval precision with nothing auto-approved
    expect(out).toContain('Candidate recall (the true variant reached the candidates)');
    expect(html(ReportTable, { title: 'x', groups: { Empty: group({ cases: 0 }) } })).toBe('');
  });

  const gate = (passed: boolean) => ({ domain: 'automotive', autoClass: 'compatible_equivalent', result: { passed, lines: [{ name: 'candidate recall', interval: { estimate: 0.9, low: 0.8, high: 0.95 }, needed: 0.95, examples: 120, passed, why: passed ? '96.0% reaches 95.0%' : 'only 20 labelled examples (at least 100 are needed)' }] } });
  it('a gate that has not passed shows why, and its switch is closed', () => {
    const out = html(GateTable, { gates: [gate(false)], flags: [], isAdmin: true, onToggle() {} });
    expect(out).toContain('not passed');
    expect(out).toContain('only 20 labelled examples');
    expect(out).toMatch(/<button class="btn btn-sm btn-primary" disabled=""[^>]*>Switch on<\/button>/);
    expect(out).toContain('Closed: the measurement has not passed the release gate.');
  });
  it('a gate that passed can be switched on by an administrator and not by anyone else; an enabled class can be switched off', () => {
    expect(html(GateTable, { gates: [gate(true)], flags: [], isAdmin: true, onToggle() {} })).not.toMatch(/disabled=""[^>]*>Switch on/);
    expect(html(GateTable, { gates: [gate(true)], flags: [], isAdmin: false })).not.toContain('Switch on');
    const on = html(GateTable, { gates: [gate(true)], flags: [{ domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true, enabledAt: '2026-11-04T10:00:00.000Z', disabledReason: null }], isAdmin: true, onToggle() {} });
    expect(on).toContain('Switch off');
    expect(on).toContain('>on</span>');
  });
});

describe('labelling shows products, not the system’s opinion', () => {
  const c = {
    id: 'c1', stratum: 'ai', split: 'holdout', domain: 'automotive', status: 'pending', siteId: 's1', siteName: 'Auxito',
    source: { variantId: 'v0', productId: 'p0', title: 'Sealight H11 LED Headlight Bulbs', variantTitle: null, brand: 'Sealight', mpn: 'SL-H11', sku: null, size: null, price: 49.99, currency: 'USD', url: 'https://sealight.example/h11' },
    candidates: [{ variantId: 'v1', title: 'Auxito H11 LED Headlight Bulbs', variantTitle: 'Low beam', brand: 'Auxito', mpn: 'AX-H11', sku: null, size: null, price: 59.99, currency: 'USD', url: 'https://auxito.example/h11' }],
  };
  it('lists the candidate products with their facts and links, and a way to say there is none', () => {
    const out = html(LabelCase, { c, busy: false, extra: [], onLabel() {}, onSkip() {}, onSearch() {} });
    expect(out).toContain('Auxito H11 LED Headlight Bulbs');
    expect(out).toContain('Part AX-H11');
    expect(out).toContain('View source');
    expect(out).toContain('None of these is a counterpart');
    expect(out).toContain('Holdout case');
    expect(out).toContain('the system’s own suggestions are not shown, so they cannot influence you');
    for (const leaked of ['Close equivalent', 'confidence', 'AI suggestion', 'the matcher thinks']) expect(out).not.toContain(leaked);
  });
  it('the label button is closed until a choice is made, and asks how well the labeller knows the products', () => {
    const out = html(LabelCase, { c, busy: false, extra: [], onLabel() {}, onSkip() {}, onSearch() {} });
    expect(out).toMatch(/<button class="btn btn-primary" disabled=""[^>]*>Save label<\/button>/);
    expect(out).toContain('I know these parts or products well');
    expect(out).toContain('Skip: I cannot tell');
  });
});

describe('the counts say what they count', () => {
  const zero = { exact: 0, variant: 0, equivalent: 0, substitute: 0, related: 0 };
  const counts: MatchCounts = { ownParentProducts: 120, ownVariants: 310, confirmedPairs: { ...zero, exact: 40, equivalent: 3 }, suggestedPairs: { ...zero, substitute: 900 }, confirmedOwnVariants: { ...zero, exact: 38, equivalent: 3 }, suggestedOwnVariants: { ...zero, substitute: 220 }, ownVariantsWithConfirmed: 41, ownProductsWithConfirmed: 30, uncertainOwnVariants: 15, noCounterpartOwnVariants: 90, directlyComparableOwnVariants: 12, directlyComparableOwnProducts: 9 };
  it('keeps parent products, variants and pairs apart and warns against adding them', () => {
    const out = html(MatchCountsPanel, { counts });
    expect(out).toContain('120 parent products');
    expect(out).toContain('310 sellable variants');
    expect(out).toContain('must not be added together');
    expect(out).toContain('Compatible equivalent');
    expect(out).toContain('900'); // suggested substitute PAIRS...
    expect(out).toContain('220'); // ...are 220 own variants
    expect(out).toContain('12</b> of your variants (9 parent products) have a confirmed identical-item pair whose packs are verified');
    expect(out).toContain('(this is not a finding that none exists)');
  });
});

describe('Reject is the person’s own, available on an AI suggestion', () => {
  it('shows a "Not a match" button to an administrator', () => {
    const s = { id: 's1', status: 'pending', matchType: 'substitute', aiMatchType: 'substitute', confidence: 'medium', priceComparable: false, requiresReview: true, explanation: 'x', supporting: [], conflicting: [], missing: [], guards: [], foundBy: [], engine: null, policy: { quantity: null, bundle: null }, source: { variantId: 'a', productId: 'pa', siteName: 'You', title: 'A', variantTitle: null, brand: null, price: null, currency: null, url: null, productType: null, identifiers: {}, attributes: {}, unknown: [], domain: 'general' }, candidate: { variantId: 'b', productId: 'pb', siteName: 'Them', title: 'B', variantTitle: null, brand: null, price: null, currency: null, url: null, productType: null, identifiers: {}, attributes: {}, unknown: [], domain: 'general' }, existingMatch: null, model: 'm', promptVersion: 'p', analysedAt: '2026-11-04T10:00:00.000Z', review: null };
    const actions = { onAccept() {}, onChange() {}, onUncertain() {}, onNone() {}, onReject() {}, onFindAnother() {}, busy: false };
    expect(html(AiSuggestionCard, { s, orgId: 'o', isAdmin: true, actions })).toContain('Not a match');
    expect(html(AiSuggestionCard, { s, orgId: 'o', isAdmin: false })).not.toContain('Not a match');
  });
});
