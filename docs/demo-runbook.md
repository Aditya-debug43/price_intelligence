# Demo runbook

Two demonstrations are possible. **Part A needs nothing but this repository** and uses fictional fixture websites that run on
your own machine. **Part B** uses real websites and must not be started until each website's owner has given permission
(see [consent-and-compliance.md](consent-and-compliance.md)).

Everything shown in Part A is labelled **Fixture** in the app. None of it is real market data.

---

## Part A — Fixture demonstration (offline)

### Start

Three terminals, from the repository root:

```bash
npm run dev:db          # 1. embedded PostgreSQL (keep running)
npm run demo:fixtures   # 2. builds the demo workspace, then keeps the fixture websites running
npm run dev:demo        # 3. worker + API + web, with the local fixture sites reachable and the developer scheduler on
```

`dev:demo` is `npm run dev` plus `ALLOW_LOCAL_FIXTURES=true` and `SCHEDULER_MODE=dev` for those processes only; never use it with real data.
`demo:fixtures` prints "Demo workspace ready" when it finishes (a few minutes: it profiles and collects six websites twice,
building two days of history). Then open <http://localhost:5173> and sign in as `owner@localhost.test`; the password is in
`.data/dev-credentials.json`.

Select the workspace **Fixture Demo — Groceries To Go (not live data)**.

### What the six fixture websites stand for

| Fixture | Behaves like | What the app should show |
| --- | --- | --- |
| Source shop (port 4101) | Your own Shopify shop, prices in AWG | Capability **Full**, public products feed |
| Woo competitor (4102) | WooCommerce with the public Store API, USD | **Full**, converted to the reporting currency with the rate shown |
| JSON-LD competitor (4103) | Plain pages with structured data, a sitemap and a weekly PDF flyer | **Full** or **Partial**, flyer offers marked with their validity dates |
| HTML competitor (4104) | Plain HTML with no structured data | **Partial** — heuristic extraction with lower confidence, says why |
| Blocked competitor (4105) | robots.txt disallows everything | **Blocked** — no product page is requested; shown as "unavailable", not "empty" |
| Failing competitor (4107) | Server returns HTTP 500 | **Failed** — a technical error, not an empty catalogue |

(Further fixtures — bot challenge, JavaScript-only, login-required, flaky feed — exist for the tests and can be added by hand;
see `npm run fixtures:serve`.)

### A ten-minute tour

1. **Dashboard.** Read the bar across the top first: how many websites are complete, how many are unavailable, the age of the
   oldest and newest data. Then the latest report headline, the standing bar (cheaper / equal / pricier), the top insights and
   the next scheduled report with *why* it starts when it does.
2. **Websites → each site.** Open the *Blocked* and *Failed* sites: the capability report explains what was checked and what is
   missing. Open the *HTML* site: see which fields were read by which method and how confident that is.
3. **Price comparison.** One row per product you sell. Each tag shows the price *as the website displays it*, then the converted
   difference. Open "Why this match?" under a tag. Different pack sizes are compared per unit, not as identical.
4. **Match review.** Pairs that are similar but unproven wait here. Accept one and re-open price comparison — it now counts.
   Reject one and re-run matching: your decision survives.
5. **Offers & flyers.** Discounts with a "was" price are *verified* only if price history agrees; others read "unverified". Flyer
   rows link to the PDF and carry the dates printed on it.
6. **My stock.** Public mode: availability only, with a note that no quantity exists. The demo also has a *simulated* inventory
   connection (labelled as such) with real-looking quantities, so low-stock behaviour is visible. Competitors never appear here.
7. **Product detail.** Pick any product: price history chart, the pages each value came from, the extraction method, and a link
   to the stored page snapshot (while within the 90-day window).
8. **Reports.** Two saved days. Open one, switch tabs, export PDF / Excel / CSV — the numbers are the same as on screen. Use
   *Compare two reports* to see price changes, offers that ended and insights that appeared.
