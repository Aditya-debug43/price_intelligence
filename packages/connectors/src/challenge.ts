/**
 * Detects bot-protection challenges and login walls. When one is found the collector STOPS: it never solves
 * CAPTCHAs, rotates identities, or tries to get around the barrier.
 */

export interface ChallengeResult {
  detected: boolean;
  kind: string | null;
}

export function detectChallenge(html: string, headers: Record<string, string>, status: number): ChallengeResult {
  const h = html.slice(0, 60_000).toLowerCase();
  const server = (headers['server'] ?? '').toLowerCase();
  const cf = server.includes('cloudflare') || 'cf-ray' in headers;
  if ((cf && (h.includes('just a moment') || h.includes('cf-chl') || h.includes('challenge-platform') || h.includes('attention required'))) || headers['cf-mitigated'] === 'challenge') {
    return { detected: true, kind: 'Cloudflare challenge' };
  }
  if (/captcha-delivery\.com|datadome/.test(h)) return { detected: true, kind: 'DataDome bot protection' };
  if (/px-captcha|perimeterx|human verification/.test(h)) return { detected: true, kind: 'PerimeterX bot protection' };
  if (status >= 400 && /akamai|reference #\d/.test(h + server)) return { detected: true, kind: 'Akamai access denial' };
  if (/g-recaptcha|h-captcha|hcaptcha|cf-turnstile/.test(h) && (status === 403 || status === 429 || status === 503 || /verify you are (a )?human|are you a robot/.test(h))) {
    return { detected: true, kind: 'CAPTCHA' };
  }
  if (/verify you are (a )?human|are you a robot|unusual traffic from your/.test(h)) return { detected: true, kind: 'Human verification page' };
  return { detected: false, kind: null };
}

export function detectLoginWall(finalUrl: string, html: string): boolean {
  let path = '';
  try {
    path = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  if (/\/(login|signin|sign-in|account\/login|customer\/account\/login|my-account)\/?$/.test(path)) return true;
  const h = html.slice(0, 40_000).toLowerCase();
  // Shopify password-protected storefront
  if (path === '/password' || /<form[^>]*action="[^"]*\/password"/.test(h)) return true;
  return /please (log|sign) ?in to (view|see|access)|members only|login required to view prices|log in to see prices/.test(h);
}
