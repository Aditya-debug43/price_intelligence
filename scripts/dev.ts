/**
 * One command for local development: PostgreSQL (embedded, if nothing is listening yet) → worker → API → web.
 * Output is prefixed per process; Ctrl+C stops everything.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const node = process.execPath;
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const procs: ChildProcess[] = [];

const COLORS = { db: '\x1b[35m', worker: '\x1b[33m', api: '\x1b[36m', web: '\x1b[32m' } as const;
function run(name: keyof typeof COLORS, args: string[], cwd = root, env: NodeJS.ProcessEnv = {}): ChildProcess {
  const p = spawn(node, args, { cwd, env: { ...process.env, FORCE_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${COLORS[name]}[${name}]\x1b[0m `;
  const pipe = (s: NodeJS.ReadableStream) => s.on('data', (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => process.stdout.write(tag + l + '\n')));
  pipe(p.stdout!);
  pipe(p.stderr!);
  p.on('exit', (code) => process.stdout.write(`${tag}exited (${code})\n`));
  procs.push(p);
  return p;
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

async function waitFor(fn: () => Promise<boolean>, label: string, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const dbPort = Number(process.env.DEV_DB_PORT ?? 54329);
if (!(await portOpen(dbPort))) {
  console.log('No PostgreSQL on port', dbPort, '— starting the embedded development database…');
  run('db', [tsx, 'scripts/dev-db.ts']);
  await waitFor(() => portOpen(dbPort), 'PostgreSQL');
  await waitFor(async () => existsSync(path.join(root, '.env')), '.env');
  await new Promise((r) => setTimeout(r, 4000)); // roles + migrations run right after the server accepts connections
} else console.log('Using the PostgreSQL already listening on', dbPort);

run('worker', [tsx, 'watch', 'apps/worker/src/main.ts'], root);
await new Promise((r) => setTimeout(r, 3500)); // the worker creates the queue schema the API enqueues into
run('api', [tsx, 'watch', 'apps/api/src/main.ts'], root);
run('web', [vite], path.join(root, 'apps', 'web'));
console.log('\nWeb: http://localhost:5173    API: http://localhost:4000/api/v1/health\n');

const stop = () => {
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
