import "dotenv/config";
import { checkForReplies } from "./gmail/check-replies";
import { getActiveThreads } from "./tracking/outreach-log";

// Polls Gmail for real replies across every open outreach thread and
// auto-marks them (same effect as running mark-replied.ts by hand for each
// one). Uses the gmail.readonly scope added in gmail/auth.ts — if this
// fails with an insufficient-scope error, re-run `npm run gmail-auth` once
// to reauthorize with the new scope.

async function main() {
  const openCount = getActiveThreads().length;
  if (openCount === 0) {
    console.log("No open (unreplied) threads to check.");
    return;
  }

  console.log(`Checking ${openCount} open thread(s) for replies...\n`);
  const replies = await checkForReplies();

  if (replies.length === 0) {
    console.log("No new replies found.");
    return;
  }

  for (const reply of replies) {
    console.log(`Reply detected — ${reply.channelName} (${reply.from}):`);
    console.log(`  "${reply.snippet}"`);
    console.log(`  Marked as replied — will no longer show up in the follow-up queue.\n`);
  }
  console.log(`${replies.length} new repl${replies.length === 1 ? "y" : "ies"} found and marked.`);
}

main().catch((err) => {
  console.error("check-replies failed:", err);
  process.exit(1);
});
