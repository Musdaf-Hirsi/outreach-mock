import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findInfluencersTool } from "../mastra/tools/find-influencers-tool";
import { draftingAgent } from "../mastra/agents/drafting-agent";
import { supervisorAgent } from "../mastra/agents/supervisor-agent";
import { senderAgent } from "../mastra/agents/sender-agent";
import { getMilestoneStatus } from "../tracking/outreach-log";
import { sanitizeHumanText } from "../utils/sanitize-text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT ?? 4742);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/find", async (req, res) => {
  const niche = String(req.query.niche ?? "");
  if (!niche.trim()) {
    res.status(400).json({ error: "niche is required" });
    return;
  }
  try {
    const result = await (findInfluencersTool.execute as any)({
      context: {
        niche,
        minSubscribers: 50_000,
        maxSubscribers: 1_000_000,
        minEngagementRate: 0.01,
        minAvgViews: 50_000,
        // Search a wider pool so more than one candidate can survive the
        // subscriber/engagement/avg-views filters per search — the YouTube
        // search call costs the same 100 quota units regardless of how many
        // results it returns, so there's no real cost to asking for more.
        maxCandidates: 20,
        videosPerChannel: 10,
      },
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

function parseDraft(text: string): { subject: string; body: string } {
  const subjectMatch = text.match(/SUBJECT:\s*(.+)/);
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/);
  return {
    subject: sanitizeHumanText(subjectMatch?.[1]?.trim() ?? "Partnership opportunity"),
    body: sanitizeHumanText(bodyMatch?.[1]?.trim() ?? text.trim()),
  };
}

function parseSupervisorVerdict(text: string): { approved: boolean; feedback?: string } {
  const decision = /DECISION:\s*(APPROVE|REVISE)/i.exec(text)?.[1]?.toUpperCase();
  const feedback = /FEEDBACK:\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  return { approved: decision === "APPROVE", feedback };
}

const MAX_DRAFT_ATTEMPTS = 2;

app.post("/api/draft", async (req, res) => {
  const { channelName, niche, recentVideoTopic, to } = req.body ?? {};
  if (!channelName || !niche) {
    res.status(400).json({ error: "channelName and niche are required" });
    return;
  }
  try {
    let feedback = "";
    let draft = { subject: "", body: "" };
    let reviewNote = "";

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const prompt =
        `Channel: ${channelName}\nNiche: ${niche}\nRecent video: "${recentVideoTopic ?? ""}"` +
        (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");
      const draftResult = await draftingAgent.generate(prompt);
      draft = parseDraft(draftResult.text);

      const reviewResult = await supervisorAgent.generate(
        `Channel: ${channelName}\nNiche: ${niche}\nRecipient: ${to ?? "(not yet provided)"}\n` +
          `Subject: ${draft.subject}\nBody: ${draft.body}`,
      );
      const verdict = parseSupervisorVerdict(reviewResult.text);

      if (verdict.approved) {
        reviewNote = attempt === 1 ? "Approved by supervisor on first pass." : `Approved by supervisor after ${attempt} attempts.`;
        break;
      }
      feedback = verdict.feedback ?? "Rewrite to follow the humanizing rules more closely.";
      reviewNote = `Supervisor requested a revision (attempt ${attempt}): ${feedback}`;
    }

    res.json({ ...draft, reviewNote });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.post("/api/send", async (req, res) => {
  const { to, subject, body, channelName, niche } = req.body ?? {};
  if (!to || !subject || !body) {
    res.status(400).json({ error: "to, subject, and body are required" });
    return;
  }
  try {
    const sendResult = await senderAgent.generate(
      `Send this email.\nTo: ${to}\nSubject: ${subject}\nBody: ${body}\nchannelName: ${channelName ?? ""}\nniche: ${niche ?? ""}`,
    );
    res.json({ status: "sent", message: sendResult.text });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.get("/api/progress", (_req, res) => {
  res.json(getMilestoneStatus());
});

app.listen(PORT, () => {
  console.log(`\nWeb UI running at http://localhost:${PORT}\n`);
});
