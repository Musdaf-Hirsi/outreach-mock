import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { setNode, logDetail } from "../../viz/graph";
import { consumeQuota, sleep } from "./youtube-quota";
import { getContactHistory } from "../../tracking/outreach-log";
import { logFoundCandidates, getAllFoundCandidatesDeduped } from "../../tracking/found-candidates-log";
import { logRejectedCandidates, getRecentlyRejectedIds } from "../../tracking/rejected-candidates-log";
import { computeBaselineViews } from "../../pricing/cpm-calculator";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const REQUEST_DELAY_MS = Number(process.env.YOUTUBE_REQUEST_DELAY_MS ?? 300);

// Approximate YouTube Data API v3 quota cost per endpoint (search.list is
// far more expensive than the list-by-id endpoints).
const ENDPOINT_COST: Record<string, number> = {
  search: 100,
  channels: 1,
  playlistItems: 1,
  videos: 1,
};

interface YouTubeSearchItem {
  id: { channelId?: string; videoId?: string };
  snippet?: { channelId: string };
}

interface YouTubeChannel {
  id: string;
  snippet: { title: string; description: string; customUrl?: string };
  statistics: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails: { relatedPlaylists: { uploads: string } };
}

// customUrl (e.g. "@handle") comes free on the same channels.list call
// (part=snippet) already being made — no extra quota. This is exactly
// where lesson-050's manual email lookup happens (a channel's public
// About page), so a direct link saves a click over the bare channel-ID URL.
function channelAboutUrl(channel: YouTubeChannel): string {
  return channel.snippet.customUrl
    ? `https://www.youtube.com/${channel.snippet.customUrl}/about`
    : `https://www.youtube.com/channel/${channel.id}/about`;
}

interface YouTubePlaylistItem {
  contentDetails: { videoId: string };
  snippet: { title: string; publishedAt: string };
}

interface YouTubeVideoStats {
  id: string;
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
  snippet: { description: string };
  contentDetails: { duration: string };
}

// Parses an ISO 8601 duration ("PT4M13S", "PT58S", "PT1H2M3S") into total
// seconds. Sponsorship deals are for long-form videos — that's what the
// whole course's pricing/negotiation logic assumes — so Shorts (under
// ~3 min) need to be excluded from the sample before any avg-views/
// engagement/posting-consistency math runs on it, not mixed in.
function parseIsoDurationSeconds(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

const SHORT_MAX_SECONDS = 180;

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const LINK_REGEX = /https?:\/\/(?:www\.)?(?:linktr\.ee|linktree\.com|beacons\.ai|[a-zA-Z0-9-]+\.[a-zA-Z]{2,})\/[^\s)]*/g;

// Scans public text (channel/video descriptions) for a contact email or a
// linked website/linktree — legitimate, since this is public API data the
// creator chose to publish, unlike scraping the gated "About" page email
// button which YouTube deliberately hides from any API access.
function findContactHints(texts: string[]): { emails: string[]; links: string[] } {
  const emails = new Set<string>();
  const links = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(EMAIL_REGEX)) emails.add(match[0]);
    for (const match of text.matchAll(LINK_REGEX)) links.add(match[0]);
  }
  return { emails: [...emails], links: [...links] };
}

