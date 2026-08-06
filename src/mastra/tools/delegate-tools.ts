import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { followupAgent } from "../agents/followup-agent";
import { negotiationAgent } from "../agents/negotiation-agent";
import { supervisorAgent } from "../agents/supervisor-agent";
import { sanitizeHumanText } from "../../utils/sanitize-text";
import { getAllContactedCreators, getFollowUpQueue, getLastSendInfo, getNegotiationState } from "../../tracking/outreach-log";
import { getLastReplyBody } from "../../gmail/check-replies";
import { computeBaselineViews, evaluateQuote, estimateFairPrice } from "../../pricing/cpm-calculator";
import { findInfluencersTool } from "./find-influencers-tool";
import { runTool } from "../../utils/run-tool";
import { expandNiche } from "../niche-keywords";
import { syncTrackingSheetIfConfigured } from "../../tracking/google-sheet-sync";

// Lets the manager agent actually delegate to the drafting-side agents by
// name ("tell the follow-up agent to nudge X", "reply to Y") instead of only
// reporting status. Both tools here run the real followup-agent /
// negotiation-agent + supervisor-agent pipeline underneath — same drafting
// and review logic the web UI's Follow-ups tab and Influencer "Draft reply"
// button use — but neither one sends. That boundary is deliberate: a stray
// "go ahead and send that" in casual chat should never turn into a real
// Gmail send, same reasoning as excluding sender-agent from chat entirely.
// The human still clicks Send in the UI after reading the draft here.

const MAX_DRAFT_ATTEMPTS = 2;

function findCreatorMatches(name: string) {
  const lower = name.toLowerCase();
  return getAllContactedCreators().filter((c) => c.channelName.toLowerCase().includes(lower));
}

export const draftFollowUpForCreatorTool = createTool({
  id: "draft-followup-for-creator",
  description:
    "Drafts (does NOT send) a follow-up nudge for a creator who hasn't replied yet, found by name in the real " +
    "follow-up queue — it looks up which follow-up number and light/heavy weight applies automatically. Returns " +
    "the drafted text for a human to review and send from the Follow-ups tab.",
  inputSchema: z.object({ creatorName: z.string().describe("Full or partial creator name to look up") }),
  outputSchema: z.object({
    status: z.enum(["drafted", "not-found", "ambiguous", "not-due"]),
    body: z.string().optional(),
    channelName: z.string().optional(),
    to: z.string().optional(),
    followUpNumber: z.number().optional(),
    weight: z.string().optional(),
    candidates: z.array(z.string()).optional(),
  }),
  execute: async ({ context }) => {
    const queue = getFollowUpQueue();
    const lower = context.creatorName.toLowerCase();
    const matches = queue.filter((c) => c.channelName.toLowerCase().includes(lower));

    if (matches.length === 0) {
      return { status: "not-found" as const, candidates: queue.map((c) => c.channelName) };
    }
    if (matches.length > 1) {
      return { status: "ambiguous" as const, candidates: matches.map((c) => c.channelName) };
    }

    const candidate = matches[0];
    if (!candidate.due) {
      return { status: "not-due" as const, channelName: candidate.channelName };
    }

    const draftResult = await followupAgent.generate(
      `Channel/contact: ${candidate.channelName}\nNiche: ${candidate.niche}\n` +
        `Follow-up number: ${candidate.followUpNumber}\nWeight: ${candidate.weight.toUpperCase()}`,
    );
    const bodyMatch = draftResult.text.match(/BODY:\s*([\s\S]+)/);
    const body = sanitizeHumanText(bodyMatch?.[1]?.trim() ?? draftResult.text.trim());

    return {
      status: "drafted" as const,
      body,
      channelName: candidate.channelName,
      to: candidate.to,
      followUpNumber: candidate.followUpNumber,
      weight: candidate.weight,
    };
  },
});

