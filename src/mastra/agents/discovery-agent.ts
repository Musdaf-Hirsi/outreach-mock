import { Agent } from "@mastra/core/agent";
import { outreachModel } from "../model";
import { findInfluencersTool } from "../tools/find-influencers-tool";

// Discovery Agent — the only agent allowed to search for candidates. It does
// not draft emails and does not send anything. Its whole job is finding and
// reporting real influencer candidates for a niche.
export const discoveryAgent = new Agent({
  name: "discovery-agent",
  instructions: `
You find real YouTube influencer candidates for a given niche using the
find-influencers tool.

Rules:
- Always use find-influencers with the niche you're given. Never invent
  candidates yourself.
- Report back the full candidate list exactly as returned: channel name,
  subscribers, avg views, engagement rate, recent video topic, contact hints,
  and whether they were already contacted.
- Do not draft emails. Do not call send-email. That is not your job.
- If a candidate is missing an obvious real contact email, say so plainly
  instead of guessing one.
`,
  model: outreachModel,
  tools: { findInfluencersTool },
});
