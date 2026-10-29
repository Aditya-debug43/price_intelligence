/**
 * Agreement between the first labeller and a second reviewer, from the filled-in review sheet.
 *
 *   npx tsx scripts/match-kappa.ts <filled review-sheet.csv> [--mapping fixtures/matching/eval-v1/second-review/mapping.json] [--out agreement.json]
 *
 * Prints, over the rows the reviewer labelled: raw agreement and Cohen's kappa for the six classes, for "genuine counterpart (E/V/S) or not", and
 * for "same product (E/V) or not"; and lists every disagreement. It never edits the evaluation set. With fewer than 30 labelled rows the result is
 * only printed as counts, because a kappa from so few rows says nothing.
 */
import fs from 'node:fs';
import { cohensKappa } from '@ci/core';

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: tsx scripts/match-kappa.ts <filled review-sheet.csv> [--mapping mapping.json] [--out agreement.json]'); process.exit(1); }
const mapping = JSON.parse(fs.readFileSync(arg('mapping', 'fixtures/matching/eval-v1/second-review/mapping.json')!, 'utf8')) as { pairs: { reviewId: string; id: string }[] };
const set = JSON.parse(fs.readFileSync('fixtures/matching/eval-v1/eval-set.json', 'utf8')) as { pairs: { id: string; set: string; domain: string; sourceTitle: string; competitorTitle: string; label: string; uncertain: boolean }[] };
const byId = new Map(set.pairs.map((p) => [p.id, p]));
const idOf = new Map(mapping.pairs.map((m) => [m.reviewId, m.id]));

/** Minimal CSV reader (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const table = parseCsv(fs.readFileSync(file, 'utf8'));
const head = table[0]!.map((h) => h.trim().toLowerCase());
const col = (name: string) => head.indexOf(name);
const iId = col('review_id'), iLabel = col('your_label'), iUnsure = col('unsure');
if (iId < 0 || iLabel < 0) { console.error('the sheet needs the columns review_id and your_label'); process.exit(1); }

const VALID = new Set(['E', 'V', 'S', 'R', 'I', 'N']);
const rows = table.slice(1).map((r) => ({ reviewId: r[iId]!.trim(), label: (r[iLabel] ?? '').trim().toUpperCase(), unsure: /^y/i.test((r[iUnsure] ?? '').trim()) }))
  .filter((r) => VALID.has(r.label) && byId.has(idOf.get(r.reviewId) ?? ''));
const first = rows.map((r) => byId.get(idOf.get(r.reviewId)!)!.label);
const second = rows.map((r) => r.label);
const same = (x: string[], y: string[]) => x.filter((v, i) => v === y[i]).length;
const bin = (xs: string[], keep: string[]) => xs.map((x) => (keep.includes(x) ? 'yes' : 'no'));
const report: Record<string, unknown> = { labelledRows: rows.length, ofSheet: mapping.pairs.length };
console.log(`${rows.length} of ${mapping.pairs.length} rows labelled by the second reviewer`);
const measure = (name: string, a: string[], b: string[]) => {
  const agree = same(a, b) / Math.max(1, a.length);
  const kappa = rows.length >= 30 ? cohensKappa(a, b) : null;
  report[name] = { agreement: agree, kappa };
  console.log(`  ${name}: agreement ${(100 * agree).toFixed(1)}%${kappa === null ? '  (kappa not reported: fewer than 30 rows)' : `, Cohen's kappa ${kappa.toFixed(2)}`}`);
};
measure('six classes (E/V/S/R/I/N)', first, second);
measure('genuine counterpart (E/V/S) or not', bin(first, ['E', 'V', 'S']), bin(second, ['E', 'V', 'S']));
measure('same product (E/V) or not', bin(first, ['E', 'V']), bin(second, ['E', 'V']));
const disagreements = rows.filter((r, i) => first[i] !== second[i]).map((r) => { const p = byId.get(idOf.get(r.reviewId)!)!; return { reviewId: r.reviewId, id: p.id, set: p.set, first: p.label, firstUncertain: p.uncertain, second: r.label, secondUnsure: r.unsure, source: p.sourceTitle, competitor: p.competitorTitle }; });
report['disagreements'] = disagreements;
console.log(`\n${disagreements.length} disagreements:`);
for (const d of disagreements) console.log(`  ${d.reviewId} [${d.id}] first ${d.first}${d.firstUncertain ? '?' : ''} / second ${d.second}${d.secondUnsure ? '?' : ''}  ${d.source.slice(0, 55)} || ${d.competitor.slice(0, 55)}`);
const out = arg('out');
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
