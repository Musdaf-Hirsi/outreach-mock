import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { followupAgent } from "./mastra/agents/followup-agent";
import { sendEmailTool } from "./mastra/tools/send-email-tool";
import { getFollowUpQueue } from "./tracking/outreach-log";
import { sanitizeHumanText } from "./utils/sanitize-text";
import { runTool } from "./utils/run-tool";
import { checkForReplies } from "./gmail/check-replies";

// Checks every outreach thread for who's due a follow-up right now (per the
// escalating workday-aware wait in src/utils/workdays.ts) and walks through
// them one at a time. Nothing sends without a y/n confirmation, same as
// run-interactive.ts.
//
// Before building the queue, this polls Gmail (via gmail/check-replies.ts,
// using the gmail.readonly scope) for any real reply that landed since the
// last check and auto-marks it — so a thread someone already replied to
// never gets nudged just because you forgot to run mark-replied by hand. If
// the readonly scope isn't authorized yet (older gmail-token.json), this
// step logs a warning and the follow-up queue still runs off whatever was
// already marked manually, same as before this existed.

function parseDraft(text: string): { body: string } {
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/);
  return { body: sanitizeHumanText(bodyMatch?.[1]?.trim() ?? text.trim()) };
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const replies = await checkForReplies();
    if (replies.length > 0) {
      console.log(`\n=== Auto-detected ${replies.length} new repl${replies.length === 1 ? "y" : "ies"} ===`);
      for (const reply of replies) {
        console.log(`  - ${reply.channelName} (${reply.from}): "${reply.snippet}"`);
      }
      console.log("");
    }
  } catch (err) {
    console.log(
      `\n(Could not check for replies automatically: ${(err as Error).message}\n` +
        `If this is a scope error, re-run "npm run gmail-auth" to reauthorize with read access. Continuing with the existing follow-up state.)\n`,
    );
  }

  const queue = getFollowUpQueue();

  const due = queue.filter((c) => c.due);
  const needingNewThread = queue.filter((c) => c.needsNewThread);
  const notYetDue = queue.filter((c) => !c.due && !c.needsNewThread);

  console.log(`\n=== Follow-up queue ===`);
  console.log(`Due now: ${due.length} | Not yet due: ${notYetDue.length} | Needs new thread (2 unanswered): ${needingNewThread.length}\n`);

  if (needingNewThread.length > 0) {
    console.log(`These threads hit the 2-follow-up cap with no reply. Per the 2026 deliverability update, a`);
    console.log(`longer sequence is itself a spam signal — don't send a 3rd nudge in the same thread, start a`);
    console.log(`fresh email with a different subject line and angle instead`);
    console.log(`(e.g. offer a specific deal, or mention you're managing other creators/brands now):`);
    for (const c of needingNewThread) {
      console.log(`  - ${c.channelName} (${c.niche}) — last sent ${c.lastSentAt.slice(0, 10)}`);
    }
    console.log("");
  }

  if (notYetDue.length > 0) {
    console.log(`Not yet due:`);
    for (const c of notYetDue) {
      console.log(`  - ${c.channelName} — next follow-up #${c.followUpNumber} due ${c.nextDueDate.slice(0, 10)}`);
    }
    console.log("");
  }

  let sentCount = 0;
  let skippedCount = 0;

  for (const candidate of due) {
    console.log(`\n--- ${candidate.channelName} (${candidate.niche}) ---`);
    console.log(`Follow-up #${candidate.followUpNumber} (${candidate.weight}), last sent ${candidate.lastSentAt.slice(0, 10)}`);

    if (!candidate.gmailThreadId || !candidate.rfcMessageId) {
      console.log(`Skipping — no thread/message id on file for this contact (sent before threading was added).`);
      skippedCount++;
      continue;
    }

    let weight = candidate.weight;
    if (weight === "heavy") {
      const confirmHeavy = await rl.question(
        `This would be a HEAVY follow-up (applies real pressure — only use if there's a genuine deal/deadline at stake). Proceed as heavy? (y/n, n = send light instead): `,
      );
      if (confirmHeavy.trim().toLowerCase() !== "y") weight = "light";
    }

    const draftResult = await followupAgent.generate(
      `Channel/contact: ${candidate.channelName}\nNiche: ${candidate.niche}\n` +
        `Follow-up number: ${candidate.followUpNumber}\nWeight: ${weight.toUpperCase()}`,
    );
    const { body } = parseDraft(draftResult.text);

    console.log(`\n${body}\n`);
    const confirm = await rl.question(`Send this follow-up to ${candidate.to}? (y/n): `);
    if (confirm.trim().toLowerCase() !== "y") {
      console.log(`Not sent.`);
      skippedCount++;
      continue;
    }

    await runTool(sendEmailTool, {
      to: candidate.to,
      subject: `Re: ${candidate.lastSubjectContext}`,
      body,
      channelName: candidate.channelName,
      niche: candidate.niche,
      kind: "followup",
      gmailThreadId: candidate.gmailThreadId,
      inReplyToRfcMessageId: candidate.rfcMessageId,
    });

    console.log(`Sent.`);
    sentCount++;
  }

  rl.close();
  console.log(`\n=== Summary ===`);
  console.log(`Sent: ${sentCount}`);
  console.log(`Skipped: ${skippedCount}`);
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