export const draftReplyForCreatorTool = createTool({
  id: "draft-reply-for-creator",
  description:
    "Drafts (does NOT send) a reply to a creator who already responded, found by name. By default, automatically " +
    "pulls their actual latest Gmail message; if that can't be reached (e.g. the message was quoted directly by " +
    "the user, or the Gmail thread isn't accessible under the currently authorized account), pass creatorMessage " +
    "with the exact text the user gave you instead of guessing or giving up. Runs the message through the " +
    "negotiation agent + supervisor review, using CPM math if a price/view-count/engagement figure is given. " +
    "Returns the drafted text for a human to review and send from that creator's row in the Influencers tab.",
  inputSchema: z.object({
    creatorName: z.string().describe("Full or partial creator name to look up"),
    creatorMessage: z
      .string()
      .optional()
      .describe(
        "The creator's actual message, if the user already typed/pasted it in chat — use this instead of " +
          "auto-fetching from Gmail when the user has directly quoted what the creator said.",
      ),
    quotedPrice: z.number().optional().describe("Price the creator quoted, if known"),
    viewCounts: z.array(z.number()).optional().describe("Recent video view counts, for CPM baseline"),
    engagementRate: z.number().optional().describe("Engagement rate as a decimal, e.g. 0.04"),
  }),
  outputSchema: z.object({
    status: z.enum(["drafted", "not-found", "ambiguous", "no-thread", "no-reply-found", "gmail-unreachable"]),
    body: z.string().optional(),
    action: z.string().optional(),
    approved: z.boolean().optional(),
    reviewNote: z.string().optional(),
    channelName: z.string().optional(),
    to: z.string().optional(),
    candidates: z.array(z.string()).optional(),
  }),
  execute: async ({ context }) => {
    const matches = findCreatorMatches(context.creatorName);
    if (matches.length === 0) {
      return { status: "not-found" as const, candidates: getAllContactedCreators().map((c) => c.channelName) };
    }
    if (matches.length > 1) {
      return { status: "ambiguous" as const, candidates: matches.map((c) => c.channelName) };
    }

    const creator = matches[0];
    const lastSend = getLastSendInfo(creator.channelId);

    let replyBody: string;
    if (context.creatorMessage) {
      // The user already told us what the creator said — no need to touch
      // Gmail at all, and this also works for creators whose real thread
      // predates a Gmail account switch (recorded under a different
      // mailbox than the one currently authorized, so it's unreachable).
      replyBody = context.creatorMessage;
    } else {
      if (!lastSend?.gmailThreadId) {
        return { status: "no-thread" as const, channelName: creator.channelName };
      }
      let reply: Awaited<ReturnType<typeof getLastReplyBody>>;
      try {
        reply = await getLastReplyBody(lastSend.gmailThreadId);
      } catch {
        // A thread ID recorded under a different Gmail account than the one
        // currently authorized returns a raw "not found" from the Gmail
        // API — that's not a real error to surface, it just means this
        // specific thread can't be auto-fetched right now.
        return { status: "gmail-unreachable" as const, channelName: creator.channelName };
      }
      if (!reply) {
        return { status: "no-reply-found" as const, channelName: creator.channelName };
      }
      replyBody = reply.body;
    }

    const { quotedPrice, viewCounts, engagementRate } = context;
    const baselineViews = viewCounts && viewCounts.length > 0 ? computeBaselineViews(viewCounts.map((v) => ({ views: v }))) : 0;

    let pricingContext: string;
    if (quotedPrice !== undefined && baselineViews > 0) {
      const evaluation = evaluateQuote(quotedPrice, baselineViews, creator.niche, { engagementRate });
      pricingContext =
        `Quoted price: ${quotedPrice}\nBaseline views: ${baselineViews.toLocaleString()}\n` +
        `Implied CPM: ${evaluation.impliedCpm}\nBenchmark CPM range: ${evaluation.benchmarkRange.min}-${evaluation.benchmarkRange.max}\n` +
        `Verdict: ${evaluation.verdict}\nSuggested counter range: ${evaluation.suggestedCounterRange.min}-${evaluation.suggestedCounterRange.max}`;
    } else if (baselineViews > 0) {
      const fair = estimateFairPrice(baselineViews, creator.niche);
      pricingContext = `No price quoted yet. Baseline views: ${baselineViews.toLocaleString()}\nEstimated fair price range: ${fair.price.min}-${fair.price.max}`;
    } else {
      pricingContext = "No view data provided — no CPM evaluation available for this reply.";
    }

    const state = getNegotiationState(creator.channelId, creator.channelName);
    const round = state.negotiationRound + 1;

    // Course technique ("Using Analytics as Leverage") — see server.ts's
    // /api/negotiate/draft for the full reasoning: a real, human-checked
    // audience demographic note is negotiating ground, same as CPM.
    if (state.audienceNote) {
      pricingContext += `\nAudience note (from a real media kit check): ${state.audienceNote}`;
    }
    if (process.env.AGENCY_SERVICES_OFFERED) {
      pricingContext += `\nServices this agency can offer beyond the intro (only relevant if negotiating with an agency contact): ${process.env.AGENCY_SERVICES_OFFERED}`;
    }

    let feedback = "";
    let body = "";
    let action = "";
    let approved = false;
    let reviewNote = "";

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const draftPrompt =
        `Creator's message: ${replyBody}\nChannel: ${creator.channelName}\nNiche: ${creator.niche}\n` +
        `Negotiation round: ${round}\n${pricingContext}` +
        (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");
      const draftResult = await negotiationAgent.generate(draftPrompt);
      const bodyMatch = draftResult.text.match(/BODY:\s*([\s\S]+?)(?:\nACTION:|$)/);
      const actionMatch = draftResult.text.match(/ACTION:\s*(\S+)/);
      body = sanitizeHumanText(bodyMatch?.[1]?.trim() ?? draftResult.text.trim());
      action = actionMatch?.[1]?.trim() ?? "counter_price";

      const reviewResult = await supervisorAgent.generate(
        `Channel: ${creator.channelName}\nNiche: ${creator.niche}\nRecipient: ${creator.to}\n` +
          `Negotiation round: ${round}\n${pricingContext}\nBody: ${body}`,
      );
      const decision = /DECISION:\s*(APPROVE|REVISE)/i.exec(reviewResult.text)?.[1]?.toUpperCase();
      const fb = /FEEDBACK:\s*([\s\S]+)/i.exec(reviewResult.text)?.[1]?.trim();

      if (decision === "APPROVE") {
        approved = true;
        reviewNote = attempt === 1 ? "Approved by supervisor on first pass." : `Approved after ${attempt} attempts.`;
        break;
      }
      feedback = fb ?? "Rewrite to follow the negotiation rules more closely.";
      reviewNote = `Supervisor requested a revision: ${feedback}`;
    }

    return { status: "drafted" as const, body, action, approved, reviewNote, channelName: creator.channelName, to: creator.to };
  },
});

