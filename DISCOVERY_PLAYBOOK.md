# Discovery Playbook

The app automates most of the course's organic-discovery method (see `COURSE_RULES.md` sections 1-2), but a real chunk of it can't be code — either YouTube's API doesn't expose the data, or the technique only makes sense as a human browsing a page. This is the checklist for that manual half, so it doesn't quietly stop happening just because the app doesn't mention it.

## What can't be automated, and why

- **Sidebar/related-video chaining.** YouTube removed public API access to "related videos" in 2023. There is no code substitute for opening a good small creator's video and scrolling the sidebar. The app's title-echo re-search (searching a found video's exact title as a quoted phrase) is the closest legal approximation, and it already runs automatically in every sweep — but it isn't the same thing, and won't surface everything sidebar browsing would.
- **Instagram "Tagged" checks.** Checking a target brand's Instagram profile for who they've tagged in posts has no API equivalent available here.
- **Who a creator follows / is followed by.** Same — no API access to this from what the app can reach.
- **Incognito/reset-search-environment.** Not applicable to this app by design — API search results aren't personalized by browsing history the way youtube.com's UI is, so there's nothing to reset.
- **YouTube's email-lookup captcha limit** (the gated "About" page button real humans use to request a creator's email). The app never touches this flow at all — its contact-hint scanning only reads public descriptions via the API. If you do use the manual About-page lookup: use a dedicated prospecting browser profile/account (not your daily one), and incognito mode, to avoid tripping the daily cap faster than necessary.

## The manual workflow

1. Browse normally — sidebar suggestions, Instagram Tagged, following chains, whatever the course lesson describes.
2. When you find a channel that looks right, copy its URL (or handle, or channel ID).
3. Paste it into the web UI's **"Evaluate a channel"** box (YouTube tab). This runs the exact same qualification pipeline as an automated search — subscriber range, engagement tier, avg views, posting consistency, fake-engagement check — and tells you every reason it passed or failed, not just the first one.
4. If it passes, it's already logged to the tracking sheet automatically. If it doesn't pass but you think the app is wrong (a borderline call — "develop a sniff," per the course), that's a legitimate judgment call the tool doesn't try to override — the reasons are there for you to weigh yourself.

This is the bridge between "the course's real method" and "what the app can actually see": the app does the paperwork and math, you do the browsing the API can't.
