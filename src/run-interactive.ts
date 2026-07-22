import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { findInfluencersTool } from "./mastra/tools/find-influencers-tool";
import { draftingAgent } from "./mastra/agents/drafting-agent";
import { supervisorAgent } from "./mastra/agents/supervisor-agent";
import { senderAgent } from "./mastra/agents/sender-agent";
import { initGraph, setNode } from "./viz/graph";
import { sanitizeHumanText } from "./utils/sanitize-text";

const MAX_DRAFT_ATTEMPTS = 2;

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

    const brandOffer =
      candidate.suggestedBrandsToOffer.length > 0
        ? `\nBrands to offer: ${candidate.suggestedBrandsToOffer.join(", ")}`
        : "";

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const prompt =
        `Channel: ${candidate.channelName}\nNiche: ${niche}\nRecent video: "${candidate.recentVideoTopic}"${brandOffer}` +
        (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");
      const draftResult = await draftingAgent.generate(prompt);
      ({ subject, body } = parseDraft(draftResult.text));

      const reviewResult = await supervisorAgent.generate(
        `Channel: ${candidate.channelName}\nNiche: ${niche}\nRecipient: ${email.trim()}\n` +
          `Subject: ${subject}\nBody: ${body}`,
      );
      const verdict = parseSupervisorVerdict(reviewResult.text);

      if (verdict.approved) {
        console.log(attempt === 1 ? "(Approved by supervisor on first pass.)" : `(Approved after ${attempt} attempts.)`);
        break;
      }
      feedback = verdict.feedback ?? "Rewrite to follow the humanizing rules more closely.";
      console.log(`(Supervisor requested a revision: ${feedback})`);
    }

    console.log(`\nSubject: ${subject}\n${body}\n`);
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
