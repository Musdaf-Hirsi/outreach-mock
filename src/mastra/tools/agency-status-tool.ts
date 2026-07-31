import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getMilestoneStatus,
  getFollowUpQueue,
  getCheckInsDue,
  getAllContactedCreators,
} from "../../tracking/outreach-log";

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
    "(due now, not yet due, needs a fresh thread), post-close check-ins due, and every creator ever contacted " +
    "with their platform, niche, deal status, and reply state.",
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
  }),
  execute: async () => {
    const milestone = getMilestoneStatus();
    const queue = getFollowUpQueue();
    const checkIns = getCheckInsDue();
    const creators = getAllContactedCreators();

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
    };
  },
});
