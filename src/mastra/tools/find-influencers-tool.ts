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
  id: { channelId: string };
}

interface YouTubeChannel {
  id: string;
  snippet: { title: string; description: string };
  statistics: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails: { relatedPlaylists: { uploads: string } };
}

interface YouTubePlaylistItem {
  contentDetails: { videoId: string };
  snippet: { title: string };
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

async function youtubeGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is not set in the environment (.env).");
  }

  // Guard the daily quota before spending it, and space out requests so we
  // don't fire a burst of calls back-to-back.
  consumeQuota(ENDPOINT_COST[path] ?? 1);
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

  return { avgViews, engagementRate, recentVideoTopic, recentVideos, videoDescriptions };
}

export const findInfluencersTool = createTool({
  id: "find-influencers",
  description:
    "Searches real YouTube channels for a niche via the YouTube Data API v3, then filters by subscriber count and computed engagement rate from their recent uploads.",
  inputSchema: z.object({
    niche: z.string().describe("Niche keyword to search, e.g. 'halal fitness' or 'personal finance'"),
    minSubscribers: z.number().default(50_000),
    maxSubscribers: z.number().default(1_000_000),
    minEngagementRate: z.number().default(0.01),
    minAvgViews: z
      .number()
      .default(50_000)
      .describe(
        "Minimum average views across recent videos — catches channels with a large but inactive/stale " +
          "subscriber base whose real reach is much smaller than their follower count suggests",
      ),
    maxCandidates: z.number().default(5).describe("How many channels to search before filtering"),
    videosPerChannel: z.number().default(10).describe("Recent videos to sample for avg views / engagement / sponsor scan"),
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
    } = context;

    setNode("find-influencers", "active", `searching "${niche}"`);

    const searchData = await youtubeGet<{ items: YouTubeSearchItem[] }>("search", {
      part: "snippet",
      type: "channel",
      q: niche,
      maxResults: String(maxCandidates),
    });

    const channelIds = searchData.items.map((item) => item.id.channelId).filter(Boolean);
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

      const { avgViews, engagementRate, recentVideoTopic, recentVideos, videoDescriptions } = await getRecentVideoStats(
        channel.contentDetails.relatedPlaylists.uploads,
        videosPerChannel,
      );

      if (engagementRate < minEngagementRate) {
        logDetail(
          `${label} — SKIPPED (engagement ${(engagementRate * 100).toFixed(2)}% below ${(minEngagementRate * 100).toFixed(2)}% minimum)`,
        );
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
      });
    }

    logDetail(`final target list: ${results.length} channel(s)`);

    setNode("find-influencers", "done", `${results.length} candidate(s) found`);
    return { results };
  },
});
