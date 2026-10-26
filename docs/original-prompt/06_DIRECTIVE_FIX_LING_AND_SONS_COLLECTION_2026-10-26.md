<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-26. The three screenshots that came with it (the Ling & Sons capability report, and its collection history before and after expanding "Details") are described, not reproduced: they show status "Limited", "about 19 products — Sum of 1 product sitemap(s)", three sample pages "not a product page, or unreadable", and two failed discovery runs with 0 requests, 0 pages, "No reliable collection method is available for this website yet". -->

I have tested the Shelfwatch application, and product collection is working successfully for my own website and two other competitor websites. However, one competitor website, Ling & Sons (`https://www.lingandsons.com/`), is consistently failing during collection.
I have attached screenshots showing the website capability report, collection history, failed discovery attempts, and the information Shelfwatch currently detects about this website.

Your task
Investigate this issue thoroughly and fix it so that Shelfwatch can reliably collect product data from this website, to the extent that collection is permitted and technically possible.
Do not make assumptions about the cause based only on the screenshots. Investigate the actual codebase, the website capability detection process, the collection pipeline, the relevant logs, and the website's publicly available structure. Determine the real root cause before making changes.
I do not want a superficial fix that merely hides the error, changes the status to successful, or makes the interface appear as though products were collected. The objective is to make the actual collection process work correctly and save genuine product data.

Requirements

1. Investigate the root cause. Understand why discovery fails, why zero requests and zero pages are recorded in the latest attempt, and why Shelfwatch reports that no reliable collection method is available. Determine whether the problem is in discovery, capability detection, product-page identification, data extraction, or another part of the application.
2. Understand the website properly. Examine the available public website structure and the information already detected by Shelfwatch. Determine whether the website exposes a usable product catalogue and whether a reliable, permitted collection method is available.
3. Fix the underlying implementation. Make the necessary changes based on your findings. Ensure the solution fits the existing architecture and does not introduce unnecessary changes to unrelated websites or collection methods.
4. Preserve existing functionality. The current collection process is already working for my own website and two other competitors. Do not break their collection, product records, price comparisons, product matching, reports, or other existing features while fixing Ling & Sons.
5. Keep the results genuine. Do not use fabricated products, sample data, hardcoded catalogue entries, or simulated success. If a product cannot actually be collected, it must not be saved as though it were real.
6. Handle limitations honestly. If you discover that the website restricts automated access or commercial use, or that permission is required, respect those restrictions. Do not bypass access controls, ignore the website's terms, or misrepresent an unsupported collection method as successful. In that situation, identify the legitimate options and explain what permission or access is needed.
7. Verify the fix thoroughly. Run the relevant automated tests and perform an actual end-to-end collection test wherever permitted. Confirm that the collected products are genuinely saved, that product information is usable by the rest of Shelfwatch, and that failures are reported accurately. Also verify that the existing working websites still collect successfully.
8. Improve error reporting if necessary. If collection remains impossible for a legitimate reason, ensure Shelfwatch provides a precise and actionable explanation rather than a misleading or generic failure message.

Completion criteria
Do not consider the task complete merely because the code has been changed or tests pass. Establish what is actually possible for this website, test the implementation against real evidence, and distinguish verified results from anything that remains untested or blocked.
When finished, provide a concise but detailed report covering:

* The confirmed root cause.
* The changes made and why they address the problem.
* The actual collection results, including the number of products successfully saved, if collection was permitted and successful.
* The tests and end-to-end checks performed, including whether the other working websites remain unaffected.
* Any remaining limitations, permissions, or actions required from me.

Please investigate and resolve this issue independently. Use your judgement to determine the appropriate technical solution rather than following a predetermined implementation approach.
