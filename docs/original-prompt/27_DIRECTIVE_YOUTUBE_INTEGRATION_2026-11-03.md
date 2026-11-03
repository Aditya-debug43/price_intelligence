# Directive 27 — verbatim (2026-11-03)

# Shelfwatch: Integrate YouTube Data API v3 into Competitor Marketing Activity

I want to activate YouTube data collection in Shelfwatch's existing Marketing Activity page.

I already have a Google YouTube Data API v3 key, which I will provide separately.

Currently, the Marketing Activity page shows:

- YouTube — Not set up
- No YouTube API key is configured, so channel uploads are not collected.
- Instagram — Not set up.
- Facebook — Not set up.

**For this implementation, I want ONLY YouTube to be configured and functional.**

Do not implement Instagram or Facebook yet.

## 1. Primary objective

Integrate the official YouTube Data API v3 into Shelfwatch so that it can collect and display publicly available YouTube content published by our competitors.

The integration must work with the existing Marketing Activity page, existing marketing evidence model, workspace structure, competitor websites and background collection system.

I do not want a separate YouTube dashboard or an entirely new marketing system.

I want YouTube content to appear alongside existing website marketing observations.

## 2. Securely configure the API key

I will provide the YouTube API key separately.

Configure it securely on the backend.

Critical security requirements:

- Store it as a backend environment secret, for example `YOUTUBE_API_KEY`.
- Configure it in the production backend environment on AWS EC2.
- Configure a separate local development environment variable if required.
- Never put the API key in React or frontend code.
- Never use a `VITE_`, `NEXT_PUBLIC_` or other publicly exposed environment variable.
- Never commit the key to GitHub.
- Never put it in frontend API responses.
- Never print the complete key in logs, error messages or debugging output.
- Ensure environment files have appropriate filesystem permissions.
- Follow the existing Shelfwatch deployment and secret-management conventions.

If the current server configuration requires a secure environment file, use the existing service configuration appropriately.

Do not change unrelated environment variables or overwrite existing secrets.

Also check that the Google Cloud project has YouTube Data API v3 enabled and handle invalid or restricted API keys properly.

## 3. Identify competitor YouTube channels

This is an important part of the implementation.

The API key alone does not tell Shelfwatch which channels belong to AUXITO, Alla Lighting, SEALIGHT, Lasfit or other competitors.

Investigate the existing website and social connection data.

Use the following approach:

1. Check whether competitor website records already contain official YouTube links.
2. Reuse existing verified YouTube channel URLs or channel IDs wherever available.
3. Associate each verified channel with the correct competitor website and workspace.
4. If a channel cannot be identified reliably, provide a way to enter its YouTube channel URL, handle or channel ID through the existing Manage social connections functionality.
5. Validate the channel using the official YouTube API before saving it.

Do not automatically associate a channel based only on a similar brand name.

Do not accidentally connect unofficial channels, unrelated reviewers or fan accounts to a competitor.

If a competitor has multiple verified official channels, support multiple channel mappings where the existing architecture allows it.

A YouTube channel should remain associated with its correct competitor and workspace.

## 4. Use the official YouTube Data API v3

Use Google's official YouTube Data API v3 endpoints.

Investigate the most appropriate API methods for:

- Resolving channel identifiers and handles.
- Retrieving channel information.
- Discovering the channel's uploads playlist.
- Retrieving recent uploaded videos.
- Retrieving public video statistics where available.

Prefer using the channel's uploads playlist and playlist pagination for collecting published videos.

Avoid repeatedly using expensive search operations when the uploads playlist can provide the required information.

Do not scrape YouTube pages or use unofficial APIs as a fallback.

## 5. Information to collect

For each publicly accessible video, collect the available relevant fields:

| Field | Purpose |
|---|---|
| Competitor website | Identifies which competitor published the content |
| YouTube channel name | Channel identity |
| Channel ID | Stable channel identifier |
| Video title | Content title |
| Video description | Content description |
| Video ID | Unique video identifier |
| Video URL | Link to the original video |
| Thumbnail URL | Video preview |
| Published date | Original publication time |
| View count | Public views, when available |
| Like count | Public likes, when available |
| Comment count | Public comments, when available |
| First seen | When Shelfwatch discovered the video |
| Last seen | Most recent successful observation |

Use only information returned by the API.

Some video statistics may be hidden or unavailable. Represent unavailable values honestly rather than inserting zero or estimating them.

Preserve the original publication date separately from the first-seen date.

## 6. Integrate collected videos into Marketing Activity

The existing page contains:

- YouTube, Instagram and Facebook connection cards.
- A competitor activity summary.
- Competitor-specific expandable sections.
- A marketing evidence table.
- Filters.
- Content type and reading classifications.

Use the existing design and data structures wherever appropriate.

After successful integration:

### YouTube status card

The YouTube card should show meaningful statuses:

- Not configured: API key missing.
- Needs channel setup: API key exists but no verified competitor channels are connected.
- Connected: API key is valid and at least one channel is configured.
- Collecting: Collection is running.
- Error: API or collection failure, with a clear explanation.

Do not report YouTube as fully connected just because an API key exists if no channels have been configured.

### Competitor activity sections

Videos should appear under the corresponding competitor.

For example:

- AUXITO → its verified YouTube uploads.
- Alla Lighting → its verified YouTube uploads.
- SEALIGHT → its verified YouTube uploads.
- Lasfit → its verified YouTube uploads.

Do not mix videos between competitors.

### Evidence table

YouTube observations should appear as YouTube content, with:

- Correct competitor.
- Source type: YouTube.
- Video title.
- Publication date.
- Engagement statistics where available.
- Original YouTube link.
- First-seen date.