// Video/channel descriptions often contain more than one email — a
// sponsor's, an editor's, a manager's — and the first regex match isn't
// necessarily the creator's own. Reorders `emails` so the one most likely
// to actually belong to this channel comes first: a domain that also shows
// up in the channel's own links (linktree/website), or one that shares
// several characters with the channel name/handle, scores higher than an
// arbitrary generic address. `ambiguous` is true when nothing distinguishes
// multiple candidates on different domains — worth a human glance before
// trusting emails[0] blindly.
function rankContactEmails(emails: string[], links: string[], channelTitle: string): { emails: string[]; ambiguous: boolean } {
  if (emails.length <= 1) return { emails, ambiguous: false };

  const linkDomains = links
    .map((l) => {
      try {
        return new URL(l).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const normalizedTitle = channelTitle.toLowerCase().replace(/[^a-z0-9]/g, "");

  const scored = emails.map((email) => {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const domainRoot = domain.replace(/\.[a-z]+$/, "");
    let score = 0;
    if (linkDomains.some((ld) => domain === ld)) score += 2;
    if (normalizedTitle.length >= 4 && domainRoot.includes(normalizedTitle.slice(0, Math.min(8, normalizedTitle.length)))) score += 1;
    return { email, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const distinctDomains = new Set(emails.map((e) => e.split("@")[1]?.toLowerCase()));
  const ambiguous = scored[0].score === 0 && distinctDomains.size > 1;

  return { emails: scored.map((s) => s.email), ambiguous };
}

// Course pricing/qualification red flag: wildly fluctuating view counts
// across recent videos (one viral hit, everything else flat — or vice
// versa) is called out as its own reliability concern distinct from average
// engagement, since it means the audience/reach isn't a dependable number
// to price or plan a campaign against. Coefficient of variation (stdev /
// mean) — scale-independent, so a channel with 3 evenly-performing videos
// at 500k each reads the same as one with 3 at 5k each; only the spread
// relative to the average matters.
function computeViewFluctuation(views: number[]): boolean {
  if (views.length < 3) return false;
  const mean = views.reduce((sum, v) => sum + v, 0) / views.length;
  if (mean === 0) return false;
  const variance = views.reduce((sum, v) => sum + (v - mean) ** 2, 0) / views.length;
  const coefficientOfVariation = Math.sqrt(variance) / mean;
  return coefficientOfVariation > 1.2;
}

// Course technique ("How to Message Influencers"): before pitching, open
// several influencers' recent videos, list every brand they've mentioned as
// a sponsor, then name 2 brands in the niche the *target* creator hasn't
// worked with yet as the email's offer. This scans the same video
// descriptions we already pull (no extra API calls) for sponsor-style
// mentions, so that brand list can be built automatically instead of by
// hand. Regex-based brand-name extraction is inherently a heuristic — it
// catches the common phrasing patterns, not every possible sponsor mention.
// JS regex has no per-group case flag, so this is two passes: find the
// keyword phrase case-insensitively (a sentence starting "Thanks to
// Squarespace..." is as common as mid-sentence "thanks to"), then extract
// the brand name from what follows with the first word matched loosely but
// every additional word required to start with a capital letter — that
// stops a greedy multi-word capture from swallowing ordinary lowercase
// filler words ("thanks to Squarespace for supporting" should stop at
// "Squarespace", not run on to "for supporting").
const SPONSOR_KEYWORD_REGEX =
  /\b(?:sponsored by|in partnership with|thanks to|brought to you by|thank you to|this video is sponsored by|paid partnership with)\s+/gi;
const BRAND_NAME_REGEX = /^([A-Za-z][A-Za-z0-9&'.]*(?:\s+[A-Z][A-Za-z0-9&'.]*){0,2})/;

function findSponsorBrandMentions(texts: string[]): string[] {
  const brands = new Set<string>();
  for (const text of texts) {
    for (const keywordMatch of text.matchAll(SPONSOR_KEYWORD_REGEX)) {
      const afterKeyword = text.slice(keywordMatch.index! + keywordMatch[0].length);
      const brand = BRAND_NAME_REGEX.exec(afterKeyword)?.[1]?.trim();
      if (brand && brand.length <= 40 && /^[A-Z]/.test(brand)) brands.add(brand);
    }
  }
  return [...brands];
}

async function youtubeGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is not set in the environment (.env).");
  }

  // Guard the daily quota before spending it, and space out requests so we
  // don't fire a burst of calls back-to-back.
  await consumeQuota(ENDPOINT_COST[path] ?? 1);
  await sleep(REQUEST_DELAY_MS);

  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error ${res.status} on ${path}: ${body}`);
  }
  return (await res.json()) as T;
}

interface RecentVideoBreakdown {
  title: string;
  views: number;
  likes: number;
  comments: number;
  engagementRate: number;
}

// Pulls the last N videos for a channel with per-video view/like/comment
// counts, plus the averages computed from that same list — so callers can
// see the actual per-video breakdown, not just an aggregate.
// Qualification dimension from the course ("How to Qualify Influencers"):
// posting less than once a month, or in sporadic bursts, means "it's a
// hobby, not a business" — not a reliable partner for a multi-month brand
// campaign. Computed from the same playlistItems publishedAt timestamps we
// already pull, no extra API calls.
function computePostingConsistency(publishedDates: string[]): {
  postingConsistency: "consistent" | "sporadic" | "unknown";
  daysSinceLastUpload: number | null;
} {
  if (publishedDates.length < 2) {
    return { postingConsistency: "unknown", daysSinceLastUpload: null };
  }
  const sorted = [...publishedDates].map((d) => new Date(d).getTime()).sort((a, b) => b - a);
  const daysSinceLastUpload = Math.floor((Date.now() - sorted[0]) / (1000 * 60 * 60 * 24));

  const gapsDays: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    gapsDays.push((sorted[i] - sorted[i + 1]) / (1000 * 60 * 60 * 24));
  }
  const avgGapDays = gapsDays.reduce((sum, g) => sum + g, 0) / gapsDays.length;

  // "At least once a month with a predictable pattern" — a >45-day average
  // gap between sampled uploads, or having gone stale (>60 days since the
  // last one), both read as sporadic per the course's bar.
  const sporadic = avgGapDays > 45 || daysSinceLastUpload > 60;
  return { postingConsistency: sporadic ? "sporadic" : "consistent", daysSinceLastUpload };
}

async function getRecentVideoStats(uploadsPlaylistId: string, maxVideos: number) {
  // Over-fetch playlist items: the uploads playlist mixes Shorts and
  // long-form videos with no way to tell them apart until after the
  // videos.list call, so asking for exactly maxVideos here risks ending up
  // with mostly-Shorts after filtering. 3x (capped at 50, the API max) is
  // enough headroom for channels that post Shorts daily and long-form
  // rarely, without wasting a second playlistItems call on a normal channel.
  const playlistData = await youtubeGet<{ items: YouTubePlaylistItem[]; nextPageToken?: string }>("playlistItems", {
    part: "contentDetails,snippet",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(maxVideos * 3, 50)),
  });

  // A private/deleted video in the uploads playlist has no contentDetails.videoId.
  // Passing that gap through into a joined id list (e.g. "abc,,def") makes the
  // videos.list call misreport an unrelated "myRating" 403 instead of a clean
  // error, so drop empties before building the request.
  const videoIds = playlistData.items.map((item) => item.contentDetails.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    return {
      avgViews: 0,
      engagementRate: 0,
      recentVideoTopic: "",
      recentVideos: [] as RecentVideoBreakdown[],
      videoDescriptions: [] as string[],
      allVideoDescriptions: [] as string[],
      playlistNextPageToken: playlistData.nextPageToken,
      postingConsistency: "unknown" as const,
      daysSinceLastUpload: null as number | null,
      possibleFakeEngagement: false,
      inconsistentViews: false,
    };
  }

  const videoData = await youtubeGet<{ items: YouTubeVideoStats[] }>("videos", {
    part: "statistics,snippet,contentDetails",
    id: videoIds.join(","),
  });

  // Every fetched video's description (Shorts included) — free contact-hint
  // scanning material beyond just the long-form-only videoDescriptions
  // below, since this data was already pulled for the over-fetch above and
  // costs nothing extra. A contact email/link in a Short's description is
  // still a real find, even though Shorts are excluded from the
  // views/engagement/posting-consistency math itself.
  const allVideoDescriptions = videoData.items.map((v) => v.snippet.description ?? "");

  const titleById = new Map(playlistData.items.map((item) => [item.contentDetails.videoId, item.snippet.title]));
  const publishedById = new Map(playlistData.items.map((item) => [item.contentDetails.videoId, item.snippet.publishedAt]));

  // Sponsorship deals are for long-form integrations — that's the whole
  // premise of the course's pricing/negotiation lessons — so Shorts need to
  // be excluded before any of avg-views, engagement, or posting-consistency
  // math runs, not averaged in alongside them. Keep at most maxVideos of
  // the survivors, playlist order (newest-first) preserved.
  const longFormVideos = videoData.items
    .filter((video) => parseIsoDurationSeconds(video.contentDetails?.duration ?? "") >= SHORT_MAX_SECONDS)
    .slice(0, maxVideos);

  if (longFormVideos.length === 0) {
    return {
      avgViews: 0,
      engagementRate: 0,
      recentVideoTopic: "",
      recentVideos: [] as RecentVideoBreakdown[],
      videoDescriptions: [] as string[],
      allVideoDescriptions,
      playlistNextPageToken: playlistData.nextPageToken,
      postingConsistency: "unknown" as const,
      daysSinceLastUpload: null as number | null,
      possibleFakeEngagement: false,
      inconsistentViews: false,
    };
  }

  const recentVideos: RecentVideoBreakdown[] = longFormVideos.map((video) => {
    const views = Number(video.statistics.viewCount ?? 0);
    const likes = Number(video.statistics.likeCount ?? 0);
    const comments = Number(video.statistics.commentCount ?? 0);
    return {
      title: titleById.get(video.id) ?? "(untitled)",
      views,
      likes,
      comments,
      engagementRate: views > 0 ? (likes + comments) / views : 0,
    };
  });

  const videoDescriptions = longFormVideos.map((v) => v.snippet.description ?? "");

  // Matches the exact procedure the course teaches for pricing
  // (cpm-calculator.ts's computeBaselineViews: drop the highest and lowest
  // performer as outliers, average the rest) — discovery used to do a plain
  // mean instead, so a single viral or single flopped video could push a
  // channel across the 50k-avg-views floor in either direction, which is
  // exactly what the outlier-drop exists to prevent.
  const avgViews = computeBaselineViews(recentVideos.map((v) => ({ views: v.views })));

  // Aggregate (total likes+comments / total views) rather than a mean of
  // per-video ratios — a mean of ratios lets one low-view video's ratio
  // swing the channel's score as much as a high-view one, even though it
  // represents far less actual audience engagement.
  const totalViews = recentVideos.reduce((sum, v) => sum + v.views, 0);
  const totalLikes = recentVideos.reduce((sum, v) => sum + v.likes, 0);
  const totalComments = recentVideos.reduce((sum, v) => sum + v.comments, 0);
  const engagementRate = totalViews > 0 ? (totalLikes + totalComments) / totalViews : 0;

  const recentVideoTopic = longFormVideos[0] ? titleById.get(longFormVideos[0].id) ?? "" : "";

  const { postingConsistency, daysSinceLastUpload } = computePostingConsistency(
    longFormVideos.map((video) => publishedById.get(video.id)).filter((d): d is string => Boolean(d)),
  );

  // Course red flag: "less than 1% comments... bot followers, AI comments."
  // Bought/fake engagement typically inflates likes far more than comments
  // (comments are harder to fake convincingly at scale), so a suspiciously
  // low comment-to-view ratio alongside otherwise-normal-looking engagement
  // is the tell, not raw engagement rate alone.
  const avgCommentRate = totalViews > 0 ? totalComments / totalViews : 0;
  const possibleFakeEngagement = engagementRate >= 0.01 && avgCommentRate < 0.001;
  const inconsistentViews = computeViewFluctuation(recentVideos.map((v) => v.views));

  return {
    avgViews,
    engagementRate,
    recentVideoTopic,
    inconsistentViews,
    recentVideos,
    videoDescriptions,
    allVideoDescriptions,
    playlistNextPageToken: playlistData.nextPageToken,
    postingConsistency,
    daysSinceLastUpload,
    possibleFakeEngagement,
  };
}

// True fallback when even allVideoDescriptions (free, already-fetched data)
// turned up nothing: fetch further back into the upload history and scan
// those descriptions too. snippet-only (no statistics/contentDetails
// needed for a pure text scan) keeps this to 2 quota units total
// (1 playlistItems + 1 videos.list), and it only ever runs when no contact
// hint was found any other way.
async function scanOlderVideosForContactHints(uploadsPlaylistId: string, pageToken: string, maxExtra: number): Promise<string[]> {
  const playlistData = await youtubeGet<{ items: YouTubePlaylistItem[] }>("playlistItems", {
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(maxExtra, 50)),
    pageToken,
  });
  const videoIds = playlistData.items.map((item) => item.contentDetails.videoId).filter(Boolean);
  if (videoIds.length === 0) return [];

  const videoData = await youtubeGet<{ items: { snippet: { description: string } }[] }>("videos", {
    part: "snippet",
    id: videoIds.join(","),
  });
  return videoData.items.map((v) => v.snippet.description ?? "");
}

export const findInfluencersTool = createTool({
  id: "find-influencers",
  description:
    "Searches real YouTube channels for a niche via the YouTube Data API v3, then filters by subscriber count and computed engagement rate from their recent uploads.",
  inputSchema: z.object({
    niche: z.string().describe("Niche keyword to search, e.g. 'halal fitness' or 'personal finance'"),
    // The keyword-sweep and title-echo callers (find-candidates-for-niche)
    // used to pass the search phrase itself (a long-tail keyword, or a
    // whole video title copied from a found candidate) as `niche` — which
    // then got written into found-candidates.json / the tracking sheet /
    // the CPM benchmark lookup as if it were the real niche. This lets the
    // caller send a different phrase to search than the niche label that
    // gets recorded on the results.
    searchQuery: z
      .string()
      .optional()
      .describe("Text to actually send to YouTube search, if different from `niche` (e.g. a long-tail keyword or an echoed video title). `niche` stays the label recorded on results/logs. Defaults to `niche`."),
    minSubscribers: z.number().default(50_000),
    maxSubscribers: z.number().default(500_000),
    minEngagementRate: z
      .number()
      .default(0.01)
      .describe(
        "Floor for the engagement-rate bar — the actual bar used per candidate is the higher of this and " +
          "the course's 3% healthy-engagement floor, so a small/hollow channel can't sneak through on a " +
          "looser caller-supplied threshold.",
      ),
    minAvgViews: z
      .number()
      .default(50_000)
      .describe(
        "Minimum average views across recent videos — catches channels with a large but inactive/stale " +
          "subscriber base whose real reach is much smaller than their follower count suggests",
      ),
    maxCandidates: z
      .number()
      .default(5)
      .describe("Max channels to return after filtering — every unique channel the search turns up gets evaluated regardless, this only caps the surviving list"),
    videosPerChannel: z.number().default(10).describe("Recent videos to sample for avg views / engagement / sponsor scan"),
    // Course technique ("The Best Way of Finding Influencers Organically",
    // step 3): intitle: and quoted exact-phrase searches deliberately give
    // different results from each other and from a plain search — the
    // lesson's own side-by-side demo shows intitle: surfacing smaller
    // creators a plain search misses, and quotes doing the same for a
    // different subset. "quotes" is also the right mode for the copy-a-
    // title-and-search-it-again technique (step 2): pasting a whole video
    // title back in works best as an exact phrase, not intitle:, which only
    // requires the words to appear in the title in any order.
    searchMode: z
      .enum(["intitle", "quotes", "plain"])
      .default("intitle")
      .describe(
        "How the niche/query string is sent to YouTube's search: 'intitle' (intitle:<query>, words must appear " +
          "in the video title) surfaces smaller channels than a plain keyword search; 'quotes' (\"<query>\") " +
          "forces an exact-phrase match, best when the query is a whole video title copied from an existing " +
          "candidate; 'plain' sends the query as-is, YouTube's normal (popularity-biased) search.",
      ),
    uploadedWithinDays: z
      .number()
      .optional()
      .describe(
        "Only surface channels whose sampled video was uploaded within this many days, ordered by " +
          "recency. Biases results toward fresh, smaller channels instead of the same evergreen big " +
          "names — the API equivalent of the course's URL-date-filter trick. Omit for no date filter.",
      ),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        channelName: z.string(),
        niche: z.string(),
        subscribers: z.number(),
        avgViews: z.number(),
        engagementRate: z.number(),
        recentVideoTopic: z.string(),
        channelId: z.string(),
        // YouTube channel IDs can contain underscores, which are invalid in an
        // email domain — pre-building a guaranteed-valid placeholder here means
        // the agent never has to construct one itself and risk breaking it.
        placeholderEmail: z.string().email(),
        // Channel's public About page — where a human does the manual email
        // lookup (lesson 050) when no auto-found email/link exists.
        aboutUrl: z.string(),
        // YouTube's API never exposes a creator's private business email
        // directly, but public channel/video descriptions sometimes contain
        // one, or a linktree/website — scanned here from data the creator
        // chose to publish, not scraped from any gated page.
        contactHints: z.object({
          emails: z.array(z.string()),
          links: z.array(z.string()),
        }),
        recentVideos: z.array(
          z.object({
            title: z.string(),
            views: z.number(),
            likes: z.number(),
            comments: z.number(),
            engagementRate: z.number(),
          }),
        ),
        // Prevents re-emailing the same creator across separate runs, since
        // each `npm run dev` invocation otherwise starts with no memory.
        alreadyContacted: z.boolean(),
        lastContactedAt: z.string().optional(),
        // Course qualification dimensions (see "How to Qualify Influencers")
        // computed from data already pulled above — no extra API calls.
        postingConsistency: z.enum(["consistent", "sporadic", "unknown"]),
        daysSinceLastUpload: z.number().nullable(),
        possibleFakeEngagement: z.boolean().describe(
          "Suspiciously low comment-to-view ratio despite decent-looking overall engagement — the course's " +
            "bought/fake-engagement tell (likes are cheap to fake at scale, real comments are not).",
        ),
        inconsistentViews: z.boolean().describe(
          "Wildly fluctuating view counts across recent videos (one viral hit, everything else flat, or vice " +
            "versa) — the course's reliability red flag distinct from average engagement; informational only, " +
            "never auto-excludes a candidate.",
        ),
        emailAmbiguous: z.boolean().describe(
          "Multiple emails were found in this channel's public descriptions on different domains with no clear " +
            "signal for which belongs to the creator (vs. a sponsor/editor/manager) — worth a manual glance " +
            "before trusting contactHints.emails[0].",
        ),
        engagementThresholdApplied: z.number().describe("The actual engagement-rate bar this candidate was filtered against"),
        // Course technique ("How to Message Influencers" offer section):
        // brands mentioned as sponsors in this candidate's own video
        // descriptions, and 1-2 brands seen elsewhere in this niche's
        // candidate pool that this creator has NOT worked with — a ready
        // starting point for the email's offer instead of a vague "perfect
        // fit" claim or a fabricated "we have brands" lie.
        sponsorBrandsMentioned: z.array(z.string()),
        suggestedBrandsToOffer: z.array(z.string()),
      }),
    ),
    // Every channel that was actually evaluated (cost real quota) but
    // rejected, with the reason — previously this only went to logDetail
    // (terminal/viz dashboard only), so a web search that rejected
    // everything just showed "no candidates" with zero visibility into
    // whether the niche is dead or 10 good channels missed one bar by a
    // hair. Lets the human apply their own judgment on borderline calls,
    // which the course explicitly wants ("develop a sniff").
    skipped: z.array(
      z.object({
        channelId: z.string(),
        channelName: z.string(),
        subscribers: z.number(),
        reason: z.string(),
      }),
    ),
  }),
  execute: async ({ context }) => {
    const {
      niche,
      searchQuery,
      minSubscribers,
      maxSubscribers,
      minEngagementRate,
      minAvgViews,
      maxCandidates,
      videosPerChannel,
      searchMode,
      uploadedWithinDays,
    } = context;

    const searchText = searchQuery ?? niche;
    setNode("find-influencers", "active", `searching "${searchText}" (${searchMode})`);

    // Search by video, not by channel name: channel search only matches
    // known channel titles/descriptions and keeps resurfacing the same big
    // names. Searching video titles (with intitle: or an exact quoted
    // phrase) and pulling the channelId off each result surfaces smaller,
    // more specific channels — the API equivalent of the course's manual
    // long-tail-keyword + intitle:/quotes technique.
    const query = searchMode === "intitle" ? `intitle:${searchText}` : searchMode === "quotes" ? `"${searchText}"` : searchText;
    const searchParams: Record<string, string> = {
      part: "snippet",
      type: "video",
      q: query,
      // Over-fetch videos since multiple results often land on the same
      // channel — we need enough unique channelIds to fill maxCandidates.
      maxResults: String(Math.min(maxCandidates * 5, 50)),
      // Course qualification rule ("How to Qualify Influencers"): English-
      // language campaigns want a "golden country" (US/UK/Canada/Australia)
      // audience. Can't be enforced (YouTube's API never exposes audience
      // geography), but relevanceLanguage/regionCode are a free tilt toward
      // English-market creators at search time, at no extra quota cost.
      // Override via env if searching a non-English niche.
      relevanceLanguage: process.env.YOUTUBE_RELEVANCE_LANGUAGE ?? "en",
      regionCode: process.env.YOUTUBE_REGION_CODE ?? "US",
    };
    if (uploadedWithinDays !== undefined) {
      searchParams.order = "date";
      searchParams.publishedAfter = new Date(Date.now() - uploadedWithinDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const searchData = await youtubeGet<{ items: YouTubeSearchItem[] }>("search", searchParams);

    // Skip channels already sitting in the found-but-not-contacted list —
    // a repeat search used to re-verify the same candidates from scratch
    // every time (real quota spent on channels.list/playlistItems/videos
    // calls for a name already on the tracking sheet) and report them
    // again as if newly found. A channel already contacted is deliberately
    // NOT skipped here — that's the existing alreadyContacted flag's job,
    // computed per-channel below, and skipping it here would hide it from
    // this run's log entirely rather than just flagging it.
    const alreadyFoundIds = new Set(
      getAllFoundCandidatesDeduped()
        .filter((c) => !getContactHistory(c.channelId).contacted)
        .map((c) => c.channelId),
    );
    // Same idea, for channels already known to fail the filters: a repeat
    // search (across keywords in one sweep, or across days) used to
    // re-fetch and re-evaluate a rejected channel's stats from scratch
    // every time, spending real quota to land on the exact same rejection.
    // A 7-day window (see rejected-candidates-log.ts) means a channel that
    // genuinely changes still gets re-evaluated eventually.
    const recentlyRejectedIds = getRecentlyRejectedIds();

    // Evaluate every unique channel the search returned rather than
    // stopping at maxCandidates here — search.list costs the same 100
    // quota units no matter how many results it returns, but
    // channels.list/playlistItems/videos.list cost only ~2-3 units per
    // channel, so capping the pool this early throws away most of what the
    // expensive call already paid for. maxCandidates now caps the surviving
    // (post-filter) results instead, further down.
    const seen = new Set<string>();
    const channelIds: string[] = [];
    let skippedAlreadyFound = 0;
    let skippedRecentlyRejected = 0;
    for (const item of searchData.items) {
      const id = item.snippet?.channelId ?? item.id.channelId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (alreadyFoundIds.has(id)) {
        skippedAlreadyFound++;
        continue;
      }
      if (recentlyRejectedIds.has(id)) {
        skippedRecentlyRejected++;
        continue;
      }
      channelIds.push(id);
    }
    if (skippedAlreadyFound > 0) {
      logDetail(`"${searchText}" — skipped ${skippedAlreadyFound} channel(s) already in the found-not-contacted list`);
    }
    if (skippedRecentlyRejected > 0) {
      logDetail(`"${searchText}" — skipped ${skippedRecentlyRejected} channel(s) rejected within the last 7 days`);
    }

    if (channelIds.length === 0) {
      setNode("find-influencers", "done", "0 candidates found");
      return { results: [], skipped: [] };
    }

    const channelData = await youtubeGet<{ items: YouTubeChannel[] }>("channels", {
      part: "snippet,statistics,contentDetails",
      id: channelIds.join(","),
    });

    logDetail(`"${searchText}" — ${channelData.items.length} channel(s) from search:`);

    const results = [];
    const skipped: { channelId: string; channelName: string; subscribers: number; reason: string }[] = [];
    for (const channel of channelData.items) {
      const subscribers = Number(channel.statistics.subscriberCount ?? 0);
      const label = `${channel.snippet.title} (${subscribers.toLocaleString()} subs)`;

      if (channel.statistics.hiddenSubscriberCount) {
        logDetail(`${label} — SKIPPED (subscriber count hidden)`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason: "subscriber count hidden" });
        continue;
      }
      if (subscribers < minSubscribers || subscribers > maxSubscribers) {
        const reason = `outside ${minSubscribers.toLocaleString()}–${maxSubscribers.toLocaleString()} subscriber range`;
        logDetail(`${label} — SKIPPED (${reason})`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason });
        continue;
      }

      let videoStats: Awaited<ReturnType<typeof getRecentVideoStats>>;
      try {
        videoStats = await getRecentVideoStats(channel.contentDetails.relatedPlaylists.uploads, videosPerChannel);
      } catch (err: any) {
        // One channel's video data failing (deleted/private videos, transient
        // API errors) shouldn't abort the whole niche search — skip it and
        // keep evaluating the rest of the candidate pool.
        const reason = `couldn't fetch video stats: ${err.message ?? String(err)}`;
        logDetail(`${label} — SKIPPED (${reason})`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason });
        continue;
      }
      const {
        avgViews,
        engagementRate,
        recentVideoTopic,
        recentVideos,
        videoDescriptions,
        allVideoDescriptions,
        playlistNextPageToken,
        postingConsistency,
        daysSinceLastUpload,
        possibleFakeEngagement,
        inconsistentViews,
      } = videoStats;

      // Course rule: "3-8% on smaller creators, 3% is healthy at 1M+ views" —
      // 3% is the floor at every size, not just the top end. This used to
      // scale up to a 4% floor for small/mid creators, which silently
      // discarded legitimately good 3-3.9% candidates the course would
      // still call healthy. minEngagementRate stays an additional (never
      // lower) floor for a caller that wants to be stricter.
      const tierFloor = 0.03;
      const engagementThresholdApplied = Math.max(minEngagementRate, tierFloor);

      if (engagementRate < engagementThresholdApplied) {
        const reason = `engagement ${(engagementRate * 100).toFixed(2)}% below ${(engagementThresholdApplied * 100).toFixed(2)}% minimum for this subscriber tier`;
        logDetail(`${label} — SKIPPED (${reason})`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason });
        continue;
      }
      if (possibleFakeEngagement) {
        const reason = "possible fake/bought engagement — comment rate far below what real engagement of this size implies";
        logDetail(`${label} — SKIPPED (${reason})`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason });
        continue;
      }

      // Course qualification rule ("How to Qualify Influencers"): a
      // sporadic/stale poster isn't a reliable partner for a multi-month
      // campaign. This used to only be checked downstream in run.ts right
      // before drafting — the discovery tool itself computed and tagged
      // postingConsistency but never actually excluded sporadic candidates,
      // so they still made it into found-candidates.json / the tracking
      // sheet / the manager agent's results looking like real qualified
      // candidates. Filtering here means every discovery path (web search,
      // CLI, the manager agent) gets the same real qualification bar, not
      // just the one CLI script that happened to check it last.
      if (postingConsistency === "sporadic") {
        const reason = `sporadic posting${daysSinceLastUpload !== null ? ` — last upload ${daysSinceLastUpload}d ago` : ""}, not a reliable campaign partner`;
        logDetail(`${label} — SKIPPED (${reason})`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason });
        continue;
      }

      if (avgViews < minAvgViews) {
        const reason = `avg views ${avgViews.toLocaleString()} below ${minAvgViews.toLocaleString()} minimum`;
        logDetail(`${label} — SKIPPED (${reason})`);
        skipped.push({ channelId: channel.id, channelName: channel.snippet.title, subscribers, reason });
        continue;
      }

      logDetail(
        `${label} — TARGETED (${(engagementRate * 100).toFixed(2)}% engagement, ~${avgViews.toLocaleString()} avg views, latest: "${recentVideoTopic}")`,
      );
      logDetail(
        `  posting: ${postingConsistency}${daysSinceLastUpload !== null ? ` (last upload ${daysSinceLastUpload}d ago)` : ""}`,
      );
      if (inconsistentViews) {
        logDetail(`  ⚠ wildly fluctuating view counts across recent videos — reach may not be a dependable number`);
      }
      for (const [i, v] of recentVideos.entries()) {
        logDetail(
          `    video ${i + 1}/${recentVideos.length}: ${v.views.toLocaleString()} views, ${v.likes.toLocaleString()} likes — "${v.title}"`,
        );
      }
      // allVideoDescriptions (Shorts included) is already-fetched data, no
      // extra quota — scan that before videoDescriptions-only would find.
      let rawContactHints = findContactHints([channel.snippet.description ?? "", ...allVideoDescriptions]);
      // Still nothing? Business emails often only live in older videos than
      // whatever the initial over-fetch reached — worth 2 more quota units
      // to check further back before giving up to manual lookup.
      if (rawContactHints.emails.length === 0 && rawContactHints.links.length === 0 && playlistNextPageToken) {
        try {
          const olderDescriptions = await scanOlderVideosForContactHints(channel.contentDetails.relatedPlaylists.uploads, playlistNextPageToken, 40);
          rawContactHints = findContactHints(olderDescriptions);
          if (rawContactHints.emails.length > 0 || rawContactHints.links.length > 0) {
            logDetail(`  contact: found in older videos beyond the initial sample`);
          }
        } catch {
          // Not worth failing the whole candidate over an optional deeper scan.
        }
      }
      const { emails: rankedEmails, ambiguous: emailAmbiguous } = rankContactEmails(
        rawContactHints.emails,
        rawContactHints.links,
        channel.snippet.title,
      );
      const contactHints = { emails: rankedEmails, links: rawContactHints.links };
      if (contactHints.emails.length > 0) {
        logDetail(
          `  contact: found email(s) in public descriptions — ${contactHints.emails.join(", ")}` +
            (emailAmbiguous ? " (ambiguous — couldn't tell which one is the creator's)" : ""),
        );
      } else if (contactHints.links.length > 0) {
        logDetail(`  contact: no email found, but linked — ${contactHints.links.join(", ")}`);
      } else {
        logDetail(`  contact: nothing found in public descriptions — needs manual lookup`);
      }

      const sponsorBrandsMentioned = findSponsorBrandMentions(videoDescriptions);
      if (sponsorBrandsMentioned.length > 0) {
        logDetail(`  sponsors mentioned in recent videos: ${sponsorBrandsMentioned.join(", ")}`);
      }

      const contactHistory = getContactHistory(channel.id);
      if (contactHistory.contacted) {
        logDetail(
          `  already contacted ${contactHistory.timesContacted}x, last on ${contactHistory.lastContactedAt} — do not re-email`,
        );
      }

      const sanitizedId = channel.id.replace(/[^a-zA-Z0-9.+-]/g, "");
      results.push({
        channelName: channel.snippet.title,
        niche,
        subscribers,
        avgViews,
        engagementRate,
        recentVideoTopic,
        channelId: channel.id,
        placeholderEmail: `outreach-placeholder+${sanitizedId}@example.com`,
        aboutUrl: channelAboutUrl(channel),
        contactHints,
        recentVideos,
        alreadyContacted: contactHistory.contacted,
        lastContactedAt: contactHistory.lastContactedAt,
        postingConsistency,
        daysSinceLastUpload,
        possibleFakeEngagement,
        inconsistentViews,
        emailAmbiguous,
        engagementThresholdApplied,
        sponsorBrandsMentioned,
        suggestedBrandsToOffer: [] as string[], // filled below, once every candidate's mentions are known
      });
    }

    // Course technique: name 1-2 brands in the niche this specific creator
    // hasn't worked with yet, pulled from what OTHER candidates in the same
    // niche pool have mentioned as sponsors — a real, non-fabricated offer
    // instead of a vague "perfect fit" claim.
    const nicheBrandPool = new Set<string>();
    for (const r of results) for (const brand of r.sponsorBrandsMentioned) nicheBrandPool.add(brand);
    for (const r of results) {
      const own = new Set(r.sponsorBrandsMentioned);
      r.suggestedBrandsToOffer = [...nicheBrandPool].filter((b) => !own.has(b)).slice(0, 2);
    }

    // maxCandidates caps the surviving results here, not the input pool
    // above — every unique channel from the search was already evaluated,
    // so this only trims an oversized passing list, never throws away
    // evaluation work that already happened.
    if (results.length > maxCandidates) {
      results.length = maxCandidates;
    }

    logDetail(`final target list: ${results.length} channel(s)`);

    // Record every candidate that passed the filters this run — the
    // Excel/markdown export reads this log, not the tool's return value, so
    // a search run from any entry point (web search box, CLI, the manager
    // agent) ends up in the same place instead of only the caller that
    // happened to ask seeing it.
    await logFoundCandidates(
      results.map((r) => ({
        foundAt: new Date().toISOString(),
        niche: r.niche,
        channelId: r.channelId,
        channelName: r.channelName,
        subscribers: r.subscribers,
        avgViews: r.avgViews,
        engagementRate: r.engagementRate,
        recentVideoTopic: r.recentVideoTopic,
        postingConsistency: r.postingConsistency,
        possibleFakeEngagement: r.possibleFakeEngagement,
        daysSinceLastUpload: r.daysSinceLastUpload,
        inconsistentViews: r.inconsistentViews,
        contactEmail: r.contactHints.emails[0],
        contactLink: r.contactHints.links[0],
        aboutUrl: r.aboutUrl,
        sponsorBrandsMentioned: r.sponsorBrandsMentioned,
        suggestedBrandsToOffer: r.suggestedBrandsToOffer,
      })),
    );

    // Persist this run's rejections so a later search (this sweep's next
    // keyword, or a future day's sweep) can skip these channels before
    // spending quota on them again instead of re-deriving the same verdict.
    await logRejectedCandidates(
      skipped.map((s) => ({
        channelId: s.channelId,
        channelName: s.channelName,
        subscribers: s.subscribers,
        reason: s.reason,
        rejectedAt: new Date().toISOString(),
      })),
    );

    setNode("find-influencers", "done", `${results.length} candidate(s) found`);
    return { results, skipped };
  },
});

