import readline from "node:readline/promises";
import { draftingAgent } from "./mastra/agents/drafting-agent";
import { supervisorAgent } from "./mastra/agents/supervisor-agent";
import { senderAgent } from "./mastra/agents/sender-agent";
import { setNode } from "./viz/graph";
import { sanitizeHumanText } from "./utils/sanitize-text";
import { findFabricatedBrands } from "./utils/brand-guard";

const MAX_DRAFT_ATTEMPTS = 2;

// Shared by every outreach entry point (YouTube's run-interactive.ts, and
// the manual-add flow for platforms with no discovery API) so the
// draft -> fabricated-brand-check -> supervisor -> human-edit -> confirm ->
// send sequence only exists in one place.

export interface DraftCandidate {
  displayName: string; // console label, and the channelName recorded for tracking
  niche: string;
  // The piece of context the drafting agent personalizes against — e.g.
  // `Recent video: "..."` for YouTube, or `Recent content: "..."` for a
  // manually-described TikTok/Instagram post.
  contextLine: string;
  allowedBrands: string[];
  platform?: "youtube" | "tiktok" | "instagram" | "other";
}

async function questionWithDefault(rl: readline.Interface, prompt: string, defaultValue: string): Promise<string> {
  const answerPromise = rl.question(prompt);
  if (defaultValue) rl.write(defaultValue);
  return answerPromise;
}

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

export async function draftReviewAndSend(
  rl: readline.Interface,
  candidate: DraftCandidate,
  email: string,
): Promise<"sent" | "skipped"> {
  setNode("send-email", "active", `drafting for ${candidate.displayName}`);

  let feedback = "";
  let subject = "";
  let body = "";

  // Always state the brand list explicitly, even when empty — omitting the
  // line entirely left room for the drafting agent to invent a
  // plausible-sounding brand name anyway.
  const brandOffer =
    candidate.allowedBrands.length > 0
      ? `\nBrands to offer: ${candidate.allowedBrands.join(", ")}`
      : `\nBrands to offer: none — do not name any specific brand, speak only in general terms about finding brand partnerships`;

  let approved = false;

  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    const prompt =
      `Channel: ${candidate.displayName}\nNiche: ${candidate.niche}\n${candidate.contextLine}${brandOffer}` +
      (feedback ? `\n\nRevise based on this feedback: ${feedback}` : "");
    const draftResult = await draftingAgent.generate(prompt);
    ({ subject, body } = parseDraft(draftResult.text));

    const fabricated = findFabricatedBrands(body, candidate.allowedBrands);
    if (fabricated.length > 0) {
      feedback = `Remove fabricated brand name(s) not in the allowed list: ${fabricated.join(", ")}. ${
        candidate.allowedBrands.length > 0
          ? `Only ${candidate.allowedBrands.join(", ")} may be named.`
          : "No brand may be named at all — speak only in general terms."
      }`;
      console.log(`(Blocked before supervisor — fabricated brand name(s): ${fabricated.join(", ")})`);
      continue;
    }

    const reviewResult = await supervisorAgent.generate(
      `Channel: ${candidate.displayName}\nNiche: ${candidate.niche}\nRecipient: ${email}\n` +
        `Allowed brands to be named (reject if any OTHER brand name appears in the email): ${
          candidate.allowedBrands.length > 0 ? candidate.allowedBrands.join(", ") : "none"
        }\nSubject: ${subject}\nBody: ${body}`,
    );
    const verdict = parseSupervisorVerdict(reviewResult.text);

    if (verdict.approved) {
      approved = true;
      console.log(attempt === 1 ? "(Approved by supervisor on first pass.)" : `(Approved after ${attempt} attempts.)`);
      break;
    }
    feedback = verdict.feedback ?? "Rewrite to follow the humanizing rules more closely.";
    console.log(`(Supervisor requested a revision: ${feedback})`);
  }

  if (!approved) {
    console.log(
      `\n(Could not get an auto-approved draft within ${MAX_DRAFT_ATTEMPTS} attempts — last issue: ${feedback})`,
    );
    console.log(`Here's the last attempt — edit it below to fix the issue, or skip this candidate.`);
  }

  console.log(`\nSubject: ${subject}\n${body}\n`);

  const editChoice = await rl.question(
    approved ? `Edit before sending? (y/n): ` : `Edit before sending? (y/n, n = skip this candidate): `,
  );

  if (!approved && editChoice.trim().toLowerCase() !== "y") {
    console.log(`Skipped — not auto-approved and no edit made.`);
    return "skipped";
  }
  if (editChoice.trim().toLowerCase() === "y") {
    const newSubject = (await questionWithDefault(rl, `New subject (edit as needed, enter to confirm): `, subject)).trim();
    if (newSubject) subject = sanitizeHumanText(newSubject);

    const newBody = (await questionWithDefault(rl, `New body (edit as needed, enter to confirm): `, body)).trim();
    if (newBody) {
      body = sanitizeHumanText(newBody);
      const stillFabricated = findFabricatedBrands(body, candidate.allowedBrands);
      if (stillFabricated.length > 0) {
        console.log(
          `(Heads up: this still names ${stillFabricated.join(", ")}, not on the allowed list for this candidate — your call, not blocked.)`,
        );
      }
    }

    console.log(`\nUpdated:\nSubject: ${subject}\n${body}\n`);
  }

  const confirm = await rl.question(`Send this to ${email}? (y/n): `);

  if (confirm.trim().toLowerCase() !== "y") {
    console.log(`Not sent.`);
    return "skipped";
  }

  await senderAgent.generate(
    `Send this email.\nTo: ${email}\nSubject: ${subject}\nBody: ${body}\n` +
      `channelName: ${candidate.displayName}\nniche: ${candidate.niche}` +
      (candidate.platform ? `\nplatform: ${candidate.platform}` : ""),
  );

  console.log(`Sent to ${email}.`);
  return "sent";
}
