import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { negotiationAgent } from "./mastra/agents/negotiation-agent";
import { supervisorAgent } from "./mastra/agents/supervisor-agent";
import { sendEmailTool } from "./mastra/tools/send-email-tool";
import {
  getNegotiationState,
  recordNegotiationRound,
  getLastSendInfo,
} from "./tracking/outreach-log";
import { computeBaselineViews, evaluateQuote, estimateFairPrice } from "./pricing/cpm-calculator";
import { mentionsGoldenCountry } from "./utils/audience-check";
import { sanitizeHumanText } from "./utils/sanitize-text";
import { runTool } from "./utils/run-tool";

// Interactive negotiation-reply flow: paste in what a creator actually
// replied with, get a CPM-grounded draft reply reviewed by the supervisor,
// confirm, and send as a threaded reply — same human-in-the-loop pattern
// as run-interactive.ts and run-followups.ts. Nothing here auto-sends
// without a y/n confirmation.

const MAX_DRAFT_ATTEMPTS = 2;

function parseDraft(text: string): { body: string; action: string } {
  const bodyMatch = text.match(/BODY:\s*([\s\S]+?)(?:\nACTION:|$)/);
  const actionMatch = text.match(/ACTION:\s*(\S+)/);
  return {
    body: sanitizeHumanText(bodyMatch?.[1]?.trim() ?? text.trim()),
    action: actionMatch?.[1]?.trim() ?? "counter_price",
  };
}

