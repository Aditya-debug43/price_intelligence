<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-26. The screenshot that came with it shows the "Remove website and its data" confirmation dialog on a Ling & Sons website page of the user's own workspace, and the browser console with two "DELETE …/api/v1/orgs/<org>/sites/<id> 400 (Bad Request)" errors and three "Failed to load resource … 400" lines. -->

I have encountered another bug in Shelfwatch. When I try to remove a website using the “Remove website and its data” confirmation dialog, the operation fails with a 400 Bad Request error.
I have attached a screenshot showing the problem and the browser console errors.
Your task
Investigate the issue thoroughly and fix the actual root cause. Examine the frontend removal flow, the DELETE API request, backend route and validation logic, database relationships, and the error response returned by the server.
Do not assume what is causing the problem based only on the screenshot. Trace the complete request from the moment I confirm removal until the backend processes it, identify exactly why it returns 400, and implement the appropriate fix.
Requirements

* Make the website-removal functionality work correctly from the UI through to the database.
* Ensure the correct website and its associated data are handled according to the application's intended deletion rules.
* Check whether the problem is caused by request parameters, validation, permissions, database constraints, or any other underlying issue.
* Ensure that the confirmation dialog behaves correctly, loading states are handled properly, and useful error messages are displayed if removal genuinely fails.
* Prevent accidental deletion of unrelated websites, workspaces, or records.
* Preserve all existing functionality, especially product collection, price comparisons, product matching, reports, and other website-management operations.
* Add regression tests covering successful removal, invalid requests, authorization, and relevant database relationships.
* Test the complete removal flow using a temporary test workspace and website. Do not delete any of my actual websites or production data during testing.
* Run the relevant tests, type checks, linting, and build. Verify the fix using the actual application rather than relying only on unit tests.

Completion report
When finished, tell me the exact root cause, what you changed, which tests passed, and whether you verified successful website removal in the browser. Mention any remaining issues clearly.
Please investigate and fix the underlying bug rather than hiding the error or merely changing the frontend message.
