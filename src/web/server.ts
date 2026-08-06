import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findInfluencersTool } from "../mastra/tools/find-influencers-tool";
import { draftingAgent } from "../mastra/agents/drafting-agent";
import { supervisorAgent } from "../mastra/agents/supervisor-agent";
import { senderAgent } from "../mastra/agents/sender-agent";
import { followupAgent } from "../mastra/agents/followup-agent";
import { negotiationAgent } from "../mastra/agents/negotiation-agent";
import { discoveryAgent } from "../mastra/agents/discovery-agent";
import { managerAgent } from "../mastra/agents/manager-agent";
import { sendEmailTool } from "../mastra/tools/send-email-tool";
import {
  getMilestoneStatus,
  getAllContactedCreators,
  getContactHistory,
  removeContactedCreator,
  getActiveThreads,
  getFollowUpQueue,
  getNegotiationState,
  updateNegotiationState,
  recordNegotiationRound,
  getLastSendInfo,
  setCreatorRating,
  markReplied,
} from "../tracking/outreach-log";
import { checkForReplies, getLastReplyBody, scanClosedThreadsForInboundActivity } from "../gmail/check-replies";
import { computeBaselineViews, evaluateQuote, estimateFairPrice } from "../pricing/cpm-calculator";
import { sanitizeHumanText } from "../utils/sanitize-text";
import { runTool } from "../utils/run-tool";
import { findFabricatedBrands } from "../utils/brand-guard";
import { mentionsGoldenCountry } from "../utils/audience-check";
import { writeInfluencersMarkdown } from "../report-influencers";
import { writeInfluencersExcel } from "../report-excel";
import { getAllFoundCandidatesDeduped } from "../tracking/found-candidates-log";
import { syncTrackingSheet, syncTrackingSheetIfConfigured } from "../tracking/google-sheet-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT ?? 4742);
const HOST = process.env.WEB_HOST ?? "127.0.0.1";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Random per-process secret, never persisted or exposed — used only to sign
// a short-lived approval token so /api/send can verify a draft actually came
// out of /api/draft's supervisor gate, rather than trusting whatever
// to/subject/body a caller POSTs directly. Regenerating on every server
// restart is fine: any in-flight approval token becomes invalid, which is
// the safe failure direction (forces a fresh draft+review, never lets a
// stale token through).
const APPROVAL_SECRET = crypto.randomBytes(32);
const APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to review in the UI, short enough to limit replay risk

function signApproval(to: string, subject: string, body: string, expiresAt: number): string {
  const payload = JSON.stringify({ to, subject, body, expiresAt });
  const sig = crypto.createHmac("sha256", APPROVAL_SECRET).update(payload).digest("base64url");
  return `${expiresAt}.${sig}`;
}