// Runs the real YouTube discovery search, following the course's own
// "Best Way of Finding Influencers Organically" lesson end to end instead of
// just its first step:
//
// Step 1 (long-tail keywords): a broad niche ("cybersecurity") is expanded
// in code (niche-keywords.ts) into the course's real long-tail keyword list
// and searched once per keyword — the same broad term used to run exactly
// one generic search and keep resurfacing the same handful of giant
// channels. This can't be left to the agent to do itself by issuing 10
// separate tool calls: that depends on the model remembering and correctly
// re-issuing the whole list every time, which is exactly the kind of thing
// that's been observed to silently drop keywords under load.
//
// Step 3 (intitle: vs quotes): each keyword search runs in "intitle" mode
// (find-influencers-tool's default) — the lesson's own demo shows this
// alone already surfaces smaller channels a plain search misses.
//
// Step 2 (copy a found title, search it again): after the keyword sweep,
// the top few candidates just found (by engagement) have their actual
// recent video title re-searched as an exact quoted phrase — the lesson's
// second organic-discovery technique, "once you find a video from a small
// creator in your niche, copy the video title and search it again... you'll
// often find smaller channels in the results." This surfaces channels the
// keyword list alone wouldn't, without needing the user to manually watch
// videos and copy titles by hand.
const TITLE_ECHO_ROUNDS = 5;

