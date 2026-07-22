import "dotenv/config";
import { getMilestoneStatus, getFollowUpQueue } from "./tracking/outreach-log";

function main() {
  const status = getMilestoneStatus();

  console.log("\n=== IMA Program Progress ===\n");
  console.log(`Program day: ${status.programDay}`);
  console.log(`Total outreaches sent (all time): ${status.totalOutreaches}`);
  console.log(`Outreaches sent today: ${status.outreachesToday}`);
  console.log(`Current phase: ${status.phase}`);
  console.log(`Phase target: ${status.phaseTarget}`);
  console.log(`Phase progress: ${status.phaseProgress} / ${status.phaseTarget}`);
  console.log(`On track for deadline: ${status.onTrack ? "YES" : "NO — falling behind pace"}`);

  const queue = getFollowUpQueue();
  const due = queue.filter((c) => c.due).length;
  const needsNewThread = queue.filter((c) => c.needsNewThread).length;
  console.log(`\nFollow-ups due now: ${due}`);
  if (needsNewThread > 0) {
    console.log(`Threads needing a fresh angle (7 unanswered follow-ups): ${needsNewThread}`);
  }
  console.log(`Run "npm run followups" to work through the due queue.\n`);
}

main();
