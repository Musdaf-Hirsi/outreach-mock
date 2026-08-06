import { google } from "googleapis";
import { getAuthorizedGmailClient } from "./auth";
import { getActiveThreads, markReplied, getClosedThreadsForInboundScan, recordInboundCheckIns } from "../tracking/outreach-log";

// Requires the gmail.readonly scope added in auth.ts — an existing
// gmail-token.json authorized before that scope was added won't have it;
// re-run `npm run gmail-auth` once if this throws an insufficient-scope error.

function extractEmailAddress(headerValue: string): string {
  // "From" headers look like `Some Name <name@example.com>` or just a bare
  // address — pull out just the address part so a display-name difference
  // doesn't break the comparison against our own authorized address.
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).trim().toLowerCase();
}

export interface DetectedReply {
  channelId: string;
  channelName: string;
  from: string;
  snippet: string;
}

// Looks at every message in a thread, most recent first, and returns the
// first one that isn't from the authorized account — i.e. an actual reply,
// not just our own sent messages echoing back in the thread history.
export async function findReplyInThread(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
  myEmail: string,
): Promise<{ from: string; snippet: string } | undefined> {
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From"],
  });

  const messages = thread.data.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const fromHeader = messages[i].payload?.headers?.find((h) => h.name === "From")?.value;
    if (!fromHeader) continue;
    if (extractEmailAddress(fromHeader) !== myEmail.toLowerCase()) {
      return { from: fromHeader, snippet: messages[i].snippet ?? "" };
    }
  }
  return undefined;
}

// Gmail's snippet field (used above) is truncated to ~100 chars — fine for
// a "you've got a reply" notification, but not enough text to actually draft
// a real response from. Walks the MIME tree for a text/plain part and
// decodes it; falls back to text/html stripped of tags if that's all there
// is, since some clients (e.g. Outlook web, seen in practice) omit the plain
// part entirely.
function extractPlainTextBody(payload: any): string {
  const decode = (data: string) => Buffer.from(data, "base64url").toString("utf-8");

  function walk(part: any): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
    for (const child of part.parts ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  }

  const plain = walk(payload);
  if (plain) return plain.trim();

  function walkHtml(part: any): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === "text/html" && part.body?.data) return decode(part.body.data);
    for (const child of part.parts ?? []) {
      const found = walkHtml(child);
      if (found) return found;
    }
    return undefined;
  }
  const html = walkHtml(payload);
  if (html) return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  return "";
}

// Fetches the actual full message body (not just Gmail's truncated snippet)
// of the most recent reply in a thread — used to pre-fill the "what did they
// say" box in the web UI's Draft Reply flow, so the human doesn't have to go
// copy-paste it out of their inbox by hand.
export async function getLastReplyBody(threadId: string): Promise<{ from: string; body: string } | undefined> {
  const auth = await getAuthorizedGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profile.data.emailAddress;
  if (!myEmail) {
    throw new Error("Could not determine the authorized Gmail address (getProfile returned no emailAddress).");
  }

  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const messages = thread.data.messages ?? [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const fromHeader = messages[i].payload?.headers?.find((h) => h.name === "From")?.value;
    if (!fromHeader) continue;
    if (extractEmailAddress(fromHeader) !== myEmail.toLowerCase()) {
      const body = extractPlainTextBody(messages[i].payload) || messages[i].snippet || "";
      return { from: fromHeader, body };
    }
  }
  return undefined;
}

// Checks every open (unreplied) thread on file for a reply, and marks any
// that have one via markReplied() — the same call you'd otherwise have to
// make by hand. Returns what it found, so a caller can print/log it.
export async function checkForReplies(): Promise<DetectedReply[]> {
  const auth = await getAuthorizedGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profile.data.emailAddress;
  if (!myEmail) {
    throw new Error("Could not determine the authorized Gmail address (getProfile returned no emailAddress).");
  }

  const threads = getActiveThreads();
  const detected: DetectedReply[] = [];

  for (const thread of threads) {
    const reply = await findReplyInThread(gmail, thread.gmailThreadId, myEmail);
    if (!reply) continue;
    await markReplied(thread.channelId);
    detected.push({
      channelId: thread.channelId,
      channelName: thread.channelName,
      from: reply.from,
      snippet: reply.snippet,
    });
  }

  return detected;
}

export interface InboundCheckInActivity {
  channelId: string;
  channelName: string;
  newMessageCount: number;
  totalInboundCheckIns: number;
}

// Scans every closed-deal thread for messages the creator sent after the
// last scan — course technique ("Closed an influencer, now what?"):
// frequent unprompted follow-ups from an already-closed creator is a
// neediness signal, real leverage for a future repricing conversation. This
// is deliberately separate from checkForReplies: that function only ever
// looks at threads still waiting on their FIRST reply, so a closed deal
// (which by definition already replied once during negotiation) is
// permanently invisible to it — there was previously no way to detect a
// creator pinging you again after close at all.
export async function scanClosedThreadsForInboundActivity(): Promise<InboundCheckInActivity[]> {
  const auth = await getAuthorizedGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profile.data.emailAddress;
  if (!myEmail) {
    throw new Error("Could not determine the authorized Gmail address (getProfile returned no emailAddress).");
  }

  const threads = getClosedThreadsForInboundScan();
  const activity: InboundCheckInActivity[] = [];
  const scannedAt = new Date().toISOString();

  for (const thread of threads) {
    const gmailThread = await gmail.users.threads.get({
      userId: "me",
      id: thread.gmailThreadId,
      format: "metadata",
      metadataHeaders: ["From"],
    });
    const messages = gmailThread.data.messages ?? [];

    // No prior scan watermark: this is the first time we've looked at this
    // closed thread. Don't retroactively count the entire pre-close
    // negotiation history as "neediness" — just establish the watermark so
    // only genuinely new messages count from here on.
    const sinceMs = thread.lastInboundScanAt ? new Date(thread.lastInboundScanAt).getTime() : Date.now();

    let newMessageCount = 0;
    for (const message of messages) {
      const fromHeader = message.payload?.headers?.find((h) => h.name === "From")?.value;
      if (!fromHeader || extractEmailAddress(fromHeader) === myEmail.toLowerCase()) continue;
      const internalMs = Number(message.internalDate ?? 0);
      if (internalMs > sinceMs) newMessageCount++;
    }

    if (newMessageCount > 0 || !thread.lastInboundScanAt) {
      const state = await recordInboundCheckIns(thread.channelId, newMessageCount, scannedAt);
      if (newMessageCount > 0) {
        activity.push({
          channelId: thread.channelId,
          channelName: thread.channelName,
          newMessageCount,
          totalInboundCheckIns: state.inboundCheckInsReceived ?? 0,
        });
      }
    }
  }

  return activity;
}
