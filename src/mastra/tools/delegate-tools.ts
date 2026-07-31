import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { followupAgent } from "../agents/followup-agent";
import { negotiationAgent } from "../agents/negotiation-agent";
import { supervisorAgent } from "../agents/supervisor-agent";
import { sanitizeHumanText } from "../../utils/sanitize-text";
import { getAllContactedCreators, getFollowUpQueue, getLastSendInfo, getNegotiationState } from "../../tracking/outreach-log";
import { getLastReplyBody } from "../../gmail/check-replies";
import { computeBaselineViews, evaluateQuote, estimateFairPrice } from "../../pricing/cpm-calculator";

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
    "Drafts (does NOT send) a reply to a creator who already responded, found by name. Automatically pulls " +
    "their actual latest Gmail message and runs it through the negotiation agent + supervisor review, using CPM " +
    "math if a price/view-count/engagement figure is given. Returns the drafted text for a human to review and " +
    "send from that creator's row in the Influencers tab.",
  inputSchema: z.object({
    creatorName: z.string().describe("Full or partial creator name to look up"),
    quotedPrice: z.number().optional().describe("Price the creator quoted, if known"),
    viewCounts: z.array(z.number()).optional().describe("Recent video view counts, for CPM baseline"),
    engagementRate: z.number().optional().describe("Engagement rate as a decimal, e.g. 0.04"),
  }),
  outputSchema: z.object({
    status: z.enum(["drafted", "not-found", "ambiguous", "no-thread", "no-reply-found"]),
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
    if (!lastSend?.gmailThreadId) {
      return { status: "no-thread" as const, channelName: creator.channelName };
    }

    const reply = await getLastReplyBody(lastSend.gmailThreadId);
    if (!reply) {
      return { status: "no-reply-found" as const, channelName: creator.channelName };
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

    let feedback = "";
    let body = "";
    let action = "";
    let approved = false;
    let reviewNote = "";

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const draftPrompt =
        `Creator's message: ${reply.body}\nChannel: ${creator.channelName}\nNiche: ${creator.niche}\n` +
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
