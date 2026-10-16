/**
 * Shared tsup settings for the API and the worker.
 *
 * Workspace packages (@ci/*) export TypeScript source, so they are bundled into the output. Every third-party package stays
 * external and is loaded from node_modules at run time: some of them read data files relative to their own location (pdfkit's
 * fonts) or are optional (playwright-core), and none of that survives being inlined into one file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Options } from 'tsup';

/** tsup bundles this file, so its own location is not the repository; walk up from where the build was started instead. */
function findRepoRoot(from = process.cwd()): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'packages', 'core', 'package.json'))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`Could not find the repository root above ${from}`);
  }
}
const root = findRepoRoot();

function thirdPartyDependencies(): string[] {
  const names = new Set<string>(['playwright-core', 'playwright']);
  for (const dir of readdirSync(path.join(root, 'packages'))) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (!dep.startsWith('@ci/')) names.add(dep);
  }
  return [...names];
}

export const baseConfig: Options = {
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  noExternal: [/^@ci\//],
  external: thirdPartyDependencies(),
};
