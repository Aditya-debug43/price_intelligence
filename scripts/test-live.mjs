// Runs the LIVE verification procedure: it sends real requests to real websites, so it is never part of `npm test`.
// Usage:  npm run test:live
//         LIVE_SOURCE_URL=https://your-shop.example LIVE_COMPETITOR_URLS=https://rival-one.example,https://rival-two.example npm run test:live
// Defaults to public sandbox shops built for scraping practice. Read docs/verification-report.md first.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, LIVE_TESTS: '1' };
const custom = !!env.LIVE_SOURCE_URL;
console.log('\nLIVE TESTS — real requests to real websites (polite pace, robots.txt obeyed, no sign-in, no bypassing).');
console.log(custom
  ? `Targets you named: source ${env.LIVE_SOURCE_URL}; competitors ${env.LIVE_COMPETITOR_URLS ?? '(none)'}.\nOnly run this against websites you are entitled to collect from.\n`
  : 'Targets: public sandbox shops made for scraping practice (books.toscrape.com, scrapeme.live, scrapingcourse.com).\n');
const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--project', 'live', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: root });
process.exit(r.status ?? 1);
