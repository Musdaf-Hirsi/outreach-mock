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

  const sendResult = await runTool(sendEmailTool, {
    to,
    subject: `Re: ${channelName}`,
    body,
    channelName,
    niche,
    kind: "followup", // reuses the threaded-reply path; not subject to the initial-send dedup guard
    gmailThreadId: lastSend?.gmailThreadId,
    inReplyToRfcMessageId: lastSend?.rfcMessageId,
  });

  if (sendResult.status === "sent") {
    await recordNegotiationRound(channelId, { channelName, quotedPrice, dealStatus });
    console.log(`Sent. Negotiation round ${round}, deal status: ${dealStatus}.`);
  } else {
    console.log("Send was skipped by the tool (unexpected for a negotiation reply — check channelId).");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