function verifyApproval(to: string, subject: string, body: string, token: string | undefined): boolean {
  if (!token) return false;
  const [expiresAtRaw, sig] = token.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!expiresAt || !sig || Date.now() > expiresAt) return false;
  const expected = signApproval(to, subject, body, expiresAt);
  const expectedSig = expected.split(".")[1];
  // Constant-time compare so a timing side-channel can't leak the valid
  // signature byte-by-byte.
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/api/find", async (req, res) => {
  const niche = String(req.query.niche ?? "");
  if (!niche.trim()) {
    res.status(400).json({ error: "niche is required" });
    return;
  }
  try {
    const result = await runTool(findInfluencersTool, {
      niche,
      minSubscribers: 50_000,
      // Course rule ("How to find influencers"): over ~500k usually means
      // already agencied or too expensive to work with this early — 1M was
      // looser than what's actually taught.
      maxSubscribers: 500_000,
      minEngagementRate: 0.01,
      minAvgViews: 50_000,
      // Search a wider pool so more than one candidate can survive the
      // subscriber/engagement/avg-views filters per search — the YouTube
      // search call costs the same 100 quota units regardless of how many
      // results it returns, so there's no real cost to asking for more.
      maxCandidates: 20,
      videosPerChannel: 10,
    });
    res.json(result);
    // Fire-and-forget: the response already went out, this just keeps the
    // shared Google Sheet current for whoever has that link open.
    void syncTrackingSheetIfConfigured();
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

    // Only issue an approval token when the supervisor actually approved —
    // if MAX_DRAFT_ATTEMPTS ran out without an APPROVE, reviewNote stays a
    // rejection message and no token is included, so /api/send has nothing
    // to accept for this draft.
    const approved = reviewNote.startsWith("Approved");
    const approvalToken = approved && to ? signApproval(String(to), draft.subject, draft.body, Date.now() + APPROVAL_TTL_MS) : undefined;

    res.json({ ...draft, reviewNote, approved, approvalToken });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// Manual-add: TikTok/Instagram have no free public discovery API like
// YouTube's, so a candidate here is whatever the human typed into the
// "Add manually" tab (name, link, niche, a short content description,
// optional brands to offer) instead of something search-populated. Runs
// through the exact same draft -> supervisor-review -> approval-token
// sequence as /api/draft below, just with a different context line and an
// explicit allowed-brands list (so fabricated brand names get caught here
// too, unlike the YouTube tab which doesn't currently send a brand list).
app.post("/api/manual/draft", async (req, res) => {
  const { displayName, niche, contentDescription, allowedBrands, to } = req.body ?? {};
  if (!displayName || !niche) {
    res.status(400).json({ error: "displayName and niche are required" });
    return;
  }
  const brands: string[] = Array.isArray(allowedBrands) ? allowedBrands.filter(Boolean) : [];
  const brandOffer =
    brands.length > 0
      ? `\nBrands to offer: ${brands.join(", ")}`
      : `\nBrands to offer: none — do not name any specific brand, speak only in general terms about finding brand partnerships`;

  try {
    let feedback = "";
    let draft = { subject: "", body: "" };
    let reviewNote = "";

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const prompt =
        `Channel: ${displayName}\nNiche: ${niche}\nRecent content: "${contentDescription ?? ""}"${brandOffer}` +
        (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");
      const draftResult = await draftingAgent.generate(prompt);
      draft = parseDraft(draftResult.text);

      const fabricated = findFabricatedBrands(draft.body, brands);
      if (fabricated.length > 0) {
        feedback = `Remove fabricated brand name(s) not in the allowed list: ${fabricated.join(", ")}. ${
          brands.length > 0 ? `Only ${brands.join(", ")} may be named.` : "No brand may be named at all — speak only in general terms."
        }`;
        reviewNote = `Blocked before supervisor — fabricated brand name(s): ${fabricated.join(", ")}`;
        continue;
      }

      const reviewResult = await supervisorAgent.generate(
        `Channel: ${displayName}\nNiche: ${niche}\nRecipient: ${to ?? "(not yet provided)"}\n` +
          `Allowed brands to be named (reject if any OTHER brand name appears in the email): ${
            brands.length > 0 ? brands.join(", ") : "none"
          }\nSubject: ${draft.subject}\nBody: ${draft.body}`,
      );
      const verdict = parseSupervisorVerdict(reviewResult.text);

      if (verdict.approved) {
        reviewNote = attempt === 1 ? "Approved by supervisor on first pass." : `Approved by supervisor after ${attempt} attempts.`;
        break;
      }
      feedback = verdict.feedback ?? "Rewrite to follow the humanizing rules more closely.";
      reviewNote = `Supervisor requested a revision (attempt ${attempt}): ${feedback}`;
    }

    const approved = reviewNote.startsWith("Approved");
    const approvalToken = approved && to ? signApproval(String(to), draft.subject, draft.body, Date.now() + APPROVAL_TTL_MS) : undefined;

    res.json({ ...draft, reviewNote, approved, approvalToken });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.get("/api/manual/contact-history", (req, res) => {
  const email = String(req.query.email ?? "");
  if (!email.trim()) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  res.json(getContactHistory(email.trim()));
});

// Issues a fresh approval token bound to whatever's currently in the
// subject/body fields, without another supervisor pass — used when the human
// has hand-edited a draft in the UI. A human reading and adjusting the text
// themselves is the review at that point; re-running the supervisor on an
// edit they just made on purpose would just fight them. Same trust boundary
// as every other endpoint here: this server only ever binds to localhost
// (see app.listen below), so "can reach this endpoint" already means
// "is the person using this machine."
app.post("/api/approve-edit", (req, res) => {
  const { to, subject, body } = req.body ?? {};
  if (!to || !subject || !body) {
    res.status(400).json({ error: "to, subject, and body are required" });
    return;
  }
  const approvalToken = signApproval(String(to), String(subject), String(body), Date.now() + APPROVAL_TTL_MS);
  res.json({ approvalToken });
});

app.post("/api/send", async (req, res) => {
  const { to, subject, body, channelName, niche, platform, approvalToken } = req.body ?? {};
  if (!to || !subject || !body) {
    res.status(400).json({ error: "to, subject, and body are required" });
    return;
  }
  // Require a valid, unexpired approval token bound to this exact
  // to/subject/body combination — proof this draft actually passed
  // /api/draft's supervisor review, rather than trusting whatever content a
  // caller sends directly to this endpoint. Editing the subject/body after
  // approval invalidates the token (it's part of the signed payload), which
  // is intentional: an edited draft hasn't actually been reviewed.
  if (!verifyApproval(String(to), String(subject), String(body), approvalToken)) {
    res.status(403).json({ error: "Missing or invalid/expired approval token — draft this email via /api/draft first, and send it unmodified." });
    return;
  }
  try {
    const sendResult = await senderAgent.generate(
      `Send this email.\nTo: ${to}\nSubject: ${subject}\nBody: ${body}\nchannelName: ${channelName ?? ""}\nniche: ${niche ?? ""}` +
        (platform ? `\nplatform: ${platform}` : ""),
    );
    res.json({ status: "sent", message: sendResult.text });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.get("/api/progress", (_req, res) => {
  res.json(getMilestoneStatus());
});

// --- Follow-ups -------------------------------------------------------------

app.get("/api/followups", (_req, res) => {
  const queue = getFollowUpQueue();
  res.json({
    due: queue.filter((c) => c.due),
    notYetDue: queue.filter((c) => !c.due && !c.needsNewThread),
    needsNewThread: queue.filter((c) => c.needsNewThread),
  });
});

function parseBodyOnly(text: string): string {
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/);
  return sanitizeHumanText(bodyMatch?.[1]?.trim() ?? text.trim());
}

app.post("/api/followups/draft", async (req, res) => {
  const { channelName, niche, followUpNumber, weight } = req.body ?? {};
  if (!channelName || !followUpNumber || !weight) {
    res.status(400).json({ error: "channelName, followUpNumber, and weight are required" });
    return;
  }
  try {
    const draftResult = await followupAgent.generate(
      `Channel/contact: ${channelName}\nNiche: ${niche ?? ""}\n` +
        `Follow-up number: ${followUpNumber}\nWeight: ${String(weight).toUpperCase()}`,
    );
    res.json({ body: parseBodyOnly(draftResult.text) });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.post("/api/followups/send", async (req, res) => {
  const { to, subject, body, channelName, niche, gmailThreadId, rfcMessageId } = req.body ?? {};
  if (!to || !subject || !body) {
    res.status(400).json({ error: "to, subject, and body are required" });
    return;
  }
  try {
    const sendResult = await runTool(sendEmailTool, {
      to,
      subject,
      body,
      channelName,
      niche,
      kind: "followup",
      gmailThreadId,
      inReplyToRfcMessageId: rfcMessageId,
    });
    res.json(sendResult);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// --- Negotiation / replying to a reply --------------------------------------

app.get("/api/negotiate/context/:channelId", (req, res) => {
  const channelId = req.params.channelId;
  const lastSend = getLastSendInfo(channelId);
  const state = getNegotiationState(channelId, lastSend?.channelName);
  res.json({ lastSend, state });
});

// Saves a real, human-checked audience demographic summary (top countries,
// age split, gender split) from a media kit — the web UI is the only place
// this can realistically get entered (nothing else in the app can see a
// media kit), and until now there was no way to save it here at all: it
// only had a CLI entry point (run-interactive.ts), which meant it stayed
// permanently empty for anyone using the web app. Course technique ("Using
// Analytics as Leverage") treats this as real negotiating ground once set —
// see negotiation-agent.ts and /api/negotiate/draft.
app.post("/api/negotiate/audience-note", async (req, res) => {
  const { channelId, channelName, audienceNote } = req.body ?? {};
  if (!channelId) {
    res.status(400).json({ error: "channelId is required" });
    return;
  }
  const state = await updateNegotiationState(channelId, { channelName, audienceNote: audienceNote ?? "" });
  res.json({ audienceNote: state.audienceNote });
});

// Pulls the actual full text of their latest reply straight from Gmail, so
// the web UI's "Draft reply" button can pre-fill what they said instead of
// making the human go copy-paste it out of their inbox — the whole point of
// having already read the reply via check-replies is that the tool "knows"
// it, and should act like it.
app.get("/api/negotiate/last-message/:channelId", async (req, res) => {
  const lastSend = getLastSendInfo(req.params.channelId);
  if (!lastSend?.gmailThreadId) {
    res.json({ message: null });
    return;
  }
  try {
    const reply = await getLastReplyBody(lastSend.gmailThreadId);
    res.json({ message: reply ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.post("/api/negotiate/draft", async (req, res) => {
  const { channelId, channelName, niche, creatorMessage, quotedPrice, viewCounts, engagementRate } = req.body ?? {};
  if (!channelId || !channelName || !creatorMessage) {
    res.status(400).json({ error: "channelId, channelName, and creatorMessage are required" });
    return;
  }
  try {
    const views: number[] = Array.isArray(viewCounts) ? viewCounts.map(Number).filter((n) => !Number.isNaN(n) && n >= 0) : [];
    const baselineViews = views.length > 0 ? computeBaselineViews(views.map((v) => ({ views: v }))) : 0;

    let pricingContext: string;
    let evaluation: ReturnType<typeof evaluateQuote> | undefined;
    if (quotedPrice !== undefined && quotedPrice !== null && quotedPrice !== "" && baselineViews > 0) {
      evaluation = evaluateQuote(Number(quotedPrice), baselineViews, niche ?? "", { engagementRate: engagementRate ? Number(engagementRate) : undefined });
      pricingContext =
        `Quoted price: ${quotedPrice}\nBaseline views: ${baselineViews.toLocaleString()}\n` +
        `Implied CPM: ${evaluation.impliedCpm}\nBenchmark CPM range: ${evaluation.benchmarkRange.min}-${evaluation.benchmarkRange.max}\n` +
        `Verdict: ${evaluation.verdict}\nSuggested counter range: ${evaluation.suggestedCounterRange.min}-${evaluation.suggestedCounterRange.max}`;
    } else if (baselineViews > 0) {
      const fair = estimateFairPrice(baselineViews, niche ?? "");
      pricingContext = `No price quoted yet. Baseline views: ${baselineViews.toLocaleString()}\nEstimated fair price range: ${fair.price.min}-${fair.price.max}`;
    } else {
      pricingContext = "No view data provided — no CPM evaluation available for this reply.";
    }

    const state = getNegotiationState(channelId, channelName);
    const round = state.negotiationRound + 1;

    // Course technique ("Using Analytics as Leverage"): a real, human-
    // checked audience demographic note (top countries/age/gender split)
    // is negotiating ground, same as CPM — YouTube's API can't expose this,
    // so it only exists once someone has actually opened a media kit and
    // saved it. Previously collected (audienceNote) but never actually
    // reached the negotiation agent's prompt; it just sat in
    // outreach-log.json unused.
    if (state.audienceNote) {
      pricingContext += `\nAudience note (from a real media kit check): ${state.audienceNote}`;
    }
    if (process.env.AGENCY_SERVICES_OFFERED) {
      pricingContext += `\nServices this agency can offer beyond the intro (only relevant if negotiating with an agency contact): ${process.env.AGENCY_SERVICES_OFFERED}`;
    }

    let feedback = "";
    let body = "";
    let action = "";
    let approved = false;
    let reviewNote = "";

    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const draftPrompt =
        `Creator's message: ${creatorMessage}\nChannel: ${channelName}\nNiche: ${niche ?? ""}\n` +
        `Negotiation round: ${round}\n${pricingContext}` +
        (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");

      const draftResult = await negotiationAgent.generate(draftPrompt);
      const bodyMatch = draftResult.text.match(/BODY:\s*([\s\S]+?)(?:\nACTION:|$)/);
      const actionMatch = draftResult.text.match(/ACTION:\s*(\S+)/);
      body = sanitizeHumanText(bodyMatch?.[1]?.trim() ?? draftResult.text.trim());
      action = actionMatch?.[1]?.trim() ?? "counter_price";

      const reviewResult = await supervisorAgent.generate(
        `Creator's message: ${creatorMessage}\nChannel: ${channelName}\nNiche: ${niche ?? ""}\n` +
          `Negotiation round: ${round}\n${pricingContext}\nBody: ${body}`,
      );
      const verdict = parseSupervisorVerdict(reviewResult.text);

      if (verdict.approved) {
        approved = true;
        reviewNote = attempt === 1 ? "Approved by supervisor on first pass." : `Approved by supervisor after ${attempt} attempts.`;
        break;
      }
      feedback = verdict.feedback ?? "Rewrite to follow the negotiation rules more closely.";
      reviewNote = `Supervisor requested a revision (attempt ${attempt}): ${feedback}`;
    }

    res.json({
      body,
      action,
      approved,
      reviewNote,
      round,
      evaluation,
      roundWarning: round >= 3 ? `This would be round ${round} — course rule: don't open another back-and-forth past round 3.` : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.post("/api/negotiate/send", async (req, res) => {
  const { channelId, channelName, niche, to, body, quotedPrice, action, gmailThreadId, rfcMessageId } = req.body ?? {};
  if (!channelId || !to || !body) {
    res.status(400).json({ error: "channelId, to, and body are required" });
    return;
  }
  try {
    const lastSend = getLastSendInfo(channelId);
    const sendResult = await runTool(sendEmailTool, {
      to,
      subject: `Re: ${lastSend?.subject ?? channelName ?? channelId}`,
      body,
      channelName,
      niche,
      kind: "followup",
      gmailThreadId,
      inReplyToRfcMessageId: rfcMessageId,
    });
    if (sendResult.status === "sent") {
      const dealStatus = action === "accept" ? "closed" : action === "walk_away" ? "declined" : "negotiating";
      const state = await recordNegotiationRound(channelId, {
        channelName,
        quotedPrice: quotedPrice ? Number(quotedPrice) : undefined,
        dealStatus,
      });
      // Course rule ("Closed an influencer, now what?"): "closed" isn't
      // just a reply saying yes — it means pricing and audience info are
      // actually on file. This is a warning, not a block: the human can
      // still legitimately close without a media kit and go get one after,
      // but it shouldn't happen silently.
      const closeWarnings: string[] = [];
      if (dealStatus === "closed") {
        if (!state.lastQuotedPrice) closeWarnings.push("no price on file for this deal yet");
        if (!state.audienceNote) closeWarnings.push("no audience/media-kit note on file yet");
        // Course rule ("What are media kits"): none of the golden countries
        // (US/UK/Canada/Australia) in the top-3 audience is a "run away"
        // red flag for an English-language campaign — worth catching before
        // this reaches the brand phase, not after.
        else if (!mentionsGoldenCountry(state.audienceNote)) {
          closeWarnings.push("audience note doesn't mention a high-purchasing-power country (US/UK/Canada/Australia)");
        }
      }
      res.json({
        ...sendResult,
        dealStatus: state.dealStatus,
        negotiationRound: state.negotiationRound,
        closeWarnings: closeWarnings.length > 0 ? closeWarnings : undefined,
      });
    } else {
      res.json(sendResult);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// --- Rating and manual reply marking -----------------------------------------

app.post("/api/rate", async (req, res) => {
  const { channelId, channelName, rating, note } = req.body ?? {};
  if (!channelId || !rating) {
    res.status(400).json({ error: "channelId and rating are required" });
    return;
  }
  try {
    const state = await setCreatorRating(channelId, Number(rating), note || undefined, channelName);
    res.json(state);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? String(err) });
  }
});

app.post("/api/mark-replied/:channelId", async (req, res) => {
  await markReplied(req.params.channelId);
  res.json({ status: "marked" });
});

// --- Report / influencers.md -------------------------------------------------

app.get("/api/report", (_req, res) => {
  const status = getMilestoneStatus();
  const queue = getFollowUpQueue();
  res.json({
    status,
    followUpsDue: queue.filter((c) => c.due).length,
    needsNewThread: queue.filter((c) => c.needsNewThread).length,
  });
});

app.post("/api/influencers-md", (_req, res) => {
  const count = writeInfluencersMarkdown();
  res.json({ count });
});

app.post("/api/sync-sheet", async (_req, res) => {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) {
    res.status(400).json({ error: "GOOGLE_SHEETS_ID is not set in .env — paste your sheet's ID or share URL." });
    return;
  }
  try {
    const { found, contacted } = await syncTrackingSheet(spreadsheetId);
    res.json({ found, contacted, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? spreadsheetId}/edit` });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

app.get("/api/influencers-excel", async (_req, res) => {
  const { found, contacted } = await writeInfluencersExcel();
  res.setHeader("Content-Disposition", "attachment; filename=Influencers.xlsx");
  res.setHeader("X-Found-Count", String(found));
  res.setHeader("X-Contacted-Count", String(contacted));
  res.sendFile(path.resolve("Influencers.xlsx"));
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// A stable URL (/sheet) that always shows the current tracking data as an
// HTML page, instead of the Excel download — clicking "download" repeatedly
// was piling up Influencers(1).xlsx, Influencers(2).xlsx, etc. in the
// browser's downloads folder since a new blob download can't overwrite a
// previous one. This reads the same two data sources as the Excel export
// (found-candidates.json, outreach-log.json) live on every request, so
// there's nothing to regenerate or re-download — just refresh the tab.
app.get("/sheet", (_req, res) => {
  const found = getAllFoundCandidatesDeduped();
  const contacted = getAllContactedCreators();

  const foundRows = found
    .map(
      (c) => `<tr>
        <td><a href="${escapeHtml(c.channelUrl)}" target="_blank" rel="noopener">${escapeHtml(c.channelName)}</a></td>
        <td>${escapeHtml(c.niches.join(", "))}</td>
        <td>${c.subscribers.toLocaleString()}</td>
        <td>${c.avgViews.toLocaleString()}</td>
        <td>${(c.engagementRate * 100).toFixed(2)}%</td>
        <td>${escapeHtml(c.postingConsistency)}</td>
        <td>${escapeHtml(c.recentVideoTopic)}</td>
        <td>${escapeHtml(c.contactEmail ?? "")}</td>
        <td>${escapeHtml((c.sponsorBrandsMentioned ?? []).join(", "))}</td>
        <td>${escapeHtml(c.suggestedBrandsToOffer.join(", "))}</td>
        <td>${escapeHtml(c.foundAt.slice(0, 10))}</td>
      </tr>`,
    )
    .join("\n");

  const contactedRows = contacted
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.channelName)}</td>
        <td>${escapeHtml(c.platform)}</td>
        <td>${escapeHtml(c.niche)}</td>
        <td>${escapeHtml(c.dealStatus)}</td>
        <td>${c.replied ? "yes" : "no"}</td>
        <td>${c.timesContacted}</td>
        <td>${escapeHtml(c.lastContactedAt.slice(0, 10))}</td>
      </tr>`,
    )
    .join("\n");

  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Influencer Tracking Sheet</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin-top: 32px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; white-space: nowrap; }
  th { background: #f0f0f0; position: sticky; top: 0; }
  tr:nth-child(even) { background: #fafafa; }
  .wrap { overflow-x: auto; }
  a { color: #1a56db; }
  .refresh { font-size: 13px; color: #666; }
</style>
</head>
<body>
  <h1>Influencer Tracking Sheet</h1>
  <p class="sub">Bookmark this page — it always shows current data, no re-downloading. <a href="javascript:location.reload()" class="refresh">Refresh</a> · <a href="/api/influencers-excel">Download as .xlsx instead</a></p>

  <h2>Found Candidates (${found.length})</h2>
  <div class="wrap">
  <table>
    <thead><tr>
      <th>Channel</th><th>Niche(s)</th><th>Subscribers</th><th>Avg Views</th><th>Engagement</th>
      <th>Posting</th><th>Recent Video</th><th>Contact Email</th><th>Sponsors Mentioned</th><th>Suggested Brands</th><th>Found</th>
    </tr></thead>
    <tbody>${foundRows || `<tr><td colspan="11">No candidates found yet.</td></tr>`}</tbody>
  </table>
  </div>

  <h2>Contacted (${contacted.length})</h2>
  <div class="wrap">
  <table>
    <thead><tr>
      <th>Creator</th><th>Platform</th><th>Niche</th><th>Status</th><th>Replied</th><th>Times Contacted</th><th>Last Contacted</th>
    </tr></thead>
    <tbody>${contactedRows || `<tr><td colspan="7">No one contacted yet.</td></tr>`}</tbody>
  </table>
  </div>
</body>
</html>`);
});

app.get("/api/influencers", (_req, res) => {
  res.json({ creators: getAllContactedCreators() });
});

app.delete("/api/influencers/:channelId", async (req, res) => {
  await removeContactedCreator(req.params.channelId);
  res.json({ status: "removed" });
});

// Nothing polls Gmail in the background — a reply only gets marked once this
// runs, whether via `npm run check-replies` or this button. Without it, a
// real reply just sits invisible in the inbox: the tracking data has no way
// to learn about it on its own.
app.post("/api/check-replies", async (_req, res) => {
  try {
    const openCount = getActiveThreads().length;
    const replies = await checkForReplies();
    // Course technique ("Closed an influencer, now what?"): also scan closed
    // deals for the creator following up on their own — frequent unprompted
    // post-close check-ins are a neediness signal, real leverage for a
    // future repricing conversation. Non-fatal: a scan failure shouldn't
    // hide the real (pre-close) replies this endpoint already found.
    let closedActivity: Awaited<ReturnType<typeof scanClosedThreadsForInboundActivity>> = [];
    try {
      closedActivity = await scanClosedThreadsForInboundActivity();
    } catch (err: any) {
      console.error(`Closed-thread inbound scan failed (non-fatal): ${err.message ?? err}`);
    }
    res.json({ openCount, replies, closedActivity });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// --- Direct agent chat -------------------------------------------------------
// Lets you talk to any single agent directly instead of only through the
// structured find/draft/negotiate flows — useful for asking "why did you
// write it that way" or trying a variant instruction on the fly. Deliberately
// excludes sender-agent: it's the only agent with a live, tool-bound action
// (sendEmailTool), and freeform chat can make an LLM decide to call a bound
// tool in ways a structured form never would — a stray "go ahead and send
// that to them" in casual conversation could trigger a real Gmail send. The
// other agents either have no tools at all (drafting/supervisor/followup/
// negotiation) or only a read/search tool that costs API quota but can't
// contact a real person (discovery, via find-influencers).
const CHAT_AGENTS: Record<string, { agent: any; label: string; note?: string }> = {
  manager: {
    agent: managerAgent,
    label: "Manager (ask about progress)",
    note: "Has live read access to your real tracking data and can delegate real drafts to the follow-up/negotiation agents by creator name (\"reply to X\", \"nudge Y\") — but never sends anything itself.",
  },
  drafting: { agent: draftingAgent, label: "Drafting agent", note: "Writes first-contact outreach copy. No tools — can't send or search." },
  supervisor: { agent: supervisorAgent, label: "Supervisor agent", note: "Reviews drafts before they're allowed to send. No tools." },
  followup: { agent: followupAgent, label: "Follow-up agent", note: "Writes nudge emails for unanswered threads. No tools." },
  negotiation: { agent: negotiationAgent, label: "Negotiation agent", note: "Drafts replies to creator responses using given CPM math. No tools." },
  discovery: {
    agent: discoveryAgent,
    label: "Discovery agent",
    note: "Can actually search YouTube via the Data API if asked to — real API quota gets spent.",
  },
};

app.get("/api/chat/agents", (_req, res) => {
  res.json({
    agents: Object.entries(CHAT_AGENTS).map(([id, { label, note }]) => ({ id, label, note })),
  });
});

app.post("/api/chat/:agentId", async (req, res) => {
  const entry = CHAT_AGENTS[req.params.agentId];
  if (!entry) {
    res.status(404).json({ error: `Unknown agent "${req.params.agentId}".` });
    return;
  }
  const { messages } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages (non-empty array) is required" });
    return;
  }
  try {
    const result = await entry.agent.generate(messages);
    res.json({ reply: result.text });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// Bind explicitly to localhost — this server has no authentication, and
// Node's default (no host argument) binds all interfaces, which would expose
// a send-capable endpoint (backed by a real, OAuth-authorized Gmail account)
// to anything else on the local network.
app.listen(PORT, HOST, () => {
  console.log(`\nWeb UI running at http://${HOST}:${PORT}\n`);
});
