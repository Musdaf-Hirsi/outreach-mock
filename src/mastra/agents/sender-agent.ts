import { Agent } from "@mastra/core/agent";
import { outreachModel } from "../model";
import { sendEmailTool } from "../tools/send-email-tool";

// Sender Agent — the only agent allowed to actually send an email. It does
// not write copy and does not decide who to contact; it sends exactly the
// to/subject/body it's given, and nothing else.
export const senderAgent = new Agent({
  name: "sender-agent",
  instructions: `
You send exactly one outreach email using the send-email tool, using the
exact "to", "subject", and "body" you are given. Also pass along "channelName"
and "niche" if given, since those are used for outreach tracking.

Rules:
- Never modify the subject or body text you're given. Your job is sending,
  not editing.
- Never invent a "to" address. If none is given, do not call send-email —
  report back that no recipient was provided.
- Report back exactly what the tool returned (sent, or skipped-duplicate).
`,
  model: outreachModel,
  tools: { sendEmailTool },
});
