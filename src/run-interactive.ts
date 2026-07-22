import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { findInfluencersTool } from "./mastra/tools/find-influencers-tool";
import { draftingAgent } from "./mastra/agents/drafting-agent";
import { supervisorAgent } from "./mastra/agents/supervisor-agent";
import { senderAgent } from "./mastra/agents/sender-agent";
import { initGraph, setNode } from "./viz/graph";
import { sanitizeHumanText } from "./utils/sanitize-text";
import { updateNegotiationState } from "./tracking/outreach-log";
import { findFabricatedBrands } from "./utils/brand-guard";

const MAX_DRAFT_ATTEMPTS = 2;

// Course qualification dimension: for English-language campaigns, look for
// at least one high-purchasing-power country in a creator's top 3 audience
// countries. This can't be pulled from the YouTube API — it only exists if
// you've checked a media kit yourself — so it's an optional, skippable
// prompt, informational only. It never auto-skips a candidate: partial
// coverage (only the candidates someone bothered to check) shouldn't
// masquerade as a real, consistently-applied filter.
const GOLDEN_COUNTRY_KEYWORDS = ["us", "usa", "united states", "uk", "united kingdom", "canada", "australia"];

function mentionsGoldenCountry(note: string): boolean {
  const lower = note.toLowerCase();
  return GOLDEN_COUNTRY_KEYWORDS.some((kw) => lower.includes(kw));
}

function parseSupervisorVerdict(text: string): { approved: boolean; feedback?: string } {
  const decision = /DECISION:\s*(APPROVE|REVISE)/i.exec(text)?.[1]?.toUpperCase();
  const feedback = /FEEDBACK:\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  return { approved: decision === "APPROVE", feedback };
}

