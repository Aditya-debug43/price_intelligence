/**
 * What to do about each limitation the site profiler can report — in plain language, and never "get around it": a website that says no, or
 * protects itself, is respected, and the alternative offered is always an authorised one (a feed, an API, written permission).
 *
 * null means there is nothing for the customer to do (the limitation is information). A test guarantees that every code the profiler can
 * emit appears here, so a new limitation cannot ship without advice (or an explicit "nothing to do").
 */
export const LIMITATION_ADVICE: Record<string, string | null> = {
  invalid_url: 'Check the address. It should look like https://www.example.com.',
  unsafe_address: 'Use the public web address of the website. Addresses on private or internal networks are never accessed.',
  unreachable: 'Check the address for typos, then try again later. If the site is simply down, data collected earlier stays and is shown with its age.',
  robots_unavailable: 'Try again later. Nothing is collected until the site’s published rules can be read.',
  robots_disallow: 'Ask the website’s owner for a product feed or an authorised connection, or replace this competitor. Collection never goes against a site’s robots rules.',
  bot_protection: 'Ask the owner for a product feed or written permission and API access. We never try to get around bot protection.',
  access_denied: 'Ask the owner for a product feed or written permission and API access. A site that refuses automated visitors is left alone.',
  rate_limited: 'Try again later. Collection slows down on its own — do not start repeated runs.',
  http_error: 'Try again later. If it keeps happening, the site may be down or turning automated visitors away.',
  login_required: 'Prices behind a login cannot be collected: we never log in to another business’s site. Ask the owner for a public feed or an authorised data export.',
  sample_failed: 'Usually temporary — run the check again.',
  currency_conflict: 'Edit the website and choose its currency before relying on price comparisons.',
  currency_unknown: 'Edit the website and choose its currency; prices cannot be converted for comparison until then.',
  terms_prohibit_automation: 'Ask the website’s owner for written permission or a product feed. If you have it, record it under Websites → this website → Confirm collection rules. Until then nothing is collected from this website, and the terms are never worked around.',
  terms_restrict_copying: 'Read the quoted clause and the full terms before you confirm the collection rules, and collect only if your use is allowed — or ask the owner for permission or a feed.',
  freshop_storefront: 'Collecting it needs browser rendering switched on by the server administrator — and the store’s permission — or a product feed arranged with the store or its vendor.',
  js_required: 'Ask the server administrator to enable browser rendering (and make sure you have the site’s permission), or ask the owner for a product feed.',
  no_gtin: 'Expect more pairs to need your decision on the Match review page.',
  no_brand: 'Expect more pairs to need your decision on the Match review page.',
  no_stock_quantity: 'For your own shop, connect Shopify under Settings → Integrations to see exact counts. Competitors’ quantities are never shown.',
  // information only
  terms_permission_recorded: null,
  terms_own_site: null,
  terms_not_found: null,
  crawl_delay: null,
  no_sitemap: null,
  rolling_refresh: null,
  weak_structured_data: null,
  few_samples: null,
  flyers_found: null,
};

/** The advice for a limitation code, or null when there is nothing to do (or the code is unknown). */
export function adviceForLimitation(code: string): string | null {
  return LIMITATION_ADVICE[code] ?? null;
}
