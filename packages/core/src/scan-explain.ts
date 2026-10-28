export interface ScanRunFacts {
  status: string;
  kind: string;
  isComplete: boolean;
  errorCode: string | null;
  error: string | null;
  productsSaved: number;
  estimatedTotal: number | null;
  requestsMade: number;
  requestBudget: number | null;
  urlsDiscovered: number;
  urlsFetched: number;
  errorsCount: number;
  /** When Shelfwatch will continue a collection that paused for a temporary reason (null: it will not by itself). */
  nextAttemptAt?: Date | string | null;
  /** Sittings in a row that saved nothing new. */
  continuations?: number;
}

export interface ScanExplanation {
  /** One sentence: what this run achieved. */
  summary: string;
  completeness: 'complete' | 'partial' | 'none';
  /** Why the catalogue is not complete, or null when it is. */
  reason: string | null;
  /** What the customer (or the next run) can do about it, or null. */
  nextStep: string | null;
  /**
   * What the collected number covers: the products the website itself publishes (its feed and sitemaps). A store's admin total can be higher —
   * drafts, archived products and products not sold on the website are not public, so no public collection method can see them. Null when
   * nothing was collected.
   */
  scopeNote: string | null;
  /** ISO time at which the paused collection continues by itself, when it will. */
  resumeAt?: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Plain-language account of a collection run: what was collected, whether that is the whole catalogue, and — when it is not — the real
 * reason and the next step. It never claims completeness the run did not establish.
 */
export function explainScanRun(r: ScanRunFacts, queue: Record<string, number> = {}): ScanExplanation {
  const resumeAt = r.status === 'partial' && r.nextAttemptAt ? new Date(r.nextAttemptAt).toISOString() : null;
  return { ...explainCore(r, queue), scopeNote: scopeNoteOf(r), ...(resumeAt ? { resumeAt } : {}) };
}

/** What a collected number covers — said every time, so a store admin's larger total is never a mystery. */
function scopeNoteOf(r: ScanRunFacts): string | null {
  if (r.productsSaved === 0 || !['succeeded', 'partial'].includes(r.status)) return null;
  const listed = r.estimatedTotal && r.estimatedTotal > 0 ? ` of the ${r.estimatedTotal.toLocaleString('en-US')} the website lists publicly (its product feed and sitemaps)` : ' that the website lists publicly';
  return `${plural(r.productsSaved, 'product')} collected${listed}. A store’s own admin total can be higher: drafts, archived products and products that are not sold on the website are not public, so no public collection method can see them.`;
}

function explainCore(r: ScanRunFacts, queue: Record<string, number>): Omit<ScanExplanation, 'scopeNote'> {
  const saved = plural(r.productsSaved, 'product');
  const of = r.estimatedTotal ? ` of about ${r.estimatedTotal}` : '';
  const failed = queue['failed'] ?? 0;
  const pending = queue['pending'] ?? 0;
  const skipped = queue['skipped'] ?? 0;

  if (r.status === 'queued') return { summary: 'Waiting to start.', completeness: 'none', reason: null, nextStep: null };
  if (r.status === 'running') return { summary: `Running now: ${saved}${of} collected so far${pending ? `, ${pending} pages still to read` : ''}.`, completeness: 'none', reason: null, nextStep: null };

  if (r.status === 'blocked') {
    const robots = r.errorCode === 'robots';
    return {
      summary: 'Nothing was collected: the website does not allow automated access.',
      completeness: 'none',
      reason: robots ? 'Its robots.txt file asks automated tools to stay away.' : 'It refused access (a login, bot protection, or an explicit denial). Shelfwatch stops when told no and never works around it.',
      nextStep: 'Ask the website’s owner for a product feed or an authorised connection, or remove this competitor.',
    };
  }
  if (r.status === 'cancelled') {
    return { summary: `Cancelled after collecting ${saved}.`, completeness: r.productsSaved ? 'partial' : 'none', reason: 'The run was cancelled (for example because collection from the website was stopped).', nextStep: 'Start a new collection when you are ready.' };
  }
  if (r.status === 'failed') {
    const byCode: Record<string, [string, string]> = {
      site_unreachable: ['The website could not be reached.', 'This is usually temporary. Try again later.'],
      unsupported_site: ['No supported way of reading this website’s products was found.', 'Ask the owner for a product feed or an authorised platform connection.'],
      catalogue_elsewhere: [r.error ?? 'This address does not list products itself; its online store is on another address.', 'Add the online store it links to as a website, then collect that one. You can remove this address afterwards — it has nothing to collect.'],
      not_a_shop: ['None of the pages sampled from this address is a product page, so there is nothing to collect here.', 'Check that this is the address of the online shop. If the shop has its own address, replace this one with it.'],
      empty_feed: ['The website’s product feed answered but listed no products.', 'Check that the shop has products published, or try again later.'],
      no_products_extracted: ['Pages were fetched but no product data could be read from them.', 'The pages may need JavaScript rendering, or the layout is not supported yet.'],
      all_pages_failed: ['None of the product pages could be read.', 'Check the details below for the errors, then try again.'],
      feed_unavailable: ['The product feed was unavailable.', 'Try again later.'],
      products_skipped: ['The database refused the data of every product this run tried to save, so none were saved (the notes say which products and why).', 'This is about the data the website publishes, not about access. Fix the products named in the notes at the source, or ask the developer, then collect again.'],
      database_error: [r.error ?? 'The database could not save the collected data.', 'Try again. If it keeps failing, the reason is in the notes and the server log.'],
      worker_lost: ['The collection stopped responding several times in a row and was abandoned. Everything collected before that is kept.', 'Try again. If it keeps happening, the website may be too large or too slow to read in one run.'],
    };
    const [reason, next] = byCode[r.errorCode ?? ''] ?? [r.error ?? 'The collection failed.', 'Try again; if it keeps failing, see the errors below.'];
    // An address that lists no products is neither a technical failure nor an empty shop: nothing was requested, and nothing is missing from here.
    if (r.errorCode === 'catalogue_elsewhere' || r.errorCode === 'not_a_shop') return { summary: 'Nothing was collected: this address does not list products. That is not a technical failure and not an empty shop.', completeness: 'none', reason, nextStep: next };
    return { summary: `Failed: ${r.productsSaved ? `${saved} saved before the failure` : 'no products were saved'}. This is a failure, not an empty catalogue.`, completeness: r.productsSaved ? 'partial' : 'none', reason, nextStep: next };
  }

  // succeeded or partial
  if (r.isComplete) {
    return {
      summary: `The whole accessible catalogue was collected: ${saved}.${failed ? ` ${plural(failed, 'page')} could not be read and ${failed === 1 ? 'is' : 'are'} listed below.` : ''}`,
      completeness: 'complete',
      reason: null,
      nextStep: null,
    };
  }
  let reason: string;
  let next: string | null = 'Run the collection again to continue where it stopped.';
  // A temporary stop at the website: say what it said, that nothing was lost, and whether Shelfwatch will continue by itself.
  const temporary = ['rate_limited', 'temporarily_unavailable', 'timeout', 'network', 'invalid_response'].includes(r.errorCode ?? '') || (r.errorCode === 'http_error' && /HTTP (429|5\d\d)\b/.test(r.error ?? ''));
  if (temporary && r.kind !== 'sample') {
    const will = !!r.nextAttemptAt;
    return {
      summary: `${will ? 'Paused' : 'Partly collected'}: ${saved}${of} saved${will ? '. The collection continues by itself' : ''}.`,
      completeness: 'partial',
      reason: `${r.error ?? 'The website was temporarily unavailable'}. That is a temporary limit of the website, not a refusal; what was read is saved and nothing was read twice.`,
      nextStep: will
        ? 'Nothing to do: Shelfwatch waits, then continues from where it stopped. You can also click Collect catalogue to continue now.'
        : `Shelfwatch tried again several times and has stopped trying by itself. Click Collect catalogue to continue from where it stopped, or try again later.`,
    };
  }
  switch (r.errorCode) {
    case 'request_budget':
      reason = `The request budget for one run${r.requestBudget ? ` (${r.requestBudget} requests)` : ''} was used up. The rest is collected on the next run.`;
      break;
    case 'deadline':
      reason = 'The run stopped at its time limit so the daily report could be ready on time.';
      break;
    case 'page_limit':
      reason = 'The run stopped at its page limit.';
      break;
    case 'products_skipped':
      reason = 'The database refused the data of a few products, which were skipped; everything else was saved. The notes say which products and why.';
      next = 'Fix those products at the source if their data is wrong, then collect again.';
      break;
    case 'feed_shorter_than_catalogue':
      reason = 'The product feed ended before the website’s own product sitemaps did, and the products it did not return could not all be read from their own pages (the notes say how many and which).';
      next = 'Collect again later. If the same products are missed again, the website may be keeping them out of its feed or refusing their pages: ask its owner.';
      break;
    default:
      if (r.kind === 'sample') {
        reason = 'This was a small sample on purpose, not a full collection.';
        next = 'Start a full collection to gather the whole catalogue.';
      } else if (failed > 0 && r.urlsDiscovered > 0 && failed / Math.max(1, r.urlsFetched) > 0.05) {
        reason = `${plural(failed, 'page')} could not be read (${Math.round((failed / Math.max(1, r.urlsFetched)) * 100)}% of those fetched).`;
      } else if (pending > 0) {
        reason = `${plural(pending, 'page')} still waiting to be read.`;
      } else {
        reason = r.error ?? 'Coverage could not be confirmed as complete.';
      }
  }
  return {
    summary: `Partly collected: ${saved}${of}.${skipped ? ` ${plural(skipped, 'page')} skipped (not product pages).` : ''}`,
    completeness: 'partial',
    reason,
    nextStep: next,
  };
}