function parseSupervisorVerdict(text: string): { approved: boolean; feedback?: string } {
  const decision = /DECISION:\s*(APPROVE|REVISE)/i.exec(text)?.[1]?.toUpperCase();
  const feedback = /FEEDBACK:\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  return { approved: decision === "APPROVE", feedback };
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const channelId = (await rl.question("Channel ID: ")).trim();
  const lastSend = getLastSendInfo(channelId);

  const channelName = (
    await rl.question(`Channel name${lastSend ? ` [${lastSend.channelName}]` : ""}: `)
  ).trim() || lastSend?.channelName || channelId;

  const niche = (await rl.question(`Niche${lastSend ? ` [${lastSend.niche}]` : ""}: `)).trim() || lastSend?.niche || "";

  const creatorMessage = (await rl.question("Paste the creator's reply message: ")).trim();

  const quotedPriceRaw = (await rl.question("Did they quote a price? Enter the number, or leave blank: ")).trim();
  const quotedPrice = quotedPriceRaw ? Number(quotedPriceRaw) : undefined;

  const viewCountsRaw = (
    await rl.question("Recent video view counts, comma-separated (for CPM baseline, or leave blank): ")
  ).trim();
  const engagementRaw = (await rl.question("Engagement rate as a decimal, e.g. 0.04 (or leave blank): ")).trim();
  const engagementRate = engagementRaw ? Number(engagementRaw) : undefined;

  const viewCounts = viewCountsRaw
    ? viewCountsRaw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n) && n >= 0)
    : [];
  const baselineViews = viewCounts.length > 0 ? computeBaselineViews(viewCounts.map((views) => ({ views }))) : 0;

  let pricingContext: string;
  if (quotedPrice !== undefined && baselineViews > 0) {
    const evaluation = evaluateQuote(quotedPrice, baselineViews, niche, { engagementRate });
    pricingContext =
      `Quoted price: ${quotedPrice}\nBaseline views: ${baselineViews.toLocaleString()}\n` +
      `Implied CPM: ${evaluation.impliedCpm}\nBenchmark CPM range: ${evaluation.benchmarkRange.min}-${evaluation.benchmarkRange.max}\n` +
      `Verdict: ${evaluation.verdict}\nSuggested counter range: ${evaluation.suggestedCounterRange.min}-${evaluation.suggestedCounterRange.max}`;
    console.log(`\nCPM evaluation: ${evaluation.verdict} (implied CPM ${evaluation.impliedCpm} vs benchmark ${evaluation.benchmarkRange.min}-${evaluation.benchmarkRange.max})`);
    console.log(`Suggested counter range: ${evaluation.suggestedCounterRange.min}-${evaluation.suggestedCounterRange.max}\n`);
  } else if (baselineViews > 0) {
    const fair = estimateFairPrice(baselineViews, niche);
    pricingContext = `No price quoted yet. Baseline views: ${baselineViews.toLocaleString()}\nEstimated fair price range: ${fair.price.min}-${fair.price.max}`;
  } else {
    pricingContext = "No view data provided — no CPM evaluation available for this reply.";
  }

  const state = getNegotiationState(channelId, channelName);
  const round = state.negotiationRound + 1;

  // Course technique ("Using Analytics as Leverage") — this was previously
  // only wired into the web and manager-chat negotiation paths; the CLI
  // path never read it, so the same channel got audience-leverage in the
  // web UI and not from the terminal.
  if (state.audienceNote) {
    pricingContext += `\nAudience note (from a real media kit check): ${state.audienceNote}`;
  }
  // Course technique ("Closing an Influencer That Has an Agency"): what
  // this agency operator can actually offer beyond the intro, so the
  // negotiation agent can frame a discount as a trade for a real service
  // instead of a bare markdown ask — only when negotiating with an agency
  // contact, per the agent's own instructions.
  if (process.env.AGENCY_SERVICES_OFFERED) {
    pricingContext += `\nServices this agency can offer beyond the intro (only relevant if negotiating with an agency contact): ${process.env.AGENCY_SERVICES_OFFERED}`;
  }
  if (round >= 3) {
    console.log(`\n(This would be negotiation round ${round} — course rule: don't open another back-and-forth past round 3. Accept or disengage instead.)\n`);
  }

  let feedback = "";
  let body = "";
  let action = "";
  let approved = false;

  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    const draftPrompt =
      `Creator's message: ${creatorMessage}\nChannel: ${channelName}\nNiche: ${niche}\n` +
      `Negotiation round: ${round}\n${pricingContext}` +
      (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");

    const draftResult = await negotiationAgent.generate(draftPrompt);
    ({ body, action } = parseDraft(draftResult.text));

    const reviewResult = await supervisorAgent.generate(
      `Creator's message: ${creatorMessage}\nChannel: ${channelName}\nNiche: ${niche}\n` +
        `Negotiation round: ${round}\n${pricingContext}\nBody: ${body}`,
    );
    const verdict = parseSupervisorVerdict(reviewResult.text);

    if (verdict.approved) {
      approved = true;
      console.log(attempt === 1 ? "(Approved by supervisor on first pass.)" : `(Approved after ${attempt} attempts.)`);
      break;
    }
    feedback = verdict.feedback ?? "Rewrite to follow the negotiation rules more closely.";
    console.log(`(Supervisor requested a revision: ${feedback})`);
  }

  if (!approved) {
    console.log(`\nSupervisor did not approve within ${MAX_DRAFT_ATTEMPTS} attempts — not sending.`);
    rl.close();
    return;
  }

  console.log(`\nRecommended action: ${action}`);
  console.log(`Reply:\n${body}\n`);

  const to = lastSend?.to ?? (await rl.question("No prior send on file — enter the recipient email: ")).trim();
  const confirm = await rl.question(`Send this reply to ${to}? (y/n): `);

  if (confirm.trim().toLowerCase() !== "y") {
    console.log("Not sent.");
    rl.close();
    return;
  }

  const dealStatus = action === "accept" ? "closed" : action === "walk_away" ? "declined" : "negotiating";

  // Course technique ("CPM vs Straight"): capture what the deal actually
  // closed on. Without this, `dealType`/`cpmRate`/`viewCap`/`monitoringDays`
  // exist as fields on NegotiationState but nothing ever writes them, so a
  // deal that closed on CPM/hybrid terms silently reads back as flat.
  let dealType: "flat" | "cpm" | "hybrid" | undefined;
  let cpmRate: number | undefined;
  let viewCap: number | undefined;
  let monitoringDays: number | undefined;
  if (dealStatus === "closed") {
    const dealTypeRaw = (await rl.question("Deal type? flat/cpm/hybrid [flat]: ")).trim().toLowerCase();
    dealType = dealTypeRaw === "cpm" || dealTypeRaw === "hybrid" ? dealTypeRaw : "flat";
    if (dealType !== "flat") {
      const cpmRateRaw = (await rl.question("CPM rate ($ per 1,000 views): ")).trim();
      cpmRate = cpmRateRaw ? Number(cpmRateRaw) : undefined;
      const viewCapRaw = (await rl.question("View cap: ")).trim();
      viewCap = viewCapRaw ? Number(viewCapRaw) : undefined;
      const monitoringDaysRaw = (await rl.question("Monitoring window in days [30]: ")).trim();
      monitoringDays = monitoringDaysRaw ? Number(monitoringDaysRaw) : 30;
    }
  }

  const sendResult = await runTool(sendEmailTool, {
    to,
    subject: `Re: ${lastSend?.subject ?? channelName}`,
    body,
    channelName,
    niche,
    kind: "followup", // reuses the threaded-reply path; not subject to the initial-send dedup guard
    gmailThreadId: lastSend?.gmailThreadId,
    inReplyToRfcMessageId: lastSend?.rfcMessageId,
  });

  if (sendResult.status === "sent") {
    const state = await recordNegotiationRound(channelId, {
      channelName,
      quotedPrice,
      dealStatus,
      dealType,
      cpmRate,
      viewCap,
      monitoringDays,
    });
    console.log(`Sent. Negotiation round ${round}, deal status: ${dealStatus}.`);
    // Course rule ("Closed an influencer, now what?"): "closed" means
    // pricing and audience info are actually on file, not just a yes.
    if (dealStatus === "closed") {
      const gaps: string[] = [];
      if (!state.lastQuotedPrice) gaps.push("no price on file");
      if (!state.audienceNote) gaps.push("no audience/media-kit note on file");
      else if (!mentionsGoldenCountry(state.audienceNote)) {
        gaps.push("audience note doesn't mention a high-purchasing-power country (US/UK/Canada/Australia)");
      }
      if (gaps.length > 0) {
        console.log(`(Closed with gaps: ${gaps.join(", ")} — worth filling in before this reaches the brand phase.)`);
      }
    }
  } else {
    console.log("Send was skipped by the tool (unexpected for a negotiation reply — check channelId).");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
