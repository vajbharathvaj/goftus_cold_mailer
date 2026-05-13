# Mono Layer Strategy

## Goal
Use only one fetch layer for website data: real Chrome profile flow.  
All older fallback layers (`jina`, `playwright`, `google_cache`, `search_snippet`) are removed from runtime fetch execution.

## Trigger Path
1. UI button: `Re-fetch Website`
2. API call: `POST /api/campaigns/:campaignId/rows/:rowNumber/retry` with `mode: "refetch_only"`
3. Row is marked `skipAutoPreview = true`
4. Processing sets `profileSearchOnly = true`
5. Website fetch runs only `chrome_profile_search_test`

For non-refetch website fetches:
- Website fetch runs only `chrome_profile`

## Mono Layer Execution Order
1. Open Chrome persistent context with real profile.
2. Open Google search for the row website URL.
3. Accept all cookies on search page if popup exists.
4. Open first Google result link.
5. Wait `2000ms`.
6. Hard refresh destination page:
   - Send keyboard `Ctrl+Shift+R`
   - Fallback keyboard `Ctrl+F5`
   - Enforce ignore-cache reload via CDP
   - Wait for page load
   - Print `HARD REFRESHED` in terminal
7. Maximize destination browser window.
8. Close non-cookie popups on destination page (newsletter/login/app/install modals, etc.).
9. Accept all cookies on destination page if popup exists.
10. Close non-cookie popups again (if new popup appears after cookie action).
11. Run reusable random human scroll function on destination page, then return to top.
12. Wait (minimum `10000ms`).
13. Extract homepage text snapshot.
14. Try finding About link on homepage.
15. Try finding Services-like link on homepage (`services`, `products`, `solutions`, `offerings`, `capabilities`, `features`, etc.).
16. If About link exists:
   - Open About page
   - Close non-cookie popups
   - Accept cookies if popup exists
   - Close non-cookie popups again
   - Run random human scroll function and return to top
   - Extract About page text snapshot
17. If Services-like link exists:
   - Open Services page
   - Close non-cookie popups
   - Accept cookies if popup exists
   - Close non-cookie popups again
   - Run random human scroll function and return to top
   - Extract Services page text snapshot
18. Build combined text (`homepage + about + services` when available).
19. Return combined content + structured snapshot object.

## Reusable Functions In Flow
- `randomHumanScrollDownAndBackTop(page, options)`
- `handleAcceptAllCookieConsent(page)`
- `closeNonCookiePopups(page, log, label)`
- `hardReloadIgnoringCache(page, { timeoutMs, log, label })`
- `buildPageTextSnapshot(page)`
- `findAboutLinkUrl(page, baseUrl)`
- `openLinkFromCurrentPage(page, targetUrl, { timeoutMs, log, label })`

## Console Output Behavior
Printed in backend terminal (`node src/server.js`), not browser DevTools.

Always for refetch-only rows:
- `[profile-search-content] {...}`
  - includes `campaignId`, `rowNumber`, `fetchMethod`, `contentLength`, `content`

When snapshot exists:
- `[profile-search-snapshot] {...}`
  - includes `entries` with `homepage`, optional `about`, optional `services`, and combined fields

Hard refresh marker:
- `HARD REFRESHED`

Trace output:
- `[campaign-row-trace] row=<n> ...`

## Snapshot JSON Shape (Current)
- `searchedUrl`
- `destinationUrl`
- `destinationTitle`
- `entries[]`
  - `pageType: "homepage"` (always)
  - `pageType: "about"` (optional)
  - `pageType: "services"` (optional)
- `homepageUrl`
- `homepageTitle`
- `homepageTextLength`
- `homepageRawTextLength`
- `homepageText`
- `aboutPageUrl`
- `aboutPageTitle`
- `aboutPageTextLength`
- `aboutPageRawTextLength`
- `aboutPageText`
- `servicesPageUrl`
- `servicesPageTitle`
- `servicesPageTextLength`
- `servicesPageRawTextLength`
- `servicesPageText`
- `extractedAt`
- `textLength`
- `rawTextLength`
- `text` (combined)

## Important Mode Boundary
`profileSearchOnly = true` means:
- Run only mono Chrome profile search layer
- Do not run Jina/playwright/google-cache/search-snippet fallback chain
- Do not run subpage-fetch pipeline

## Current Timing Rules
- Pre-hard-refresh delay after first result open: `2000ms`
- Post-navigation hold for profile search flow: minimum `10000ms`
