import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { findInfluencersTool } from "./mastra/tools/find-influencers-tool";
import { initGraph, setNode } from "./viz/graph";
import { updateNegotiationState } from "./tracking/outreach-log";
import { runTool } from "./utils/run-tool";
import { draftReviewAndSend } from "./draft-review-send";

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

// Interactive flow: find real candidates, then ask YOU for each one's real
// email (since YouTube's API can't provide it) before drafting and sending —
// instead of silently falling back to a placeholder address.

async function main() {
  const niche = process.argv[2] ?? "cybersecurity"; // official niche
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
      await updateNegotiationState(candidate.channelId, { channelName: candidate.channelName, audienceNote });
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

    const result = await draftReviewAndSend(
      rl,
      {
        displayName: candidate.channelName,
        niche,
        contextLine: `Recent video: "${candidate.recentVideoTopic}"`,
        allowedBrands: candidate.suggestedBrandsToOffer,
        platform: "youtube",
      },
      email.trim(),
    );

    if (result === "sent") sentCount++;
    else skippedCount++;
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
