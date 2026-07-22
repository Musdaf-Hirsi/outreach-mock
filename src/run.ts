import "dotenv/config";
import { findInfluencersTool } from "./mastra/tools/find-influencers-tool";
import { draftingAgent } from "./mastra/agents/drafting-agent";
import { supervisorAgent } from "./mastra/agents/supervisor-agent";
import { sendEmailTool } from "./mastra/tools/send-email-tool";
import { initGraph, setNode } from "./viz/graph";
import { sanitizeHumanText } from "./utils/sanitize-text";

// Non-interactive run for a niche: discover -> draft -> supervisor review ->
// send. This used to hand a single agent both find-influencers and
// send-email with no review step in between, which meant this "quick" path
// was also the only one that could send unreviewed copy. Every real send
// now goes through the same supervisor gate as run-interactive.ts, whether
// a human is watching or not — no send happens on the drafting agent's
// word alone.
//
// Candidates with no real email found in contactHints are skipped rather
// than "sent" to a placeholderEmail — a placeholder address is undeliverable
// by design, so sending to it wastes an API call and clutters the log with
// a send that reached nobody. Use run-interactive.ts to supply a real email
// by hand for those.

const MAX_DRAFT_ATTEMPTS = 2;

function parseSupervisorVerdict(text: string): { approved: boolean; feedback?: string } {
  const decision = /DECISION:\s*(APPROVE|REVISE)/i.exec(text)?.[1]?.toUpperCase();
  const feedback = /FEEDBACK:\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  return { approved: decision === "APPROVE", feedback };
}

function parseDraft(text: string): { subject: string; body: string } {
  const subjectMatch = text.match(/SUBJECT:\s*(.+)/);
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/);
  return {
    subject: sanitizeHumanText(subjectMatch?.[1]?.trim() ?? "Partnership opportunity"),
    body: sanitizeHumanText(bodyMatch?.[1]?.trim() ?? text.trim()),
  };
}

async function main() {
  const niche = process.argv[2] ?? "food";

  initGraph();
  setNode("trigger", "done", `niche: "${niche}"`);
  setNode("agent", "active", "finding candidates...");

  const findResult = await (findInfluencersTool.execute as any)({
    context: {
      niche,
      minSubscribers: 50_000,
      maxSubscribers: 1_000_000,
      minEngagementRate: 0.01,
      minAvgViews: 50_000,
      maxCandidates: 5,
      videosPerChannel: 10,
    },
  });

  setNode("agent", "done", `${findResult.results.length} candidate(s) found`);

  let sentCount = 0;
  let skippedCount = 0;
  let needsManualLookupCount = 0;

  for (const candidate of findResult.results) {
    if (candidate.alreadyContacted) {
      console.log(`Skipping ${candidate.channelName} — already contacted on ${candidate.lastContactedAt}.`);
      skippedCount++;
      continue;
    }

    const to = candidate.contactHints.emails[0];
    if (!to) {
      console.log(`Skipping ${candidate.channelName} — no real email found, needs manual lookup (run-interactive.ts).`);
      needsManualLookupCount++;
      continue;
    }

    // Course qualification rule: sporadic posters ("hobby, not a business")
    // aren't a reliable partner for a multi-month brand campaign — skip
    // rather than spend a supervised draft/review cycle on a dead lead.
    if (candidate.postingConsistency === "sporadic") {
      console.log(`Skipping ${candidate.channelName} — sporadic posting pattern, not a reliable partner for a campaign.`);
      skippedCount++;
      continue;
    }

    setNode("send-email", "active", `drafting for ${candidate.channelName}`);

    let feedback = "";
    let subject = "";
    let body = "";
    let approved = false;

    // Always state the brand list explicitly, even when empty — omitting
    // the line entirely left room for the drafting agent to invent a
    // plausible-sounding brand name anyway (observed: it named real brands
    // that were never actually supplied). Being unambiguous here, plus
    // giving the supervisor the same ground truth to check against below,
    // closes that gap at the code level instead of trusting the prompt alone.
    const brandOffer =
      candidate.suggestedBrandsToOffer.length > 0
        ? `\nBrands to offer: ${candidate.suggestedBrandsToOffer.join(", ")}`
        : `\nBrands to offer: none — do not name any specific brand, speak only in general terms about finding brand partnerships`;

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const prompt =
        `Channel: ${candidate.channelName}\nNiche: ${niche}\nRecent video: "${candidate.recentVideoTopic}"${brandOffer}` +
        (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");
      const draftResult = await draftingAgent.generate(prompt);
      ({ subject, body } = parseDraft(draftResult.text));

      const reviewResult = await supervisorAgent.generate(
        `Channel: ${candidate.channelName}\nNiche: ${niche}\nRecipient: ${to}\n` +
          `Allowed brands to be named (reject if any OTHER brand name appears in the email): ${
            candidate.suggestedBrandsToOffer.length > 0 ? candidate.suggestedBrandsToOffer.join(", ") : "none"
          }\nSubject: ${subject}\nBody: ${body}`,
      );
      const verdict = parseSupervisorVerdict(reviewResult.text);

      if (verdict.approved) {
        approved = true;
        console.log(`${candidate.channelName}: approved by supervisor${attempt > 1 ? ` after ${attempt} attempts` : ""}.`);
        break;
      }
      feedback = verdict.feedback ?? "Rewrite to follow the humanizing rules more closely.";
    }

    if (!approved) {
      console.log(`Skipping ${candidate.channelName} — supervisor did not approve within ${MAX_DRAFT_ATTEMPTS} attempts.`);
      skippedCount++;
      continue;
    }

    const sendResult = await (sendEmailTool.execute as any)({
      context: { to, subject, body, channelName: candidate.channelName, niche, kind: "initial" },
    });

    if (sendResult.status === "sent") {
      console.log(`Sent to ${to} (${candidate.channelName}).`);
      sentCount++;
    } else {
      console.log(`Skipped ${candidate.channelName} — duplicate (already contacted).`);
      skippedCount++;
    }
  }

  setNode("done", "done", `${sentCount} sent, ${skippedCount} skipped, ${needsManualLookupCount} need manual lookup`);

  console.log("\n=== Summary ===");
  console.log(`Sent: ${sentCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Needs manual email lookup: ${needsManualLookupCount}`);
}

main().catch((err) => {
  setNode("agent", "error", String(err.message ?? err));
  console.error("Run failed:", err);
  process.exit(1);
});