// The course's primary organic-discovery method is manual browsing —
// sidebar suggestions, incognito sessions, Instagram follows — which
// produces a channel URL by hand, not a search query. There was previously
// no way to take that URL and run it through the same qualification
// pipeline the search path uses; a pasted channel just had to be manually
// eyeballed. channels.list supports lookup by handle/username/ID for 1
// quota unit (no 100-unit search.list needed), so this runs the exact same
// filters as findInfluencersTool but against one specific channel, and
// reports every reason it passed or failed rather than just the first one —
// useful for a human applying their own judgment on a borderline call.
function parseChannelInput(input: string): { type: "id" | "handle" | "username"; value: string } {
  const trimmed = input.trim();
  const urlMatch = /youtube\.com\/(channel\/(UC[\w-]{22})|@([\w.-]+)|c\/([\w.-]+)|user\/([\w.-]+))/i.exec(trimmed);
  if (urlMatch) {
    if (urlMatch[2]) return { type: "id", value: urlMatch[2] };
    if (urlMatch[3]) return { type: "handle", value: urlMatch[3] };
    // /c/ custom URLs have no direct lookup API — best effort, try it as a
    // handle, which is the modern equivalent for most channels.
    if (urlMatch[4]) return { type: "handle", value: urlMatch[4] };
    if (urlMatch[5]) return { type: "username", value: urlMatch[5] };
  }
  if (/^UC[\w-]{22}$/.test(trimmed)) return { type: "id", value: trimmed };
  if (trimmed.startsWith("@")) return { type: "handle", value: trimmed.slice(1) };
  return { type: "handle", value: trimmed };
}

