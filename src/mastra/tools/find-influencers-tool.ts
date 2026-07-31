import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { setNode, logDetail } from "../../viz/graph";
import { consumeQuota, sleep } from "./youtube-quota";
import { getContactHistory } from "../../tracking/outreach-log";

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
  snippet: { title: string; description: string };
  statistics: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails: { relatedPlaylists: { uploads: string } };
}

interface YouTubePlaylistItem {
  contentDetails: { videoId: string };
  snippet: { title: string; publishedAt: string };
}

interface YouTubeVideoStats {
  id: string;
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
  snippet: { description: string };
}

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
  const playlistData = await youtubeGet<{ items: YouTubePlaylistItem[] }>("playlistItems", {
    part: "contentDetails,snippet",
    playlistId: uploadsPlaylistId,
    maxResults: String(maxVideos),
  });

  const videoIds = playlistData.items.map((item) => item.contentDetails.videoId);
  if (videoIds.length === 0) {
    return {
      avgViews: 0,
      engagementRate: 0,
      recentVideoTopic: "",
      recentVideos: [] as RecentVideoBreakdown[],
      videoDescriptions: [] as string[],
      postingConsistency: "unknown" as const,
      daysSinceLastUpload: null as number | null,
      possibleFakeEngagement: false,
    };
  }

  const videoData = await youtubeGet<{ items: YouTubeVideoStats[] }>("videos", {
    part: "statistics,snippet",
    id: videoIds.join(","),
  });

  const titleById = new Map(playlistData.items.map((item) => [item.contentDetails.videoId, item.snippet.title]));

  const recentVideos: RecentVideoBreakdown[] = videoData.items.map((video) => {
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

  const videoDescriptions = videoData.items.map((v) => v.snippet.description ?? "");

  const totalViews = recentVideos.reduce((sum, v) => sum + v.views, 0);
  const totalEngagement = recentVideos.reduce((sum, v) => sum + v.engagementRate, 0);

  const avgViews = Math.round(totalViews / recentVideos.length);
  const engagementRate = totalEngagement / recentVideos.length;
  const recentVideoTopic = playlistData.items[0]?.snippet.title ?? "";

  const { postingConsistency, daysSinceLastUpload } = computePostingConsistency(
    playlistData.items.map((item) => item.snippet.publishedAt).filter(Boolean),
  );

  // Course red flag: "less than 1% comments... bot followers, AI comments."
  // Bought/fake engagement typically inflates likes far more than comments
  // (comments are harder to fake convincingly at scale), so a suspiciously
  // low comment-to-view ratio alongside otherwise-normal-looking engagement
  // is the tell, not raw engagement rate alone.
  const totalCommentRate = recentVideos.reduce((sum, v) => (v.views > 0 ? sum + v.comments / v.views : sum), 0);
  const avgCommentRate = totalCommentRate / recentVideos.length;
  const possibleFakeEngagement = engagementRate >= 0.01 && avgCommentRate < 0.001;

  return {
    avgViews,
    engagementRate,
    recentVideoTopic,
    recentVideos,
    videoDescriptions,
    postingConsistency,
    daysSinceLastUpload,
    possibleFakeEngagement,
  };
}

export const findInfluencersTool = createTool({
  id: "find-influencers",
  description:
    "Searches real YouTube channels for a niche via the YouTube Data API v3, then filters by subscriber count and computed engagement rate from their recent uploads.",
  inputSchema: z.object({
    niche: z.string().describe("Niche keyword to search, e.g. 'halal fitness' or 'personal finance'"),
    minSubscribers: z.number().default(50_000),
    maxSubscribers: z.number().default(1_000_000),
    minEngagementRate: z
      .number()
      .default(0.01)
      .describe(
        "Floor for the engagement-rate bar — the actual bar used per candidate is the higher of this " +
          "and a subscriber-size-based tier (course rule: smaller creators need 3-8% engagement, 1M+ " +
          "subscriber accounts are healthy at ~3%), so a small/hollow channel can't sneak through on a " +
          "loose flat threshold.",
      ),
    minAvgViews: z
      .number()
      .default(50_000)
      .describe(
        "Minimum average views across recent videos — catches channels with a large but inactive/stale " +
          "subscriber base whose real reach is much smaller than their follower count suggests",
      ),
    maxCandidates: z.number().default(5).describe("How many channels to search before filtering"),
    videosPerChannel: z.number().default(10).describe("Recent videos to sample for avg views / engagement / sponsor scan"),
    useIntitleOperator: z
      .boolean()
      .default(true)
      .describe(
        "Search by video (intitle:<niche>) instead of channel name — YouTube's channel search only " +
          "matches well-known channel names/descriptions and keeps surfacing the same big accounts. " +
          "Searching video titles with the intitle: operator surfaces smaller, more specific channels " +
          "the same way the course's manual long-tail-keyword method does.",
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
  }),
  execute: async ({ context }) => {
    const {
      niche,
      minSubscribers,
      maxSubscribers,
      minEngagementRate,
      minAvgViews,
      maxCandidates,
      videosPerChannel,
      useIntitleOperator,
      uploadedWithinDays,
    } = context;

    setNode("find-influencers", "active", `searching "${niche}"`);

    // Search by video, not by channel name: channel search only matches
    // known channel titles/descriptions and keeps resurfacing the same big
    // names. Searching video titles (optionally with intitle:) and pulling
    // the channelId off each result surfaces smaller, more specific
    // channels — the API equivalent of the course's long-tail-keyword +
    // intitle: manual technique.
    const searchParams: Record<string, string> = {
      part: "snippet",
      type: "video",
      q: useIntitleOperator ? `intitle:${niche}` : niche,
      // Over-fetch videos since multiple results often land on the same
      // channel — we need enough unique channelIds to fill maxCandidates.
      maxResults: String(Math.min(maxCandidates * 5, 50)),
    };
    if (uploadedWithinDays !== undefined) {
      searchParams.order = "date";
      searchParams.publishedAfter = new Date(Date.now() - uploadedWithinDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const searchData = await youtubeGet<{ items: YouTubeSearchItem[] }>("search", searchParams);

    const seen = new Set<string>();
    const channelIds: string[] = [];
    for (const item of searchData.items) {
      const id = item.snippet?.channelId ?? item.id.channelId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      channelIds.push(id);
      if (channelIds.length >= maxCandidates) break;
    }

    if (channelIds.length === 0) {
      setNode("find-influencers", "done", "0 candidates found");
      return { results: [] };
    }

    const channelData = await youtubeGet<{ items: YouTubeChannel[] }>("channels", {
      part: "snippet,statistics,contentDetails",
      id: channelIds.join(","),
    });

    logDetail(`"${niche}" — ${channelData.items.length} channel(s) from search:`);

    const results = [];
    for (const channel of channelData.items) {
      const subscribers = Number(channel.statistics.subscriberCount ?? 0);
      const label = `${channel.snippet.title} (${subscribers.toLocaleString()} subs)`;

      if (channel.statistics.hiddenSubscriberCount) {
        logDetail(`${label} — SKIPPED (subscriber count hidden)`);
        continue;
      }
      if (subscribers < minSubscribers || subscribers > maxSubscribers) {
        logDetail(`${label} — SKIPPED (outside ${minSubscribers.toLocaleString()}–${maxSubscribers.toLocaleString()} range)`);
        continue;
      }

      const {
        avgViews,
        engagementRate,
        recentVideoTopic,
        recentVideos,
        videoDescriptions,
        postingConsistency,
        daysSinceLastUpload,
        possibleFakeEngagement,
      } = await getRecentVideoStats(channel.contentDetails.relatedPlaylists.uploads, videosPerChannel);

      // Course rule: "3-8% on smaller creators, 3% is healthy at 1M+ views."
      // A flat threshold lets small/hollow channels through on a loose bar
      // while being needlessly strict on legitimately large accounts, so
      // scale the floor with subscriber size and use the caller's
      // minEngagementRate only as an additional (never lower) floor.
      const tierFloor = subscribers >= 1_000_000 ? 0.03 : subscribers >= 250_000 ? 0.035 : 0.04;
      const engagementThresholdApplied = Math.max(minEngagementRate, tierFloor);

      if (engagementRate < engagementThresholdApplied) {
        logDetail(
          `${label} — SKIPPED (engagement ${(engagementRate * 100).toFixed(2)}% below ${(engagementThresholdApplied * 100).toFixed(2)}% minimum for this subscriber tier)`,
        );
        continue;
      }
      if (possibleFakeEngagement) {
        logDetail(`${label} — SKIPPED (possible fake/bought engagement — comment rate far below what real engagement of this size implies)`);
        continue;
      }

      if (avgViews < minAvgViews) {
        logDetail(
          `${label} — SKIPPED (avg views ${avgViews.toLocaleString()} below ${minAvgViews.toLocaleString()} minimum)`,
        );
        continue;
      }

      logDetail(
        `${label} — TARGETED (${(engagementRate * 100).toFixed(2)}% engagement, ~${avgViews.toLocaleString()} avg views, latest: "${recentVideoTopic}")`,
      );
      logDetail(
        `  posting: ${postingConsistency}${daysSinceLastUpload !== null ? ` (last upload ${daysSinceLastUpload}d ago)` : ""}`,
      );
      for (const [i, v] of recentVideos.entries()) {
        logDetail(
          `    video ${i + 1}/${recentVideos.length}: ${v.views.toLocaleString()} views, ${v.likes.toLocaleString()} likes — "${v.title}"`,
        );
      }
      const contactHints = findContactHints([channel.snippet.description ?? "", ...videoDescriptions]);
      if (contactHints.emails.length > 0) {
        logDetail(`  contact: found email(s) in public descriptions — ${contactHints.emails.join(", ")}`);
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
        contactHints,
        recentVideos,
        alreadyContacted: contactHistory.contacted,
        lastContactedAt: contactHistory.lastContactedAt,
        postingConsistency,
        daysSinceLastUpload,
        possibleFakeEngagement,
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

    logDetail(`final target list: ${results.length} channel(s)`);

    setNode("find-influencers", "done", `${results.length} candidate(s) found`);
    return { results };
  },
});
