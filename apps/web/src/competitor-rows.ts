/** One line of the competitor list on the Setup page. */
export interface CompetitorRow {
  id?: string;
  url: string;
  name: string;
  original?: string;
  error?: string;
}

/**
 * The lines the competitor list starts with: the competitors the workspace already has, or a single empty line when it has none, so the
 * first one can be typed straight away. The list is never padded to a fixed number: one competitor is enough, and "Add competitor" adds
 * another line whenever the customer wants one (up to the limit the server reports).
 */
export function initialCompetitorRows(existing: { id: string; url: string; name: string }[]): CompetitorRow[] {
  const rows: CompetitorRow[] = existing.map((s) => ({ id: s.id, url: s.url, name: s.name, original: s.url }));
  return rows.length ? rows : [{ url: '', name: '' }];
}

export const competitorsTitle = (max: number) => `Competitors (up to ${max})`;

/** What to say under the list. Only the first competitor is ever asked for. */
export function competitorsHint(filled: number): string | null {
  return filled === 0 ? 'Add the website of at least one competitor to compare against. You can add more later with “Add competitor”.' : null;
}
