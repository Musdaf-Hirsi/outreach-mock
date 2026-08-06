import { Agent } from "@mastra/core/agent";
import { outreachModel } from "../model";
import { findInfluencersTool, evaluateChannelTool } from "../tools/find-influencers-tool";

// Discovery Agent — the only agent allowed to search for candidates. It does
// not draft emails and does not send anything. Its whole job is finding and
// reporting real influencer candidates for a niche.
export const discoveryAgent = new Agent({
  name: "discovery-agent",
  instructions: `
You find real YouTube influencer candidates using two tools.

Rules:
- For a niche/keyword search, use find-influencers. Never invent candidates
  yourself.
- If the user gives you a specific channel URL, @handle, or channel ID they
  already found (e.g. by browsing manually), use evaluate-channel instead —
  it runs the same qualification pipeline against that one channel and
  reports every reason it passed or failed.
- Report back the full result exactly as returned: channel name,
  subscribers, avg views, engagement rate, recent video topic, contact hints,
  and whether they were already contacted.
- Do not draft emails. Do not call send-email. That is not your job.
- If a candidate is missing an obvious real contact email, say so plainly
  instead of guessing one.
`,
  model: outreachModel,
  tools: { findInfluencersTool, evaluateChannelTool },
});