// Interactive flow: find real candidates, then ask YOU for each one's real
// email (since YouTube's API can't provide it) before drafting and sending —
// instead of silently falling back to a placeholder address.

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
  const rl = readline.createInterface({ input: stdin, output: stdout });

  initGraph();
  setNode("trigger", "done", `niche: "${niche}"`);
  setNode("agent", "active", "finding candidates...");

  // Course's own stated criteria (lesson "How to Find Influencers"):
  // "people between 50 and 100,000 followers, and an average of minimum
  // 50,000 views per video... you can always work with bigger creators."
  // The floor is real and matches the course exactly; there's no course-
  // given ceiling since bigger creators are explicitly fine too, so the max
  // here is generous rather than the original arbitrary 1M cap.
  const findResult = await (findInfluencersTool.execute as any)({
    context: {
      niche,
      minSubscribers: 50_000,
      maxSubscribers: 5_000_000,
      minEngagementRate: 0.01,
      minAvgViews: 50_000,
      maxCandidates: 50,
      videosPerChannel: 10,
    },
  });

  setNode("agent", "done", `${findResult.results.length} candidate(s) found`);

  let sentCount = 0;
  let skippedCount = 0;

  for (const candidate of findResult.results) {
    if (candidate.alreadyContacted) {
      console.log(`\nSkipping ${candidate.channelName} — already contacted on ${candidate.lastContactedAt}.`);
      skippedCount++;
      continue;
    }

    console.log(`\n--- ${candidate.channelName} ---`);
    console.log(`Subscribers: ${candidate.subscribers.toLocaleString()} | Avg views: ${candidate.avgViews.toLocaleString()}`);
    console.log(`Latest video: "${candidate.recentVideoTopic}"`);
    console.log(
      `Posting: ${candidate.postingConsistency}${candidate.daysSinceLastUpload !== null ? ` (last upload ${candidate.daysSinceLastUpload}d ago)` : ""}` +
        (candidate.postingConsistency === "sporadic" ? " — course flag: not a reliable partner for a multi-month campaign" : ""),
    );
    if (candidate.contactHints.emails.length > 0) {
      console.log(`Auto-found email(s): ${candidate.contactHints.emails.join(", ")}`);
    }
    if (candidate.contactHints.links.length > 0) {
      console.log(`Auto-found link(s): ${candidate.contactHints.links.slice(0, 3).join(", ")}`);
    }
    if (candidate.suggestedBrandsToOffer.length > 0) {
      console.log(`Brands to offer (seen elsewhere in this niche, not with this creator): ${candidate.suggestedBrandsToOffer.join(", ")}`);
    }

    const audienceNote = (
      await rl.question(
        `Know this creator's audience top countries (from a media kit or similar)? Paste them, or press Enter to skip: `,
      )
    ).trim();
    if (audienceNote) {
      updateNegotiationState(candidate.channelId, { channelName: candidate.channelName, audienceNote });
      if (!mentionsGoldenCountry(audienceNote)) {
        console.log(
          `(Note: no high-purchasing-power country (US/UK/Canada/Australia) mentioned — worth weighing before pitching brands, not a blocker.)`,
        );
      }
    }

    const email = await rl.question(
      `Enter the real email for ${candidate.channelName} (or press Enter to skip this one): `,
    );

    if (!email.trim()) {
      console.log(`Skipped — no email provided.`);
      skippedCount++;
      continue;
    }

    setNode("send-email", "active", `drafting for ${candidate.channelName}`);

    let feedback = "";
    let subject = "";
    let body = "";

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

    let approved = false;

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
        `Channel: ${candidate.channelName}\nNiche: ${niche}\nRecipient: ${email.trim()}\n` +
          `Allowed brands to be named (reject if any OTHER brand name appears in the email): ${
            candidate.suggestedBrandsToOffer.length > 0 ? candidate.suggestedBrandsToOffer.join(", ") : "none"
          }\nSubject: ${subject}\nBody: ${body}`,
      );
      const verdict = parseSupervisorVerdict(reviewResult.text);

      if (verdict.approved) {
        approved = true;
        console.log(attempt === 1 ? "(Approved by supervisor on first pass.)" : `(Approved after ${attempt} attempts.)`);
        break;
      }
      feedback = verdict.feedback ?? "Rewrite to follow the humanizing rules more closely.";
      console.log(`(Supervisor requested a revision: ${feedback})`);
    }

    if (!approved) {
      console.log(`Skipping ${candidate.channelName} — could not get an approved, non-fabricated draft within ${MAX_DRAFT_ATTEMPTS} attempts.`);
      skippedCount++;
      continue;
    }

    console.log(`\nSubject: ${subject}\n${body}\n`);

    // Manual final say — instead of only trusting the drafting/supervisor
    // agents to never make a mistake (a brand mention you don't like, a
    // phrase that reads wrong, anything), you get to edit it directly right
    // before it sends. Blank on either prompt just keeps the current text.
    const editChoice = await rl.question(`Edit before sending? (y/n): `);
    if (editChoice.trim().toLowerCase() === "y") {
      const newSubject = (await rl.question(`New subject (blank to keep current): `)).trim();
      if (newSubject) subject = sanitizeHumanText(newSubject);

      const newBody = (await rl.question(`New body (blank to keep current): `)).trim();
      if (newBody) {
        body = sanitizeHumanText(newBody);
        const stillFabricated = findFabricatedBrands(body, candidate.suggestedBrandsToOffer);
        if (stillFabricated.length > 0) {
          console.log(
            `(Heads up: this still names ${stillFabricated.join(", ")}, not on the allowed list for this candidate — your call, not blocked.)`,
          );
        }
      }

      console.log(`\nUpdated:\nSubject: ${subject}\n${body}\n`);
    }

    const confirm = await rl.question(`Send this to ${email.trim()}? (y/n): `);

    if (confirm.trim().toLowerCase() !== "y") {
      console.log(`Not sent.`);
      skippedCount++;
      continue;
    }

    await senderAgent.generate(
      `Send this email.\nTo: ${email.trim()}\nSubject: ${subject}\nBody: ${body}\n` +
        `channelName: ${candidate.channelName}\nniche: ${niche}`,
    );

    console.log(`Sent to ${email.trim()}.`);
    sentCount++;
  }

  setNode("done", "done", `${sentCount} sent, ${skippedCount} skipped`);
  rl.close();

  console.log(`\n=== Summary ===`);
  console.log(`Sent: ${sentCount}`);
  console.log(`Skipped: ${skippedCount}`);
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
