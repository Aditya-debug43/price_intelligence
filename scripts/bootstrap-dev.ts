/** Creates (once) a local development user with a random password written to .data/dev-credentials.json (git-ignored). */
import { ensureDevUser, openCli, root } from './lib/cli.ts';
import path from 'node:path';

const cli = await openCli();
const u = await ensureDevUser(cli);
console.log(u.created ? 'Created the local development user.' : 'The local development user already exists.');
console.log(`  email:    ${u.email}`);
console.log(`  password: stored in ${path.join(root, '.data', 'dev-credentials.json')} (random, git-ignored)`);
await cli.close();