export const evaluateChannelTool = createTool({
  id: "evaluate-channel",
  description:
    "Takes a YouTube channel URL, @handle, or channel ID (typically found by browsing manually — sidebar " +
    "suggestions, Instagram 'Tagged' posts, incognito sessions) and runs it through the same qualification " +
    "pipeline as find-influencers (subscriber range, tiered engagement floor, avg views, posting consistency, " +
    "fake-engagement detection), reporting every reason it passed or failed. Use this for a specific channel a " +
    "human already found manually, as opposed to find-influencers/find-candidates-for-niche which search for new " +
    "candidates.",
  inputSchema: z.object({
    channelInput: z.string().describe("A YouTube channel URL (any format), @handle, or channel ID"),
    niche: z.string().default("manually evaluated").describe("Niche label to record this channel under, if it passes"),
    minSubscribers: z.number().default(50_000),
    maxSubscribers: z.number().default(500_000),
    minEngagementRate: z.number().default(0.01),
    minAvgViews: z.number().default(50_000),
    videosPerChannel: z.number().default(10),
  }),
  outputSchema: z.object({
    found: z.boolean().describe("Whether a matching YouTube channel was resolved at all"),
    error: z.string().optional(),
    channelId: z.string().optional(),
    channelName: z.string().optional(),
    channelUrl: z.string().optional(),
    passed: z.boolean().optional(),
    reasons: z.array(z.string()).describe("Every reason this channel passed or failed, not just the first"),
    subscribers: z.number().optional(),
    avgViews: z.number().optional(),
    engagementRate: z.number().optional(),
    postingConsistency: z.enum(["consistent", "sporadic", "unknown"]).optional(),
    daysSinceLastUpload: z.number().nullable().optional(),
    possibleFakeEngagement: z.boolean().optional(),
    inconsistentViews: z.boolean().optional(),
    emailAmbiguous: z.boolean().optional(),
    contactHints: z.object({ emails: z.array(z.string()), links: z.array(z.string()) }).optional(),
    recentVideos: z.array(
      z.object({ title: z.string(), views: z.number(), likes: z.number(), comments: z.number(), engagementRate: z.number() }),
    ).optional(),
    sponsorBrandsMentioned: z.array(z.string()).optional(),
    alreadyContacted: z.boolean().optional(),
  }),
  execute: async ({ context }) => {
    const { channelInput, niche, minSubscribers, maxSubscribers, minEngagementRate, minAvgViews, videosPerChannel } = context;

    const parsed = parseChannelInput(channelInput);
    const params: Record<string, string> = { part: "snippet,statistics,contentDetails" };
    if (parsed.type === "id") params.id = parsed.value;
    else if (parsed.type === "handle") params.forHandle = `@${parsed.value}`;
    else params.forUsername = parsed.value;

    const channelData = await youtubeGet<{ items: YouTubeChannel[] }>("channels", params);
    const channel = channelData.items[0];
    if (!channel) {
      return { found: false, error: `No YouTube channel found for "${channelInput}"`, reasons: [] };
    }

    const channelUrl = `https://www.youtube.com/channel/${channel.id}`;
    const subscribers = Number(channel.statistics.subscriberCount ?? 0);
    const reasons: string[] = [];

    if (channel.statistics.hiddenSubscriberCount) {
      reasons.push("subscriber count is hidden");
      return { found: true, channelId: channel.id, channelName: channel.snippet.title, channelUrl, passed: false, reasons };
    }

    if (subscribers < minSubscribers || subscribers > maxSubscribers) {
      reasons.push(`${subscribers.toLocaleString()} subscribers is outside ${minSubscribers.toLocaleString()}–${maxSubscribers.toLocaleString()}`);
    } else {
      reasons.push(`${subscribers.toLocaleString()} subscribers is within range`);
    }

    const videoStats = await getRecentVideoStats(channel.contentDetails.relatedPlaylists.uploads, videosPerChannel);
    const {
      avgViews,
      engagementRate,
      recentVideoTopic,
      recentVideos,
      videoDescriptions,
      allVideoDescriptions,
      playlistNextPageToken,
      postingConsistency,
      daysSinceLastUpload,
      possibleFakeEngagement,
      inconsistentViews,
    } = videoStats;

    if (inconsistentViews) {
      reasons.push("wildly fluctuating view counts across recent videos — reach may not be a dependable number");
    }

    const tierFloor = 0.03;
    const engagementThresholdApplied = Math.max(minEngagementRate, tierFloor);
    if (engagementRate < engagementThresholdApplied) {
      reasons.push(`engagement ${(engagementRate * 100).toFixed(2)}% below ${(engagementThresholdApplied * 100).toFixed(2)}% minimum for this subscriber tier`);
    } else {
      reasons.push(`engagement ${(engagementRate * 100).toFixed(2)}% meets the ${(engagementThresholdApplied * 100).toFixed(2)}% bar`);
    }

    if (possibleFakeEngagement) {
      reasons.push("possible fake/bought engagement — comment rate far below what real engagement of this size implies");
    }

    if (postingConsistency === "sporadic") {
      reasons.push(`sporadic posting${daysSinceLastUpload !== null ? ` — last upload ${daysSinceLastUpload}d ago` : ""}, not a reliable campaign partner`);
    } else if (postingConsistency === "consistent") {
      reasons.push("posting consistency looks reliable");
    } else {
      reasons.push("not enough upload history to judge posting consistency");
    }

    if (avgViews < minAvgViews) {
      reasons.push(`avg views ${avgViews.toLocaleString()} below ${minAvgViews.toLocaleString()} minimum`);
    } else {
      reasons.push(`avg views ${avgViews.toLocaleString()} meets the ${minAvgViews.toLocaleString()} minimum`);
    }

    const passed =
      subscribers >= minSubscribers &&
      subscribers <= maxSubscribers &&
      engagementRate >= engagementThresholdApplied &&
      !possibleFakeEngagement &&
      postingConsistency !== "sporadic" &&
      avgViews >= minAvgViews;

    let rawContactHints = findContactHints([channel.snippet.description ?? "", ...allVideoDescriptions]);
    if (rawContactHints.emails.length === 0 && rawContactHints.links.length === 0 && playlistNextPageToken) {
      try {
        const olderDescriptions = await scanOlderVideosForContactHints(channel.contentDetails.relatedPlaylists.uploads, playlistNextPageToken, 40);
        rawContactHints = findContactHints(olderDescriptions);
      } catch {
        // Not worth failing the evaluation over an optional deeper scan.
      }
    }
    const { emails: rankedEmails, ambiguous: emailAmbiguous } = rankContactEmails(
      rawContactHints.emails,
      rawContactHints.links,
      channel.snippet.title,
    );
    const contactHints = { emails: rankedEmails, links: rawContactHints.links };
    const sponsorBrandsMentioned = findSponsorBrandMentions(videoDescriptions);
    const contactHistory = getContactHistory(channel.id);

    if (passed) {
      await logFoundCandidates([
        {
          foundAt: new Date().toISOString(),
          niche,
          channelId: channel.id,
          channelName: channel.snippet.title,
          subscribers,
          avgViews,
          engagementRate,
          recentVideoTopic,
          postingConsistency,
          possibleFakeEngagement,
          daysSinceLastUpload,
          inconsistentViews,
          contactEmail: contactHints.emails[0],
          contactLink: contactHints.links[0],
          aboutUrl: channelAboutUrl(channel),
          sponsorBrandsMentioned,
          suggestedBrandsToOffer: [],
        },
      ]);
    } else {
      await logRejectedCandidates([
        {
          channelId: channel.id,
          channelName: channel.snippet.title,
          subscribers,
          reason: reasons.join("; "),
          rejectedAt: new Date().toISOString(),
        },
      ]);
    }

    return {
      found: true,
      channelId: channel.id,
      channelName: channel.snippet.title,
      channelUrl,
      passed,
      reasons,
      subscribers,
      avgViews,
      engagementRate,
      postingConsistency,
      daysSinceLastUpload,
      possibleFakeEngagement,
      inconsistentViews,
      emailAmbiguous,
      contactHints,
      recentVideos,
      sponsorBrandsMentioned,
      alreadyContacted: contactHistory.contacted,
    };
  },
});
