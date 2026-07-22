import { Mastra } from "@mastra/core";
import { discoveryAgent } from "./agents/discovery-agent";
import { draftingAgent } from "./agents/drafting-agent";
import { supervisorAgent } from "./agents/supervisor-agent";
import { senderAgent } from "./agents/sender-agent";
import { followupAgent } from "./agents/followup-agent";
import { negotiationAgent } from "./agents/negotiation-agent";

// No single agent here is ever handed both find-influencers and send-email
// at once — discovery, drafting, review, and sending are deliberately split
// so a real send can never happen without passing through supervisorAgent's
// review first. See run.ts / run-interactive.ts for the pipelines that wire
// these together.
export const mastra = new Mastra({
  agents: { discoveryAgent, draftingAgent, supervisorAgent, senderAgent, followupAgent, negotiationAgent },
});
