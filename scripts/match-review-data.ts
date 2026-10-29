/**
 * Reads the STORED details of the products in the second-reviewer sheet (page address, brand, model, barcode, size, options, description) so the
 * review workbook can show them. Evaluation preparation only: it never writes to a database, changes a matching decision or runs a matching job.
 *
 *   npx tsx scripts/match-review-data.ts --mode local --out <records.json>
 *       reads the LOCAL development database (read-only; start it with `npm run dev:db`), matching each product by website + exact title in one workspace
 *   npx tsx scripts/match-review-data.ts --mode sql --out <query.sql>
 *       writes a READ-ONLY psql script for the production server (products picked by their stored id); run it over SSH, e.g.
 *       ssh ... 'sudo -u postgres psql -d competitor_intel -At -f -' < query.sql > records-production.json
 *
 * The output holds catalogue data and production row ids: it must stay OUT of the repository (the script refuses to write inside it).
 * Nothing is guessed: a product with no stored match simply has no record, and the workbook says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '..');
const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const mode = arg('mode');
const out = arg('out');
if (!mode || !out || !['local', 'sql'].includes(mode)) { console.error('usage: tsx scripts/match-review-data.ts --mode local|sql --out <file outside the repository> [--org AdityaGraphics]'); process.exit(1); }
const outPath = path.resolve(out);
const rel = path.relative(root, outPath);
if (!rel.startsWith('..') && !path.isAbsolute(rel) && !process.argv.includes('--allow-in-repo')) { console.error(`refusing to write ${outPath}: it is inside the repository (the output holds catalogue data and production ids)`); process.exit(1); }

interface Pair { id: string; domain: string; sourceProductId: string; competitorProductId: string; sourceTitle: string; competitorTitle: string; competitorSite: string }
const evalSet = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/matching/eval-v1/eval-set.json'), 'utf8')) as { pairs: Pair[] };
const mapping = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/matching/eval-v1/second-review/mapping.json'), 'utf8')) as { pairs: { reviewId: string; id: string }[] };
const byId = new Map(evalSet.pairs.map((p) => [p.id, p]));
const SOURCE_SITE: Record<string, string> = { automotive: 'lasfit.com', grocery: 'groceriestogoaruba.com' };

/** The two products of every pair in the sheet: id (production), website, title. */
const wanted = new Map<string, { productId: string; site: string; title: string }>();
for (const m of mapping.pairs) {
  const p = byId.get(m.id)!;
  wanted.set(p.sourceProductId, { productId: p.sourceProductId, site: SOURCE_SITE[p.domain]!, title: p.sourceTitle });
  wanted.set(p.competitorProductId, { productId: p.competitorProductId, site: p.competitorSite, title: p.competitorTitle });
}
const list = [...wanted.values()];

/** One body for both modes. $1 = JSON array of {productId, site, title}; $2 = 'id' or 'title'; $3 = workspace name or '' (any). */
const SQL = `
select coalesce(json_agg(r order by r."site", r."title"), '[]'::json) as records from (
  select p.id as "productId", w.product_id as "askedFor", s.hostname as "site", s.role as "role", p.title as "title", p.canonical_url as "url",
         p.brand as "brand", p.manufacturer as "manufacturer", p.model as "model", p.mpn as "mpn", p.category as "category", left(p.description, 700) as "description",
         p.attrs as "attrs", p.last_seen_at as "lastSeenAt",
         (select count(*)::int from variants v where v.product_id = p.id) as "variantCount",
         (select coalesce(json_agg(x), '[]'::json) from (
            select v.title as "title", v.sku as "sku", v.gtin as "gtin", v.options as "options", v.qty_label as "qtyLabel", v.qty_kind as "qtyKind", v.qty_total::float as "qtyTotal", v.url as "url"
            from variants v where v.product_id = p.id order by v.title limit 12) x) as "variants"
  from json_to_recordset($1::json) as w(product_id text, site text, title text)
  join sites s on s.hostname = w.site
  join products p on p.site_id = s.id and p.delisted_at is null and (($2 = 'id' and p.id::text = w.product_id) or ($2 = 'title' and p.title = w.title))
  join organizations o on o.id = p.org_id
  where ($3 = '' or o.name = $3)
) r`;

const rows = JSON.stringify(list.map((w) => ({ product_id: w.productId, site: w.site, title: w.title })));

if (mode === 'sql') {
  const lit = (text: string) => `$q$${text.replace(/\$q\$/g, '')}$q$`;
  const body = SQL.replace('$1::json', `${lit(rows)}::json`).replace(/\$2/g, `'id'`).replace(/\$3/g, `''`);
  const wrapped = `select json_build_object('source', 'production database (read-only export, products picked by their stored id)', 'records', q.records) from (${body}) q`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `set default_transaction_read_only = on;\n${wrapped};\n`);
  console.log(`wrote the read-only query for ${list.length} products to ${outPath}`);
  process.exit(0);
}

const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const client = new pg.Client({ connectionString: env['DATABASE_ADMIN_URL'] });
await client.connect();
await client.query('set default_transaction_read_only = on');
const org = arg('org', 'AdityaGraphics')!;
const res = await client.query(SQL, [rows, 'title', org]);
await client.end();
const records = (res.rows[0]?.records ?? []) as { site: string; title: string }[];
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ source: `local development database, workspace "${org}", matched by website and exact title`, createdAt: new Date().toISOString(), records }, null, 1));
const found = new Set(records.map((r) => `${r.site}|${r.title}`));
console.log(`asked for ${list.length} products, found ${list.filter((w) => found.has(`${w.site}|${w.title}`)).length} by website + exact title (${records.length} records) → ${outPath}`);
