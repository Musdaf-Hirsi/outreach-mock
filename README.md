# outreach-mock

A real (not simulated) influencer-outreach automation tool built with
[Mastra](https://mastra.ai), [DeepSeek](https://deepseek.com), the YouTube
Data API v3, and the Gmail API. It finds real YouTube creators in a niche,
drafts personalized first-contact emails, sends them, tracks follow-ups on
an escalating schedule, and reports progress against outreach volume goals.

## How it works

```
niche → find-influencers (YouTube API) → draft (DeepSeek) → supervisor review
                                                                   │
                                            revise ◄────────── reject
                                                                   │
                                                              approve
                                                                   │
                                                            send (Gmail API)
```

- **Discovery** — searches YouTube for channels in a niche, filters by
  subscriber count and *computed* engagement rate (from the last N videos'
  view/like/comment counts, not just subscriber count), and scans public
  channel/video descriptions for a contact email or linktree/website link.
- **Drafting** — a dedicated agent writes one short, specific email per
  candidate. No tools bound — it can't search or send, so a bad draft can
  never turn into a bad send on its own.
- **Supervisor** — reviews every draft before it's allowed to send: rejects
  em dashes, AI-vocabulary tells, generic/templated copy, and anything over
  length. Sends it back to drafting with specific feedback on REVISE.
- **Sending** — real Gmail API send via OAuth. Hard-blocks duplicate sends
  to a channel already logged, independent of what the agent decides.
- **Follow-ups** — tracks every outreach thread and computes who's due for a
  nudge using an escalating, workday-aware schedule (skips weekends, and
  won't follow up the first thing Monday after a Friday send). Auto-shifts
  from a light nudge to a heavier one after several unanswered follow-ups,
  and flags threads that need a fresh angle after 7 follow-ups with no
  reply — instead of sending an 8th message into the void.
- **Reply detection** — polls Gmail (read-only) for a real reply on every
  open thread and auto-marks it, so a creator who already responded never
  gets an unnecessary follow-up nudge. Runs automatically before building
  the follow-up queue, or on its own via `npm run check-replies`.
- **Tracking** — every send is logged to `outreach-log.json` and measured
  against configurable milestone targets, so progress is a real number, not
  a guess.

## Setup

```bash
npm install
cp .env.example .env   # fill in the keys below
```

You'll need:

| Key | Where to get it |
|---|---|
| `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) |
| `YOUTUBE_API_KEY` | Enable "YouTube Data API v3" in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Create an OAuth client (type: Desktop app) in Cloud Console after enabling the Gmail API |

Then authorize Gmail sending once:

```bash
npm run gmail-auth
```

This opens a browser consent flow and saves a refresh token to
`gmail-token.json` (gitignored — never commit this file).

## Usage

```bash
npm run dev -- "personal finance"      # dry run: discover, draft, get supervisor approval, print (no sends)
npm run dev -- "personal finance" --send # same, but actually sends approved drafts
npm run interactive -- "fitness"       # step through each candidate, confirm before sending
npm run followups                      # work through the due follow-up queue
npm run check-replies                  # poll Gmail and auto-mark any real replies (also runs inside followups)
npm run mark-replied -- <channelId>    # manually stop follow-ups (fallback if auto-detection missed one)
npm run report                         # milestone progress + follow-ups due
npm run dashboard                      # live web dashboard at localhost:4741
```

## Project structure

```
src/
  mastra/
    model.ts               DeepSeek wiring (OpenAI-compatible provider)
    agents/                 discovery / drafting / supervisor / sender / followup / outreach
    tools/
      find-influencers-tool.ts   YouTube search + stats + contact-hint scanning
      send-email-tool.ts         Gmail send, dedup guard, thread-reply support
      youtube-quota.ts           daily quota tracking + request pacing
  tracking/outreach-log.ts   send history, milestone math, follow-up queue
  gmail/check-replies.ts     polls Gmail threads, auto-marks real replies
  utils/workdays.ts          escalating workday-aware follow-up scheduling
  viz/                       terminal + web live agent-graph visualization
  run.ts / run-interactive.ts / run-followups.ts / report.ts / mark-replied.ts / check-replies.ts
```

## Known limits

- YouTube's API never exposes a creator's private business email — only
  what's publicly visible in descriptions/links. A placeholder is used as a
  fallback so the pipeline always has a valid-shaped address to pass
  around; `run-interactive.ts` prompts for the real email by hand instead
  of silently sending to it.
- Auto-reply-detection (`npm run check-replies`, or automatically before
  `npm run followups`) requires the `gmail.readonly` scope. If your
  `gmail-token.json` was created before this feature existed, it was
  authorized under a `gmail.send`-only token and will fail with an
  insufficient-scope error — re-run `npm run gmail-auth` once to reauthorize
  with both scopes. `mark-replied` still exists as a manual fallback.
- Detection works by checking who sent the most recent message in a thread,
  not by parsing message content — it can't tell you *what* a creator wants,
  just that they replied. Read the actual email yourself before deciding
  what to do next.
