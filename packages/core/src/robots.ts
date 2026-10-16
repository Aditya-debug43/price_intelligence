/**
 * robots.txt parsing per RFC 9309:
 *  - the group whose user-agent token is the longest match for our product token wins ("*" is the fallback);
 *  - within a group the longest matching rule path wins; on a tie Allow beats Disallow;
 *  - "*" matches any sequence and a trailing "$" anchors the end of the path;
 *  - an empty Disallow means "allow everything".
 * Crawl-delay is not part of RFC 9309 but widely honoured; we always honour it.
 */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay: number | null;
}

export interface ParsedRobots {
  groups: Group[];
  sitemaps: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // Empty "Disallow:" is a no-op; empty "Allow:" likewise.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function patternToRegex(pattern: string): RegExp {
  let anchored = false;
  let p = pattern;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

function selectGroup(robots: ParsedRobots, userAgent: string): Group | null {
  const ua = userAgent.toLowerCase();
  let best: { group: Group; len: number } | null = null;
  for (const g of robots.groups) {
    for (const agent of g.agents) {
      if (agent === '*') {
        if (!best) best = { group: g, len: 0 };
      } else if (agent.length > 0 && ua.includes(agent)) {
        if (!best || agent.length > best.len) best = { group: g, len: agent.length };
      }
    }
  }
  return best?.group ?? null;
}

export interface RobotsDecision {
  allowed: boolean;
  /** The matching rule that decided the outcome, for transparency in profiles. */
  matchedRule: string | null;
}

export function robotsDecision(robots: ParsedRobots, userAgent: string, pathAndQuery: string): RobotsDecision {
  const group = selectGroup(robots, userAgent);
  if (!group) return { allowed: true, matchedRule: null };
  let best: { rule: Rule; len: number } | null = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.pattern).test(pathAndQuery)) continue;
    const len = rule.pattern.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && rule.allow && !best.rule.allow)) best = { rule, len };
  }
  if (!best) return { allowed: true, matchedRule: null };
  return {
    allowed: best.rule.allow,
    matchedRule: `${best.rule.allow ? 'Allow' : 'Disallow'}: ${best.rule.pattern}`,
  };
}

export function robotsAllows(robots: ParsedRobots, userAgent: string, pathAndQuery: string): boolean {
  return robotsDecision(robots, userAgent, pathAndQuery).allowed;
}

export function robotsCrawlDelay(robots: ParsedRobots, userAgent: string): number | null {
  return selectGroup(robots, userAgent)?.crawlDelay ?? null;
}

/** True when the site disallows everything for us (e.g. "User-agent: *\nDisallow: /"). */
export function robotsDisallowsAll(robots: ParsedRobots, userAgent: string): boolean {
  return !robotsAllows(robots, userAgent, '/') && !robotsAllows(robots, userAgent, '/products');
}

/**
 * Policy used when robots.txt cannot be retrieved. RFC 9309: most 4xx = no restrictions, 5xx/unreachable = assume
 * disallow. We are deliberately stricter for 401/403/429: those usually mean an access gate or bot protection,
 * which we never try to work around.
 */
export function robotsFromStatus(status: number | null): 'allow_all' | 'disallow_all' | 'parse' {
  if (status === null) return 'disallow_all';
  if (status >= 200 && status < 300) return 'parse';
  if (status === 401 || status === 403 || status === 429) return 'disallow_all';
  if (status >= 400 && status < 500) return 'allow_all';
  return 'disallow_all';
}

export const EMPTY_ROBOTS: ParsedRobots = { groups: [], sitemaps: [] };
export const DISALLOW_ALL_ROBOTS: ParsedRobots = {
  groups: [{ agents: ['*'], rules: [{ allow: false, pattern: '/' }], crawlDelay: null }],
  sitemaps: [],
};
