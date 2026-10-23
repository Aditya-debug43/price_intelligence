import type { TermsClause, TermsLevel, TermsPageReview, TermsReview } from '@ci/shared';

/**
 * Reads the text of a website's terms of use for clauses about automated access and copying. Pure: no I/O.
 *
 * This is a screening aid, not legal advice. It looks for two things a customer must be told before collecting from a website:
 *  • `prohibits_automation` — a clause that forbids spiders, crawlers, scrapers, robots, bots or other automated means of using the site;
 *  • `restricts_copying`    — a clause that forbids copying, downloading, reproducing or commercially using the site's content without permission.
 * The first blocks collection until the customer records the owner's written permission; the second is shown as a warning the customer decides on.
 */

const AUTOMATION_TERM = /\b(spiders?|spidering|crawl(?:s|ed|er|ers|ing)?|scrap(?:e|es|ed|er|ers|ing)|robots?(?!\.txt)|bots?|data[- ]mining|automated (?:means|access|tools?|queries|software|systems?|devices?|processes|scripts?)|automatic (?:means|devices?|processes))\b/i;

/** A wording that forbids something (as opposed to merely mentioning it). */
const PROHIBITION =
  /\b(prohibit\w*|forbid\w*|forbidden|unauthori[sz]ed|may not|shall not|must not|cannot|can not|agree(?:,\s*\w+,)?\s+not|not (?:to )?(?:use|access|permitted|allowed|attempt|engage)|no (?:person|user|one) (?:may|shall|will|is)|(?:is|are) not (?:permitted|allowed)|refrain from)\b/i;

const COPY_TERM = /\b(reproduc\w+|duplicat\w+|cop(?:y|ied|ying)|download\w*|extract\w*|commercial\s+(?:use|uses|purposes?|manner|exploitation)|exploit\w*|re-?sell\w*)\b/i;
const NEEDS_PERMISSION = /\b(without|except|unless|other than)\b[^.]{0,140}\b(permission|consent|authori[sz]ation|licen[cs]e)\b/i;

const clip = (s: string, n = 420) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Sentences end at . ? ! followed by a space; a list ("prohibited from: (a) …; (b) …") therefore stays in one sentence with its lead-in. */
function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z("“0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The list item or clause around a match, with the sentence's lead-in when the match sits inside a list. */
function excerptAround(sentence: string, index: number): string {
  const start = Math.max(sentence.lastIndexOf(';', index), sentence.lastIndexOf(':', index));
  const endSemi = sentence.indexOf(';', index);
  const item = sentence.slice(start >= 0 ? start + 1 : 0, endSemi >= 0 ? endSemi : undefined).trim();
  if (start < 0 || item.length >= sentence.length - 2) return clip(sentence);
  const colon = sentence.indexOf(':');
  const lead = colon >= 0 && colon < index ? sentence.slice(0, colon + 1).trim() : '';
  return clip(lead ? `${lead} … ${item}` : item);
}

export function reviewTermsText(url: string, text: string): TermsPageReview {
  const clauses: TermsClause[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(text)) {
    if (sentence.length > 3000) continue; // navigation / footer blobs are not clauses
    const a = AUTOMATION_TERM.exec(sentence);
    if (a && PROHIBITION.test(sentence)) {
      const t = excerptAround(sentence, a.index);
      if (!seen.has(t)) {
        seen.add(t);
        clauses.push({ kind: 'automation', text: t });
      }
      continue;
    }
    const c = COPY_TERM.exec(sentence);
    if (c && NEEDS_PERMISSION.test(sentence)) {
      const t = excerptAround(sentence, c.index);
      if (!seen.has(t)) {
        seen.add(t);
        clauses.push({ kind: 'copying', text: t });
      }
    }
  }
  const level = clauses.some((c) => c.kind === 'automation') ? 'prohibits_automation' : clauses.length ? 'restricts_copying' : 'none_found';
  return { url, level, clauses: clauses.slice(0, 6) };
}

/** Combines the reviews of the terms pages that could be read. No readable terms page → `not_found` (unknown, never "allowed"). */
export function combineTermsReviews(pages: TermsPageReview[], checkedAt: string, permissionRecorded: boolean): TermsReview {
  const level: TermsLevel = !pages.length
    ? 'not_found'
    : pages.some((p) => p.level === 'prohibits_automation')
      ? 'prohibits_automation'
      : pages.some((p) => p.level === 'restricts_copying')
        ? 'restricts_copying'
        : 'none_found';
  return { level, checkedAt, pages, permissionRecorded };
}

/** The clause to quote to the customer: the first automation clause, else the first copying clause. */
export function leadingClause(review: Pick<TermsReview, 'pages'>): { url: string; text: string; kind: TermsClause['kind'] } | null {
  for (const kind of ['automation', 'copying'] as const) {
    for (const p of review.pages) {
      const c = p.clauses.find((x) => x.kind === kind);
      if (c) return { url: p.url, text: c.text, kind };
    }
  }
  return null;
}
