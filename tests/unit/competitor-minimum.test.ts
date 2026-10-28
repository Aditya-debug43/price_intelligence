import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '@ci/shared';
import { competitorsHint, competitorsTitle, initialCompetitorRows } from '../../apps/web/src/competitor-rows.ts';

/**
 * Directive 12: Shelfwatch must never demand a number of competitors again. One competitor is enough; the only count that exists is the upper limit.
 * The requirement used to live in the shared limits, in what the API told the website, in the getting-started guide and in the Setup form (three
 * empty lines, "Add at least 3"). These tests fail if any of it comes back.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.data', '.git', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|sql)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('there is no minimum number of competitors', () => {
  it('has only an upper limit in the shared limits', () => {
    expect(DEFAULTS.maxCompetitors).toBeGreaterThanOrEqual(1);
    expect(Object.keys(DEFAULTS).filter((k) => /min.*competitor|competitor.*min/i.test(k))).toEqual([]);
  });

  it('is not enforced, shown or sent anywhere in the code, the pages or the database migrations', () => {
    const files = [...sourceFiles(path.join(ROOT, 'apps')), ...sourceFiles(path.join(ROOT, 'packages'))];
    expect(files.length).toBeGreaterThan(100);
    const forbidden: [string, RegExp][] = [
      ['a minimum-competitors setting', /\bmin[_]?Competitors\b|\bMIN_COMPETITORS\b|\bminimumCompetitors\b/i],
      ['"at least 3 competitors"', /at least (3|three) competitors?/i],
      ['"3–5 competitors" wording', /\b(3|three)\s*(–|-|to)\s*(5|five) competitors?/i],
      ['padding the competitor list to 3 lines', /while \(\s*\w+\.length < 3\s*\)/],
      ['a competitor count compared with 3', /competitors?(Sites)?\.length\s*(<|>=|<=|>)\s*3\b/],
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [what, re] of forbidden) if (re.test(text)) hits.push(`${path.relative(ROOT, file)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it('has no database constraint or trigger on the number of competitors', () => {
    const migrations = sourceFiles(path.join(ROOT, 'packages/database')).filter((f) => f.endsWith('.sql'));
    expect(migrations.length).toBeGreaterThan(5);
    for (const file of migrations) {
      const sql = fs.readFileSync(file, 'utf8');
      expect(sql, path.basename(file)).not.toMatch(/competitor[^;]*(count\(|>=\s*3|<\s*3)/i);
    }
  });
});

describe('the Setup form’s competitor list', () => {
  const saved = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, url: `https://c${i}.test`, name: `C${i}` }));

  it('starts with one empty line when there are no competitors, never padded to three', () => {
    expect(initialCompetitorRows([])).toEqual([{ url: '', name: '' }]);
  });

  it('shows exactly the competitors the workspace already has, with no padding', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const rows = initialCompetitorRows(saved(n));
      expect(rows).toHaveLength(n);
      expect(rows.every((r) => r.id && r.url && r.original === r.url)).toBe(true);
    }
  });

  it('asks for one competitor at most, and says nothing once there is one', () => {
    expect(competitorsHint(0)).toMatch(/at least one competitor/i);
    for (const filled of [1, 2, 3, 5]) expect(competitorsHint(filled)).toBeNull();
    expect(competitorsHint(0)).not.toMatch(/\b3\b|three/i);
  });

  it('names only the upper limit', () => {
    expect(competitorsTitle(5)).toBe('Competitors (up to 5)');
    expect(competitorsTitle(5)).not.toMatch(/\d\s*[–-]\s*\d/);
  });
});