9. **Data quality.** Per-website coverage, freshness, extraction methods, barcode availability and recent problems.
10. **Settings → Developer tools.** The local email outbox (verification, alerts and the daily summary land here), and the
    scheduler: pick a time such as 08:45 Aruba time under "Pretend it is…" and run a pass to watch a report being prepared in
    time (this tab needs `SCHEDULER_MODE=dev`, which `npm run dev:demo` sets).

### Changing the world while the demo runs

The fixture sites listen to a control endpoint:

```bash
curl -X POST localhost:4100/mutate -d '{"site":"woo","item":0,"price":0.99}'            # a competitor cuts a price
curl -X POST localhost:4100/mutate -d '{"site":"jsonld","item":3,"remove":true}'         # a product disappears
curl localhost:4100/state
```

To make one of *your own* products sell out, set its quantity to 0 in **My stock → Simulator** (the simulated inventory and the public page
then agree; if only one of them changes, the app flags “page and inventory disagree”).

Then open that site under **Websites** and press **Collect catalogue** again (a repeat collection is a refresh). Afterwards look at Alerts (your sell-out raises exactly one alert, and
running the refresh again does not raise a second), the product's price history, and generate a new report.

### Stop

Press Ctrl+C in each terminal. Data stays in `.data/` and is reused next time; delete `.data/` to start from nothing.

---

## Part B — Live demonstration on real websites

The intended workspace is **Groceries To Go Aruba** (the source) with the candidate competitors Ling & Sons, Super Food Aruba
and Do-It Aruba. A fourth competitor can be added once the owner names one — **do not guess a URL** (Cmart's address has not
been supplied).

```bash
npm run demo:setup                   # creates the workspace and website entries; consent stays PENDING
npm run demo:setup -- --profile      # additionally runs the light capability check
```

Nothing is collected until a person with authority records permission:

1. Open **Websites → (site)**, and under *Permission to collect* press **Record permission…**. For your own shop, confirm that you operate it. For each competitor,
   confirm that collecting its public pages for price comparison is permitted. The app stores who confirmed, when, and the
   version of the wording shown.
2. Press **Check this website now** (profiling; later **Re-check capabilities**). This reads robots.txt, the home page, sitemap files and at most three
   sample product pages. It does **not** collect the catalogue.
3. Only if the capability report says *Full* or *Partial*, press **Collect catalogue** (or **Small live refresh (25)** for a quick first run of 25 products).
4. Match, review, generate a report.

**Safety limits that stay on in a live demonstration:** robots.txt is obeyed; the site's `Crawl-delay` (or the default of 1.5 s)
is respected; collection stops after repeated access denial; no CAPTCHA, login or bot-protection is ever bypassed; no proxies;
no competitor accounts; no carts.

### What the capability probe found on 2026-10-14

A read-only probe (robots.txt, home page, sitemap index files, ≤3 sample pages per site; **no catalogue collection**) reported:

| Website | Platform | Currency | Result |
| --- | --- | --- | --- |
| groceriestogoaruba.com | Shopify | USD | **Full** — public `products.json`, ≈2,382 products |
| shop.lingandsons.com | Shopify | AWG | **Full** — public `products.json`, ≈1,851 products |
| shop.superfoodaruba.com | Freshop storefront on WordPress | not detected | **Limited** — no public product feed; robots asks for a 10 s crawl delay |
| doit.aw | Next.js application | not detected | **Limited** — content needs JavaScript rendering (a headless browser is needed; verified on local pages only, never on this site) |

These are capability findings, not price data. `npm run live:probe` writes the exact output of a run to
`docs/live-probe-<date>-<time>.json` (one file per run; earlier versions of this script overwrote a same-day file). The saved `docs/live-probe-2026-10-14.json` therefore holds only the last
run (shop.superfoodaruba.com and doit.aw); the two Shopify results above come from an earlier run on the same day whose file was
overwritten, so they are not independently recorded. Re-running the probe would refresh the record but sends new requests to those
websites, so it has not been repeated without your go-ahead.

### What is *not* demonstrated live

Anything needing credentials or approvals nobody has granted: Shopify inventory (no app credentials), Instagram/Facebook
(Meta App Review), YouTube (API key), real email delivery (SMTP), AI summaries (API key). The app shows exactly what is missing
for each — see [limitations.md](limitations.md).
