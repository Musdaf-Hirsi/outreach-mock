import { Mastra } from "@mastra/core";
import { outreachAgent } from "./agents/outreach-agent";
import { discoveryAgent } from "./agents/discovery-agent";
import { draftingAgent } from "./agents/drafting-agent";
import { supervisorAgent } from "./agents/supervisor-agent";
import { senderAgent } from "./agents/sender-agent";
import { followupAgent } from "./agents/followup-agent";

export const mastra = new Mastra({
  agents: { outreachAgent, discoveryAgent, draftingAgent, supervisorAgent, senderAgent, followupAgent },
});
