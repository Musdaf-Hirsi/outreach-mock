import "dotenv/config";
import { markReplied } from "./tracking/outreach-log";

// Usage: npm run mark-replied -- <channelId>
// Run once you see a real reply land in your inbox, so that thread drops
// out of the follow-up queue (run-followups.ts) instead of getting nudged
// again after someone already responded.

const channelId = process.argv[2];
if (!channelId) {
  console.error("Usage: npm run mark-replied -- <channelId>");
  process.exit(1);
}

await markReplied(channelId);
console.log(`Marked ${channelId} as replied — it will no longer show up in the follow-up queue.`);