export const findCandidatesForNicheTool = createTool({
  id: "find-candidates-for-niche",
  description:
    "Searches real YouTube channels for a niche via the YouTube Data API, filtered by the course's qualification " +
    "rules (50k-500k subscribers, tiered minimum engagement rate, minimum average views). For niches with a known " +
    "long-tail keyword set (e.g. 'cybersecurity'), automatically searches every keyword in that set (intitle: " +
    "mode), then re-searches the top few results' own video titles as exact quoted phrases to surface similar " +
    "smaller channels (the course's 'copy the title and search again' technique) — the full organic-discovery " +
    "method from the lesson, not just one generic search. Returns real candidates only — never invents names. " +
    "Use this whenever asked to find/discover new influencers in a niche, as opposed to drafting to someone " +
    "already in the tracking data.",
  inputSchema: z.object({
    niche: z.string().describe("Niche to search, e.g. 'cybersecurity', 'insulin resistance', or 'personal finance'"),
  }),
  outputSchema: z.object({
    count: z.number(),
    searchedKeywords: z.array(z.string()),
    titleEchoSearches: z.array(z.string()).describe("Video titles from top early results that were re-searched as exact phrases (step 2 of the course method)"),
    failedKeywords: z.array(z.string()).describe("Keywords that errored out (e.g. transient API failure) and were skipped, not silently dropped"),
    candidates: z.array(
      z.object({
        channelName: z.string(),
        subscribers: z.number(),
        avgViews: z.number(),
        engagementRate: z.number(),
        contactEmail: z.string().optional(),
        foundVia: z.string(),
        sponsorBrandsMentioned: z.array(z.string()).describe("Real brands scanned from this creator's own video descriptions — sponsors they've already worked with, not a suggestion"),
        suggestedBrandsToOffer: z.array(z.string()).describe("Brands seen elsewhere in this niche's pool that this creator has NOT worked with — a real (non-fabricated) starting point for the outreach offer"),
      }),
    ),
  }),
  execute: async ({ context }) => {
    interface CandidateAcc {
      channelId: string;
      channelName: string;
      subscribers: number;
      avgViews: number;
      engagementRate: number;
      recentVideoTopic: string;
      contactEmail: string | undefined;
      foundVia: string;
      sponsorBrandsMentioned: string[];
      suggestedBrandsToOffer: string[];
    }

    const keywords = expandNiche(context.niche);
    const byChannelId = new Map<string, CandidateAcc>();
    const candidatesAcc: CandidateAcc[] = [];
    const failedKeywords: string[] = [];

    async function runSearch(query: string, searchMode: "intitle" | "quotes", foundVia: string) {
      let result: Awaited<ReturnType<typeof findInfluencersTool.execute>>;
      try {
        result = await runTool(findInfluencersTool, {
          niche: query,
          minSubscribers: 50_000,
          maxSubscribers: 500_000,
          minEngagementRate: 0.01,
          minAvgViews: 50_000,
          maxCandidates: 20,
          videosPerChannel: 10,
          searchMode,
        });
      } catch (err: any) {
        // A transient YouTube API error (e.g. a 503) on one keyword out of
        // several used to abort the entire sweep — the rest, and whatever
        // they'd already found, were lost along with it. Skip just this
        // one and keep going; report it as failed rather than silently
        // dropping it.
        failedKeywords.push(query);
        return;
      }

      for (const r of result.results) {
        if (byChannelId.has(r.channelId)) continue;
        const entry: CandidateAcc = {
          channelId: r.channelId,
          channelName: r.channelName,
          subscribers: r.subscribers,
          avgViews: r.avgViews,
          engagementRate: r.engagementRate,
          recentVideoTopic: r.recentVideoTopic,
          contactEmail: r.contactHints.emails[0],
          foundVia,
          sponsorBrandsMentioned: r.sponsorBrandsMentioned,
          suggestedBrandsToOffer: r.suggestedBrandsToOffer,
        };
        byChannelId.set(r.channelId, entry);
        candidatesAcc.push(entry);
      }
    }

    for (const keyword of keywords) {
      await runSearch(keyword, "intitle", keyword);
    }

    // Step 2: copy the title from the strongest early results and search it
    // again as an exact phrase. Picking by engagement (not just "first
    // found") targets the candidates most likely to have genuinely similar
    // peers, rather than an arbitrary early match.
    const titleEchoSearches: string[] = [];
    const topByEngagement = [...candidatesAcc].sort((a, b) => b.engagementRate - a.engagementRate).slice(0, TITLE_ECHO_ROUNDS);
    for (const candidate of topByEngagement) {
      if (!candidate.recentVideoTopic || titleEchoSearches.includes(candidate.recentVideoTopic)) continue;
      titleEchoSearches.push(candidate.recentVideoTopic);
      await runSearch(candidate.recentVideoTopic, "quotes", `similar to "${candidate.recentVideoTopic}" (${candidate.channelName})`);
    }

    await syncTrackingSheetIfConfigured();

    return {
      count: candidatesAcc.length,
      searchedKeywords: keywords,
      titleEchoSearches,
      failedKeywords,
      candidates: candidatesAcc.map(({ channelId, recentVideoTopic, ...rest }) => rest),
    };
  },
});
