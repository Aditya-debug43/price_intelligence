import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Hosting the web app on Vercel (Root Directory "apps/web") installs ONLY that workspace's own dependency tree — `npm install` / `npm ci` run
 * from apps/web — so tools that merely sit in the repository root's devDependencies are not there. The build script is
 * `tsc --noEmit -p tsconfig.json && vite build`; `typescript` lived only at the root, and Vercel answered `sh: tsc: command not found` (exit 127).
 * Locally it worked because everyone installs from the repository root. These checks keep apps/web buildable on its own: they read the manifests
 * and sources and need no network. The real proof is the clean-clone procedure in docs/deployment.md ("Hosting the web app on Vercel").
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const web = path.join(repo, 'apps/web');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, any>;
const pkg = readJson(path.join(web, 'package.json'));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const sources = filesUnder(path.join(web, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string) => path.relative(repo, f).replace(/\\/g, '/');

describe('apps/web builds from its own dependencies (a standalone install, as on Vercel)', () => {
  it('declares the package behind every command its scripts run', () => {
    // command → the package that provides it; an unknown command fails here so this list is kept honest
    const providedBy: Record<string, string> = { tsc: 'typescript', vite: 'vite' };
    for (const name of ['build', 'typecheck', 'dev', 'preview']) {
      const script: string = pkg.scripts?.[name] ?? '';
      for (const part of script.split('&&')) {
        const bin = part.trim().split(/\s+/)[0];
        if (!bin) continue;
        expect(providedBy, `script "${name}" runs "${bin}" — add it to this test's list and declare its package in apps/web/package.json`).toHaveProperty(bin);
        expect(declared.has(providedBy[bin]!), `"${bin}" comes from "${providedBy[bin]}", which apps/web must declare itself`).toBe(true);
      }
    }
  });

  it('declares every package its source files import — nothing is borrowed from the repository root’s install', () => {
    const files = [...sources, path.join(web, 'vite.config.ts')];
    const missing: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
        const spec = (m[1] ?? m[2])!;
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        if (!declared.has(name)) missing.push(`${rel(f)} imports "${spec}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps test files out of the workspace that is built and deployed (their test runner exists only at the repository root)', () => {
    expect(sources.map(rel).filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f))).toEqual([]);
  });

  it('lists only workspace packages that really exist in this repository', () => {
    for (const dep of Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@ci/'))) {
      const dir = path.join(repo, 'packages', dep.replace('@ci/', ''));
      expect(fs.existsSync(path.join(dir, 'package.json')), dep).toBe(true);
      expect(readJson(path.join(dir, 'package.json')).name).toBe(dep);
    }
  });

  it('records its dependencies in the lockfile, so a lockfile-exact install (npm ci) from apps/web has what the build needs', () => {
    const lock = readJson(path.join(repo, 'package-lock.json'));
    const entry = lock.packages['apps/web'];
    expect(entry, 'apps/web is in package-lock.json').toBeTruthy();
    for (const kind of ['dependencies', 'devDependencies'] as const) expect(entry[kind] ?? {}, kind).toEqual(pkg[kind] ?? {});
    expect(entry.engines).toEqual(pkg.engines);
  });

  it('states the Node version it needs (Vite 8 does not run on old Node), the same one the repository requires', () => {
    const rootEngines = readJson(path.join(repo, 'package.json')).engines?.node;
    expect(pkg.engines?.node).toBe(rootEngines);
    expect(pkg.engines?.node).toMatch(/^>=22\./);
  });
});

describe('apps/web/vercel.json', () => {
  const cfg = readJson(path.join(web, 'vercel.json'));

  it('builds the Vite app into dist', () => {
    expect(cfg).toMatchObject({ framework: 'vite', outputDirectory: 'dist' });
  });

  it('sends every page address to the app (client-side routes survive a refresh) but never an /api address', () => {
    const rule = (cfg.rewrites as { source: string; destination: string }[]).find((r) => r.destination === '/index.html');
    expect(rule, 'a rewrite to /index.html').toBeTruthy();
    const matches = (p: string) => new RegExp(`^${rule!.source}$`).test(p);
    for (const page of ['/', '/login', '/register', '/onboarding', '/verify-email', '/o/0b6f/websites', '/o/0b6f/websites/9c1e', '/o/0b6f/reports/compare']) expect(matches(page), page).toBe(true);
    for (const api of ['/api/v1/health', '/api/v1/orgs/0b6f/sites/9c1e']) expect(matches(api), api).toBe(false);
  });

  it('forwards /api/* to the backend over https, keeping the path, and does so before the page rule can catch it', () => {
    const rules = cfg.rewrites as { source: string; destination: string }[];
    const api = rules.findIndex((r) => r.source === '/api/:path*');
    const page = rules.findIndex((r) => r.destination === '/index.html');
    expect(api, 'an /api/:path* rewrite').toBeGreaterThanOrEqual(0);
    expect(api).toBeLessThan(page);
    const dest = new URL(rules[api]!.destination.replace(':path*', 'x'));
    expect(dest.protocol).toBe('https:'); // cookies are Secure and the API refuses plain http in production
    expect(rules[api]!.destination.endsWith('/api/:path*')).toBe(true);
    expect(dest.hostname).not.toMatch(/^(localhost|127\.|10\.|192\.168\.|\[)/); // a real public name, never a development address
    expect(dest.hostname).toContain('.'); // not a bare internal hostname
  });

  it('points at exactly one backend, and it is the one documented for deployment', () => {
    const dests = (cfg.rewrites as { destination: string }[]).map((r) => r.destination).filter((d) => /^https?:\/\//.test(d));
    expect(dests).toEqual(['https://18-212-221-70.sslip.io/api/:path*']);
    expect(fs.readFileSync(path.join(repo, 'docs/deployment.md'), 'utf8')).toContain('18-212-221-70.sslip.io');
  });
});
