import "dotenv/config";
import { findInfluencersTool } from "./mastra/tools/find-influencers-tool";
import { draftingAgent } from "./mastra/agents/drafting-agent";
import { supervisorAgent } from "./mastra/agents/supervisor-agent";
import { sendEmailTool } from "./mastra/tools/send-email-tool";
import { initGraph, setNode } from "./viz/graph";
import { sanitizeHumanText } from "./utils/sanitize-text";
import { findFabricatedBrands } from "./utils/brand-guard";
import { runTool } from "./utils/run-tool";

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
//
// Defaults to a dry run: discovers, drafts, and gets supervisor approval,
// but stops short of actually calling send-email — this is still an LLM
// drafting an email and another LLM approving it, with zero human in the
// loop, and the blast radius of a bad send is a real message landing in a
// real creator's inbox from a real (non-warmed-up) Gmail account. Pass
// --send to actually send approved drafts; without it, this only shows you
// what would have gone out.

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
  const args = process.argv.slice(2);
  const liveSend = args.includes("--send");
  const niche = args.find((a) => !a.startsWith("--")) ?? "cybersecurity"; // official niche

  if (!liveSend) {
    console.log("Dry run (no --send flag) — will discover, draft, and get supervisor approval, but will NOT send any email.\n");
  }

  initGraph();
  setNode("trigger", "done", `niche: "${niche}"`);
  setNode("agent", "active", "finding candidates...");

  // Course's own stated criteria (lesson "How to Find Influencers"):
  // "people between 50 and 100,000 followers, and an average of minimum
  // 50,000 views per video... you can always work with bigger creators."
  // The floor is real and matches the course exactly; there's no course-
  // given ceiling since bigger creators are explicitly fine too, so the max
  // here is generous rather than the original arbitrary 1M cap.
  const findResult = await runTool(findInfluencersTool, {
    niche,
    minSubscribers: 50_000,
    maxSubscribers: 500_000,
    minEngagementRate: 0.01,
    minAvgViews: 50_000,
    maxCandidates: 50,
    videosPerChannel: 10,
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

      // Deterministic, non-LLM check before the supervisor even sees it —
      // both the drafting agent's instructions and the supervisor's review
      // are LLM judgment calls, and both have been observed in practice to
      // let a fabricated brand name through despite explicit instructions
      // not to. This catches the exact "brands like X" phrasing pattern
      // with plain string matching, independent of either model's mood.
      const fabricated = findFabricatedBrands(body, candidate.suggestedBrandsToOffer);
      if (fabricated.length > 0) {
        feedback = `Remove fabricated brand name(s) not in the allowed list: ${fabricated.join(", ")}. ${
          candidate.suggestedBrandsToOffer.length > 0
            ? `Only ${candidate.suggestedBrandsToOffer.join(", ")} may be named.`
            : "No brand may be named at all — speak only in general terms."
        }`;
        console.log(`(Blocked before supervisor — fabricated brand name(s): ${fabricated.join(", ")})`);
        continue;
      }

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

    if (!liveSend) {
      console.log(`[dry run] Would send to ${to} (${candidate.channelName}):\n  Subject: ${subject}\n  Body: ${body}\n`);
      sentCount++;
      continue;
    }

    const sendResult = await runTool(sendEmailTool, { to, subject, body, channelName: candidate.channelName, niche, kind: "initial" });

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
  console.log(`${liveSend ? "Sent" : "Would have sent (dry run)"}: ${sentCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Needs manual email lookup: ${needsManualLookupCount}`);
  if (!liveSend) {
    console.log(`\nRe-run with --send to actually send these: npm run dev -- "${niche}" --send`);
  }
}

main().catch((err) => {
  setNode("agent", "error", String(err.message ?? err));
  console.error("Run failed:", err);
  process.exit(1);
});
