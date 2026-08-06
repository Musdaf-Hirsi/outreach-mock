import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getMilestoneStatus,
  getFollowUpQueue,
  getCheckInsDue,
  getAllContactedCreators,
  getExclusivityCandidates,
  getNeedinessSignals,
} from "../../tracking/outreach-log";
import { getAllFoundCandidatesDeduped } from "../../tracking/found-candidates-log";

// Read-only snapshot of the real tracking data every other agent in this
// app is blind to when chatted with directly — the manager agent is the
// only one bound to this, so it's the only one that can actually answer
// "how are we doing" or "what's next" instead of talking in a vacuum. No
// write/send tool is bound here on purpose: this agent advises, it never
// acts (drafting/sending/negotiating stays with the specialized agents and
// their supervisor-reviewed flows).
export const agencyStatusTool = createTool({
  id: "get-agency-status",
  description:
    "Returns a full live snapshot of the real outreach program: milestone/pace status, the follow-up queue " +
    "(due now, not yet due, needs a fresh thread), post-close check-ins due, every creator ever contacted with " +
    "their platform, niche, deal status, and reply state, and every real candidate ever found by a search " +
    "(find-candidates-for-niche / the web UI's Search box) that hasn't been contacted yet — the 'Found " +
    "Candidates' list from Influencers.xlsx / the tracking sheet, and every creator who has completed 2+ real " +
    "deals on the discount path and hasn't been moved to an exclusive-management relationship yet (course " +
    "technique: 'The 2 Different Paths' — revisit exclusivity after a few successful discount deals).",
  inputSchema: z.object({}),
  outputSchema: z.object({
    milestone: z.object({
      programDay: z.number(),
      totalOutreaches: z.number(),
      outreachesToday: z.number(),
      placeholderCount: z.number(),
      phase: z.string(),
      phaseTarget: z.number(),
      phaseProgress: z.number(),
      onTrack: z.boolean(),
    }),
    followUps: z.object({
      dueNow: z.array(z.object({ channelName: z.string(), niche: z.string(), followUpNumber: z.number(), weight: z.string() })),
      notYetDueCount: z.number(),
      needsNewThread: z.array(z.object({ channelName: z.string(), niche: z.string() })),
    }),
    checkInsDue: z.array(z.object({ channelName: z.string(), dealStatus: z.string(), checkInsSent: z.number() })),
    creators: z.array(
      z.object({
        channelName: z.string(),
        platform: z.string(),
        niche: z.string(),
        dealStatus: z.string(),
        replied: z.boolean(),
        timesContacted: z.number(),
        lastContactedAt: z.string(),
      }),
    ),
    foundCandidatesNotYetContacted: z.array(
      z.object({
        channelName: z.string(),
        channelUrl: z.string(),
        niches: z.array(z.string()),
        subscribers: z.number(),
        avgViews: z.number(),
        engagementRate: z.number(),
        contactEmail: z.string().optional(),
      }),
    ),
    exclusivityCandidates: z.array(z.object({ channelName: z.string(), dealsCompleted: z.number() })),
    needinessSignals: z.array(z.object({ channelName: z.string(), inboundCheckInsReceived: z.number() })).describe(
      "Closed creators who have followed up unprompted 3+ times since close — course technique: a real signal, " +
        "usable as leverage in a future repricing conversation.",
    ),
  }),
  execute: async () => {
    const milestone = getMilestoneStatus();
    const queue = getFollowUpQueue();
    const checkIns = getCheckInsDue();
    const creators = getAllContactedCreators();
    // Match by channelId, not channelName — a renamed channel, or two
    // different channels that happen to share a display name, silently
    // broke this when it matched on name (a contacted creator could keep
    // showing up in "found but not contacted," or an unrelated found
    // candidate could get hidden because it shares a name with someone
    // already contacted).
    const contactedIds = new Set(creators.map((c) => c.channelId));
    const found = getAllFoundCandidatesDeduped().filter((c) => !contactedIds.has(c.channelId));
    const exclusivityCandidates = getExclusivityCandidates();
    const needinessSignals = getNeedinessSignals();

    return {
      milestone,
      followUps: {
        dueNow: queue
          .filter((c) => c.due)
          .map((c) => ({ channelName: c.channelName, niche: c.niche, followUpNumber: c.followUpNumber, weight: c.weight })),
        notYetDueCount: queue.filter((c) => !c.due && !c.needsNewThread).length,
        needsNewThread: queue.filter((c) => c.needsNewThread).map((c) => ({ channelName: c.channelName, niche: c.niche })),
      },
      checkInsDue: checkIns.filter((c) => c.due).map((c) => ({ channelName: c.channelName, dealStatus: c.dealStatus, checkInsSent: c.checkInsSent })),
      creators: creators.map((c) => ({
        channelName: c.channelName,
        platform: c.platform,
        niche: c.niche,
        dealStatus: c.dealStatus,
        replied: c.replied,
        timesContacted: c.timesContacted,
        lastContactedAt: c.lastContactedAt,
      })),
      foundCandidatesNotYetContacted: found.map((c) => ({
        channelName: c.channelName,
        channelUrl: c.channelUrl,
        niches: c.niches,
        subscribers: c.subscribers,
        avgViews: c.avgViews,
        engagementRate: c.engagementRate,
        contactEmail: c.contactEmail,
      })),
      exclusivityCandidates,
      needinessSignals,
    };
  },
});
