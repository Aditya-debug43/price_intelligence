import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITATION_ADVICE, adviceForLimitation } from '@ci/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const profilerSource = fs.readFileSync(path.resolve(here, '../../connectors/src/profiler.ts'), 'utf8');

describe('limitation advice', () => {
  it('covers every limitation code the profiler can emit, so a new limitation cannot ship without advice', () => {
    const emitted = new Set([...profilerSource.matchAll(/\blimit\(\s*(?:'([a-z_]+)'|[^'(),]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)')/g)].flatMap((m) => [m[1], m[2], m[3]].filter((x): x is string => !!x)));
    expect(emitted.size).toBeGreaterThan(20); // the pattern found the calls
    const missing = [...emitted].filter((code) => !(code in LIMITATION_ADVICE));
    expect(missing).toEqual([]);
  });

  it('every entry is either real advice or an explicit "nothing to do"', () => {
    for (const [code, advice] of Object.entries(LIMITATION_ADVICE)) {
      expect(advice === null || (advice.length > 20 && /[.]$/.test(advice)), code).toBe(true);
    }
  });

  it('never suggests working around a refusal: every blocking limitation offers an authorised alternative or a wait', () => {
    for (const code of ['robots_disallow', 'bot_protection', 'access_denied', 'login_required', 'terms_prohibit_automation']) {
      const a = adviceForLimitation(code)!;
      expect(a, code).toMatch(/owner|permission|authorised|feed|replace/i);
      expect(a, code).not.toMatch(/\b(bypass|circumvent|proxy|rotate|spoof|solve|captcha)\b/i);
    }
  });

  it('an unknown code has no advice rather than invented advice', () => {
    expect(adviceForLimitation('something_new')).toBeNull();
  });
});
