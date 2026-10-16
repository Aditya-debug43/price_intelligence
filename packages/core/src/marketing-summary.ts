/**
 * Explainable summaries of OBSERVED marketing activity. Every statement is derived from counts of recorded items and says how many items
 * it rests on. Nothing here says anything about paid campaigns: observed content is not proof of spend. When there is too little evidence
 * for a pattern, the summary says so instead of guessing.
 */

import type { CompetitorMarketingSummary, EngagedItem, MarketingSummary } from '@ci/shared';

export interface SummaryItem {
  siteId: string;
  siteName: string;
  platform: string;
  kind: string;
  title: string | null;
  excerpt: string | null;
  url: string | null;
  classification: string;
  publishedAt: string | null;
  firstSeenAt: string;
  engagement?: { views: number | null; likes: number | null; comments: number | null; shares: number | null; observedAt: string } | null;
}

export interface SummaryAccount {
  siteId: string;
  platform: string;
  handle: string;
  confirmed: boolean;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
}

export type { CompetitorMarketingSummary, EngagedItem, MarketingSummary } from '@ci/shared';

export const MIN_THEME_ITEMS = 2;
export const MIN_TIMING_ITEMS = 5;

const STOP = new Set(
  (
    'about above after again also always among another because been before being below between both bring come could does doing done down during each else even ever every from get give goes going good great have having here into just keep know last like look made make many more most much must need never next only other over same shall should since some such take than that their them then there these they thing this those through under until upon very want were what when where which while will with within without would your you yours our ours us we the and for are but not all any can had has her him his how its may now off one out own she too use was who why yes' +
    ' para con los las del una uno por que como más pero este esta esto estos estas sus nuestro nuestra hoy aqui aquí ya muy sin sobre todo toda todos todas' +
    ' een het van voor met dat dit zijn niet maar ook nog wij ons onze bij naar uit als dan er om te op in is de en ' +
    ' http https www com'
  ).split(/\s+/),
);

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function weekdayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(new Date(iso));
}

function tokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}][\p{L}'’-]{3,}/gu) ?? []).map((t) => t.replace(/['’]s$/, '')).filter((t) => t.length >= 4 && !STOP.has(t)))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function summariseMarketing(
  items: SummaryItem[],
  ctx: { now: Date; windowDays: number; timeZone: string; brands: string[]; accounts: SummaryAccount[]; competitors: { id: string; name: string }[] },
): MarketingSummary {
  const since = ctx.now.getTime() - ctx.windowDays * 86_400_000;
  const inWindow = items.filter((i) => new Date(i.publishedAt ?? i.firstSeenAt).getTime() >= since);
  const brands = [...new Set(ctx.brands.map((b) => b.trim()).filter((b) => b.length >= 3))];
  const out: CompetitorMarketingSummary[] = [];

  for (const comp of ctx.competitors) {
    const mine = inWindow.filter((i) => i.siteId === comp.id);
    const byPlatform: Record<string, number> = {};
    const byClassification: Record<string, number> = {};
    for (const i of mine) {
      byPlatform[i.platform] = (byPlatform[i.platform] ?? 0) + 1;
      byClassification[i.classification] = (byClassification[i.classification] ?? 0) + 1;
    }
    const promos = mine.filter((i) => i.classification === 'promotion');

    // recurring themes: terms present in several different items (not one item repeating itself)
    const termItems = new Map<string, SummaryItem[]>();
    for (const i of mine) for (const t of tokens(`${i.title ?? ''} ${i.excerpt ?? ''}`)) termItems.set(t, [...(termItems.get(t) ?? []), i]);
    const themes = [...termItems.entries()]
      .filter(([, list]) => list.length >= MIN_THEME_ITEMS)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([term, list]) => ({ term, items: list.length, examples: list.slice(0, 2).map((i) => ({ title: (i.title ?? i.excerpt ?? '').slice(0, 100), url: i.url })) }));

    // brands from the catalogue mentioned in promotional items
    const brandMentions = brands
      .map((b) => ({ brand: b, items: promos.filter((i) => new RegExp(`(^|[^\\p{L}])${escapeRe(b)}([^\\p{L}]|$)`, 'iu').test(`${i.title ?? ''} ${i.excerpt ?? ''}`)).length }))
      .filter((b) => b.items > 0)
      .sort((a, b) => b.items - a.items || a.brand.localeCompare(b.brand))
      .slice(0, 5);

    // promotional timing: only with enough items whose publish time is known
    const dated = promos.filter((i) => i.publishedAt);
    let timing: CompetitorMarketingSummary['timing'] = null;
    let timingNote: string | null = null;
    if (dated.length >= MIN_TIMING_ITEMS) {
      const counts = new Map<string, number>(WEEKDAYS.map((d) => [d, 0]));
      for (const i of dated) counts.set(weekdayIn(i.publishedAt!, ctx.timeZone), (counts.get(weekdayIn(i.publishedAt!, ctx.timeZone)) ?? 0) + 1);
      const byWeekday = WEEKDAYS.map((day) => ({ day, items: counts.get(day) ?? 0 }));
      const busiest = [...byWeekday].sort((a, b) => b.items - a.items)[0]!;
      const tied = byWeekday.filter((d) => d.items === busiest.items).length > 1;
      timing = {
        basis: 'published',
        items: dated.length,
        byWeekday,
        busiest,
        sentence: tied ? `Promotional posts are spread across several days (${dated.length} dated promotions); no single day stands out.` : `${busiest.items} of ${dated.length} dated promotional posts were published on a ${busiest.day} (${ctx.timeZone} time).`,
      };
    } else if (promos.length > 0) {
      timingNote = `Not enough dated promotions to describe timing: ${dated.length} of the ${MIN_TIMING_ITEMS} needed have a known publish time.`;
    }

    const top = (metric: 'likes' | 'views'): EngagedItem[] =>
      mine
        .filter((i) => i.engagement && i.engagement[metric] !== null)
        .map((i) => ({ title: (i.title ?? i.excerpt ?? 'Untitled').slice(0, 100), url: i.url, platform: i.platform, value: i.engagement![metric] as number, observedAt: i.engagement!.observedAt }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 3);
    const mostLiked = top('likes');
    const mostViewed = top('views');

    const limitations: string[] = [];
    const accts = ctx.accounts.filter((a) => a.siteId === comp.id);
    const confirmed = accts.filter((a) => a.confirmed);
    if (!confirmed.length) limitations.push('No social account is confirmed for this website, so only content from its own pages is included.');
    for (const a of confirmed) {
      if (!a.lastSyncStatus) limitations.push(`${a.platform} (${a.handle}) has not been read yet.`);
      else if (a.lastSyncStatus !== 'ready') limitations.push(`${a.platform} (${a.handle}): ${a.lastSyncMessage ?? a.lastSyncStatus}`);
    }
    if (mine.some((i) => i.platform !== 'site' && !i.engagement)) limitations.push('Some posts have no engagement counts: the platform does not provide them for this account, or the provider did not return them.');
    limitations.push('Only public, observed content is included. We cannot see private campaigns, boosted-post spend or every advertisement on a platform.');

    out.push({ siteId: comp.id, siteName: comp.name, total: mine.length, byPlatform, byClassification, promotionCount: promos.length, themes, brandMentions, timing, timingNote, mostLiked, mostViewed, limitations });
  }

  const active = out.filter((c) => c.total > 0);
  const headline = !ctx.competitors.length
    ? 'No competitors are set up, so there is no marketing activity to summarise.'
    : !active.length
      ? `No marketing activity was observed for any competitor in the last ${ctx.windowDays} days. That can mean nothing was published, or that nothing could be read — see the limitations for each competitor.`
      : `${active.length} of ${out.length} competitor${out.length === 1 ? '' : 's'} had observed marketing activity in the last ${ctx.windowDays} days: ${active.map((c) => `${c.siteName} (${c.total}, of which ${c.promotionCount} promotional)`).join('; ')}.`;

  return { windowDays: ctx.windowDays, headline, competitors: out, note: 'Observed public content only. This is not evidence of paid advertising, and patterns are described only when enough items support them.' };
}
