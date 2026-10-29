/**
 * Builds the SECOND-REVIEWER sheet: a sample of the labelled evaluation pairs, in random order, with the first labeller's labels removed.
 *
 *   npx tsx scripts/match-review-sheet.ts [--seed 20261029] [--out fixtures/matching/eval-v1/second-review]
 *
 * Writes review-sheet.csv (what the second reviewer fills in), mapping.json (review id → evaluation pair; keep it away from the reviewer) and
 * REVIEW-GUIDE.md. Agreement is computed afterwards by `scripts/match-kappa.ts`. The sample is stratified by the first labeller's label so the hard
 * classes (substitute, related, not enough information) are covered; it is NOT a random sample of all pairs, which is stated in the guide.
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const seed0 = Number(arg('seed', '20261029'));
const outDir = arg('out', 'fixtures/matching/eval-v1/second-review');
const set = JSON.parse(fs.readFileSync('fixtures/matching/eval-v1/eval-set.json', 'utf8')) as { pairs: { id: string; domain: string; set: string; sourceTitle: string; competitorTitle: string; competitorSite: string; label: string; uncertain: boolean }[] };

let seed = seed0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const shuffle = <T,>(xs: T[]) => xs.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

// how many of each of the first labeller's classes to include (a class with fewer pairs contributes all of them)
const TARGET: Record<string, number> = { E: 14, V: 6, S: 18, R: 18, I: 18, N: 46 };
const picked = Object.entries(TARGET).flatMap(([label, n]) => shuffle(set.pairs.filter((p) => p.label === label)).slice(0, n));
const sheet = shuffle(picked).map((p, i) => ({ review_id: `rv-${String(i + 1).padStart(3, '0')}`, pair: p }));

const csv = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lines = ['review_id,source_product,competitor_product,competitor_website,your_label,unsure,notes'];
for (const { review_id, pair } of sheet) lines.push([review_id, csv(pair.sourceTitle), csv(pair.competitorTitle), csv(pair.competitorSite), '', '', ''].join(','));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'review-sheet.csv'), lines.join('\r\n') + '\r\n');
fs.writeFileSync(path.join(outDir, 'mapping.json'), JSON.stringify({ seed: seed0, createdFrom: 'fixtures/matching/eval-v1/eval-set.json', pairs: sheet.map((s) => ({ reviewId: s.review_id, id: s.pair.id })) }, null, 1));

const bySet = (s: string) => sheet.filter((x) => x.pair.set === s).length;
const byLabel = Object.fromEntries(Object.keys(TARGET).map((l) => [l, sheet.filter((x) => x.pair.label === l).length]));
const guide = `# Second-reviewer guide

Please decide, for each row of \`review-sheet.csv\`, how the two products relate. Use only what the two titles (and website names) tell you, plus what you know about the products.
Fill the **your_label** column with one letter, put \`y\` in **unsure** when you are not confident, and use **notes** for anything worth saying.

| Letter | Meaning |
|---|---|
| **E** | The same product (same brand, same item, same size/pack/colour or an obviously identical listing). |
| **V** | The same product in another pack, size or colour (a variant of the same thing). |
| **S** | A different brand or version a shopper could buy *instead* (same job, same kind, comparable size / the same vehicle part). A fair stand-in. |
| **R** | Related but not a stand-in: an accessory or companion, a different part for the same vehicle, a different kind of product, a different flavour or variety. |
| **I** | Not enough information in the titles to tell. |
| **N** | Not a match: different products with nothing that makes them interchangeable. |

For light bulbs: the same socket code (H11, 9005, 3157, T10 …) and the same position (low beam, fog, brake light …) makes a stand-in (**S**); a vehicle-specific bundle against a single generic bulb is a stand-in only if it clearly contains the same bulb for the same position, otherwise **I** or **R**. A bulb is not an adapter, a decoder, a harness or a fixture.

Do not try to guess what any other reviewer or any program would say; the point is an independent opinion.

How this sample was made: ${sheet.length} pairs from the ${set.pairs.length} labelled pairs, drawn at random *within* each of the first labeller's classes (${Object.entries(byLabel).map(([l, n]) => `${l}: ${n}`).join(', ')}) so that the harder classes are covered; the order is random. It is therefore **not** a random sample of all pairs. ${bySet('dev')} are from the development part and ${bySet('heldout')} from the held-out part of the evaluation set.
When you are done, send the file back; agreement is then computed with \`npx tsx scripts/match-kappa.ts <your file>\`, and disagreements are listed for discussion. Nothing is changed in the evaluation set automatically.
`;
fs.writeFileSync(path.join(outDir, 'REVIEW-GUIDE.md'), guide);
console.log(`wrote ${sheet.length} pairs to ${outDir} (dev ${bySet('dev')}, heldout ${bySet('heldout')}; by first label ${JSON.stringify(byLabel)})`);
