import { createTool } from "@mastra/core/tools";
import { google } from "googleapis";
import { z } from "zod";
import { getAuthorizedGmailClient } from "../../gmail/auth";
import { setNode, logDetail } from "../../viz/graph";
import { recordOutreach, getContactHistory } from "../../tracking/outreach-log";

function buildRawMessage(
  to: string,
  subject: string,
  body: string,
  thread?: { inReplyToRfcMessageId: string },
): string {
  const lines = [`To: ${to}`, `Subject: ${subject}`];
  if (thread) {
    lines.push(`In-Reply-To: ${thread.inReplyToRfcMessageId}`, `References: ${thread.inReplyToRfcMessageId}`);
  }
  lines.push("Content-Type: text/plain; charset=utf-8", "", body);
  return Buffer.from(lines.join("\n")).toString("base64url");
}

export const sendEmailTool = createTool({
  id: "send-email",
  description:
    "Sends a real outreach email via the Gmail API using the authorized account. Pass gmailThreadId + " +
    "inReplyToRfcMessageId to send a follow-up as a reply in an existing thread instead of a new email.",
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
    channelName: z.string().optional().describe("The influencer/channel name this email is for, for progress tracking"),
    niche: z.string().optional().describe("The niche this outreach belongs to, for progress tracking"),
    kind: z.enum(["initial", "followup"]).default("initial"),
    gmailThreadId: z.string().optional().describe("Existing Gmail thread ID to reply within, for follow-ups"),
    inReplyToRfcMessageId: z
      .string()
      .optional()
      .describe("RFC822 Message-Id of the message being followed up on, for In-Reply-To/References headers"),
  }),
  outputSchema: z.object({
    status: z.enum(["sent", "skipped-duplicate"]),
    to: z.string(),
    messageId: z.string().optional(),
    threadId: z.string().optional(),
    rfcMessageId: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { to, subject, body, channelName, niche, kind, gmailThreadId, inReplyToRfcMessageId } = context;

    const channelIdMatch = to.match(/^outreach-placeholder\+([^@]+)@/);
    const channelId = channelIdMatch?.[1] ?? to;

    // Hard guard for first-contact emails only — never send a duplicate
    // *initial* outreach to a channel already logged. Follow-ups are
    // expected to repeat the same channelId on purpose.
    if (kind === "initial") {
      const history = getContactHistory(channelId);
      if (history.contacted) {
        logDetail(`send-email BLOCKED — ${to} already contacted ${history.timesContacted}x (last: ${history.lastContactedAt})`);
        return { status: "skipped-duplicate" as const, to };
      }
    }

    setNode("send-email", "active", `sending to ${to}`);

    const auth = await getAuthorizedGmailClient();
    const gmail = google.gmail({ version: "v1", auth });

    const raw = buildRawMessage(
      to,
      subject,
      body,
      inReplyToRfcMessageId ? { inReplyToRfcMessageId } : undefined,
    );
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: gmailThreadId },
    });

    const sentMessageId = res.data.id ?? undefined;
    const sentThreadId = res.data.threadId ?? undefined;

    // Fetch the RFC822 Message-Id header back out so a future follow-up can
    // set In-Reply-To/References correctly (Gmail generates this header
    // itself; it isn't something we can predict before sending).
    // Best-effort only — the authorized token has gmail.send scope but not
    // gmail.readonly/metadata, so this 403s today. Threaded follow-ups just
    // fall back to a plain (non-threaded) reply subject when it's missing;
    // it does not affect whether the send itself succeeds.
    let rfcMessageId: string | undefined;
    if (sentMessageId) {
      try {
        const meta = await gmail.users.messages.get({
          userId: "me",
          id: sentMessageId,
          format: "metadata",
          metadataHeaders: ["Message-Id"],
        });
        rfcMessageId = meta.data.payload?.headers?.find((h) => h.name === "Message-Id")?.value ?? undefined;
      } catch (err) {
        logDetail(`(could not fetch Message-Id for threading: ${(err as Error).message})`);
      }
    }

    recordOutreach({
      channelId,
      channelName: channelName ?? to,
      to,
      niche: niche ?? "unknown",
      kind,
      gmailMessageId: sentMessageId,
      gmailThreadId: sentThreadId,
      rfcMessageId,
    });

    setNode("send-email", "done", `sent to ${to}`);
    return { status: "sent" as const, to, messageId: sentMessageId, threadId: sentThreadId, rfcMessageId };
  },
});
