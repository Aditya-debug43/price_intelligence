<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-28. -->

Shelfwatch: Remove the Minimum of 3 Competitor URLs
I want to make a small improvement to the Websites page in Shelfwatch.
Current problem
Currently, the application requires users to enter at least 3 competitor website URLs. If a user enters only 1 or 2 competitor URLs, the application does not work properly or prevents them from proceeding.
I want to remove this restriction.
Required behaviour

1. Allow users to start with just 1 competitor URL. One competitor should be sufficient to save the configuration and use the application.
2. Make adding competitors optional. Users can start with one URL and use the existing Add URL option whenever they want to add more competitors.
3. Do not enforce an arbitrary fixed number of competitors. Remove the minimum-of-3 requirement wherever it exists in the frontend, backend, API validation, database constraints, or business logic.
4. Preserve the existing Add URL functionality. Users should still be able to add multiple competitor URLs, remove them, and edit them as they do currently.
5. Make the rest of the application work with any supported number of competitors, starting from one. Website collection, product matching, price comparison, reports, and related features should not assume that three competitors always exist.
6. Handle missing competitor data gracefully. If only one competitor is configured or has collected data, the application should display the available results correctly rather than showing an error or requiring more competitors.
7. Keep validation sensible. Each entered URL should still be validated properly. Do not remove URL validation or other useful safeguards; only remove the unnecessary minimum-count restriction.

Investigation and implementation
Inspect the actual codebase to identify where the requirement for three competitor URLs is enforced. Determine whether the restriction exists in multiple places and fix it consistently across the application.
Do not merely change the frontend validation while leaving the backend or another part of the application requiring three URLs.
Make the necessary changes using your judgement, without rewriting unrelated functionality or changing the existing user interface unnecessarily.
Testing
Test the following cases:

* Adding and saving exactly 1 competitor URL.
* Adding and saving 2 competitor URLs.
* Adding and saving 3 or more competitor URLs.
* Adding and removing URLs using the existing controls.
* Collecting data and generating comparisons with only 1 competitor.
* Handling a competitor that has no collected data yet.
* Confirming that existing workspaces with multiple competitors continue to work correctly.

Run the relevant automated tests, type checks, linting, and production build. Add regression tests to ensure the minimum-of-3 restriction does not return.
Because Shelfwatch is already live, preserve existing production data and follow the current deployment workflow. Commit and push the changes if appropriate, and confirm whether Vercel and the backend need updating.
Final objective
Users should be able to start using Shelfwatch with just one competitor URL and add more competitors whenever they want through the existing Add URL option. There should be no unnecessary fixed requirement to enter at least three competitor URLs.
When finished, tell me the root cause, what you changed, which tests passed, and whether the fix is live on the deployed website.