Clicking the video link should open the original YouTube video in a new tab.

The existing website-observation functionality must continue working.

## 7. Keep marketing interpretations accurate

This is particularly important.

The Marketing Activity page already distinguishes between publicly observed promotional content and proof of paid advertising.

Maintain that distinction.

A competitor uploading a YouTube video does NOT prove that it is running a paid advertising campaign.

Do not automatically classify every uploaded video as a promotion.

Use the existing classification logic and only describe promotional activity when the available evidence supports it.

Likewise:
- Do not infer advertising spend.
- Do not invent engagement metrics.
- Do not interpret missing statistics as zero.
- Do not claim that a video was sponsored without evidence.

YouTube uploads, Shorts and other relevant public video formats should be recorded accurately using the available API metadata.

## 8. Collection scheduling and reliability

Integrate YouTube collection into the existing background worker and scheduling architecture.

Do not make the user wait for API requests when opening the Marketing Activity page.

Requirements:

- Collect recent uploads from verified competitor channels.
- Align the recent-activity window with the existing Marketing Activity page, currently showing the last 30 days.
- Use publication dates to determine whether content falls within the relevant period.
- Support pagination where necessary.
- Avoid downloading the same video repeatedly.
- Use video IDs and channel IDs for deduplication.
- Update public statistics when appropriate.
- Store collection timestamps and results.
- Resume safely after temporary API errors.
- Respect API quota limits.
- Avoid excessive API calls.
- Avoid overlapping heavy collection jobs.

Implement incremental collection so that subsequent runs retrieve new videos rather than repeatedly processing the entire channel history.

Handle common API errors appropriately:

- Invalid API key.
- API not enabled.
- Daily quota exhausted.
- Request rate limits.
- Invalid or deleted channel.
- Private or deleted video.
- Network timeout.
- Unavailable statistics.

An API error must not cause the entire Marketing Activity collection for other competitors or website observations to fail.

## 9. Manage social connections

Use the existing Manage social connections interface if possible.

I want a simple way to:

- Configure or verify YouTube channel mappings.
- Associate a YouTube channel with the correct competitor website.
- Validate a channel.
- Remove an incorrect channel mapping.
- See whether a channel is connected successfully.

Do not redesign the entire settings page.

Do not introduce unnecessary OAuth functionality if the public YouTube Data API key is sufficient for the required public information.

Do not request access to private channel analytics or account information.

## 10. Leave Instagram and Facebook untouched

I currently have only a YouTube API key.

Therefore:

- Activate YouTube integration only.
- Keep Instagram as Not set up.
- Keep Facebook as Not set up.
- Do not invent connections.
- Do not modify their existing integration architecture unnecessarily.
- Do not block YouTube collection because Instagram or Facebook is not configured.

The page should clearly show that YouTube is configured independently.

## 11. Testing requirements

Test the integration thoroughly.

### API tests

Verify:

- Valid API key.
- Invalid API key.
- Channel ID lookup.
- Channel handle lookup.
- Upload playlist retrieval.
- Video pagination.
- Video metadata.
- Public statistics.
- Quota-related errors.
- Deleted or unavailable videos.

### Data tests

Verify:

- Videos are associated with the correct competitor.
- Duplicate videos are not created.
- Existing website marketing observations remain unchanged.
- Publication dates are correct.
- Missing statistics are handled properly.
- Videos outside the 30-day window are handled consistently.

### UI tests

Verify:

- YouTube status changes from Not set up to the correct connection status.
- Competitor YouTube videos appear under the correct competitor.
- The original YouTube links work.
- The evidence table displays the correct fields.
- Existing website observations still appear.
- Instagram and Facebook continue showing Not set up.

### Production tests

After deployment:

- Confirm the API key is available to the backend but not exposed to the frontend.
- Run a small collection from one verified competitor channel.
- Verify the records in the database.
- Verify they appear on the live Marketing Activity page.
- Verify that a second collection does not create duplicates.
- Check API quota consumption and worker health.

Do not declare the integration successful merely because the API key is saved. Demonstrate that actual competitor videos have been retrieved and displayed.

## 12. Strict scope restrictions

Only implement YouTube integration.

Do NOT:

- Change product matching.
- Change automotive bundle rules.
- Change quantity matching.
- Modify Price Comparison.
- Modify Match Review.
- Modify product collection.
- Modify stock collection.
- Change unrelated Reports functionality.
- Implement Instagram or Facebook.
- Redesign unrelated Marketing Activity components.
- Introduce paid AI API dependencies.
- Change unrelated database records.

Preserve all existing Shelfwatch functionality.

Take an appropriate database backup before any production schema change.

## 13. Deployment and final report

After implementation:

1. Run the relevant tests.
2. Run the complete test suite where practical.
3. Run lint, type-check and production build.
4. Review all changed files.
5. Verify that the API key is not exposed or committed.
6. Deploy the backend and frontend together where necessary.
7. Configure the production API key securely.
8. Run a real YouTube collection.
9. Verify actual records on the live Marketing Activity page.

Your final report must explain:

- How the key was configured.
- Whether the API key was successfully validated.
- Which competitor channels were identified and connected.
- How many videos were collected per competitor.
- How many were within the last 30 days.
- Whether views, likes and comments were available.
- Which files and database components were modified.
- Test results.
- Production deployment status.
- Confirmation that Instagram, Facebook and unrelated Shelfwatch functionality were untouched.

**Final objective: Activate real YouTube competitor-content tracking in Shelfwatch using my API key, connect only verified competitor channels, and display their actual public uploads and available engagement information on the existing Marketing Activity page.**

---

*The user supplied the API key in a separate chat message; it is deliberately not reproduced here. It lives only in the production server’s environment file.*
