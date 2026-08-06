import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { followupAgent } from "./mastra/agents/followup-agent";
import { sendEmailTool } from "./mastra/tools/send-email-tool";
import { getCheckInsDue, getLastSendInfo, recordCheckIn, NEEDINESS_THRESHOLD } from "./tracking/outreach-log";
import { sanitizeHumanText } from "./utils/sanitize-text";
import { runTool } from "./utils/run-tool";
import { scanClosedThreadsForInboundActivity } from "./gmail/check-replies";

// Course rule ("Closed an influencer, now what?"): once a deal closes, set
// and honor a specific next-steps timeline instead of going silent — a
// closed deal that never hears from you again is exactly how a real close
// falls apart before delivery. This runner is the missing other half of
// that rule: outreach-log.ts already tracked timelineSetAt/checkInsSent and
// computed who's due (getCheckInsDue), but nothing ever actually drafted or
// sent the check-in itself, so checkInsSent could never move off 0. Mirrors
// run-followups.ts's structure exactly — same y/n confirm, same skip-if-
// no-thread guard — just against the check-in queue instead of the
// follow-up queue.

function parseDraft(text: string): { body: string } {
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/);
  return { body: sanitizeHumanText(bodyMatch?.[1]?.trim() ?? text.trim()) };
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const activity = await scanClosedThreadsForInboundActivity();
    if (activity.length > 0) {
      console.log(`\n=== Post-close activity detected ===`);
      for (const a of activity) {
        const flag = a.totalInboundCheckIns >= NEEDINESS_THRESHOLD ? "  ← neediness signal, consider a repricing conversation" : "";
        console.log(`  - ${a.channelName}: ${a.newMessageCount} new message(s) (${a.totalInboundCheckIns} total since close)${flag}`);
      }
      console.log("");
    }
  } catch (err) {
    console.log(
      `\n(Could not scan closed threads for activity: ${(err as Error).message}\n` +
        `If this is a scope error, re-run "npm run gmail-auth" to reauthorize with read access. Continuing.)\n`,
    );
  }

  const due = getCheckInsDue().filter((c) => c.due);

  console.log(`\n=== Post-close check-ins due ===`);
  console.log(`${due.length} closed creator(s) due for a check-in.\n`);

  let sentCount = 0;
  let skippedCount = 0;

  for (const candidate of due) {
    const lastSend = getLastSendInfo(candidate.channelId);
    if (!lastSend?.gmailThreadId || !lastSend.rfcMessageId) {
      console.log(`Skipping ${candidate.channelName} — no thread/message id on file (sent before threading was added).`);
      skippedCount++;
      continue;
    }

    const daysSinceClose = Math.floor((Date.now() - new Date(candidate.timelineSetAt).getTime()) / (1000 * 60 * 60 * 24));

    console.log(`\n--- ${candidate.channelName} (${lastSend.niche}) ---`);
    console.log(`Check-in #${candidate.checkInsSent + 1}, closed ${daysSinceClose} day(s) ago`);

    const draftResult = await followupAgent.generate(
      `Channel/contact: ${candidate.channelName}\nNiche: ${lastSend.niche}\n` +
        `Weight: CHECKIN\nCheck-ins already sent: ${candidate.checkInsSent}\nDays since deal closed: ${daysSinceClose}`,
    );
    const { body } = parseDraft(draftResult.text);

    console.log(`\n${body}\n`);
    const confirm = await rl.question(`Send this check-in to ${lastSend.to}? (y/n): `);
    if (confirm.trim().toLowerCase() !== "y") {
      console.log(`Not sent.`);
      skippedCount++;
      continue;
    }

    await runTool(sendEmailTool, {
      to: lastSend.to,
      subject: `Re: ${lastSend.subject ?? candidate.channelName}`,
      body,
      channelName: candidate.channelName,
      niche: lastSend.niche,
      kind: "followup",
      gmailThreadId: lastSend.gmailThreadId,
      inReplyToRfcMessageId: lastSend.rfcMessageId,
    });
    await recordCheckIn(candidate.channelId);

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
