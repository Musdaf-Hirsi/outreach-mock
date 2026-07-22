import fs from "node:fs";
import path from "node:path";

// Cold outreach from a personal (non-warmed-up) Gmail account is exactly
// what the course's own "Warming Up Your Emails" lesson warns against doing
// carelessly — sending a burst of identical-shaped emails in one run is a
// fast way to get flagged for spam or rate-limited, right when you need
// sending capacity most. Unlike the YouTube API side (which already tracks
// quota + paces requests), Gmail sending had no cap or delay at all until
// this file existed.

const QUOTA_FILE = path.resolve("gmail-send-quota.json");
const DAILY_SEND_LIMIT = Number(process.env.GMAIL_DAILY_SEND_LIMIT ?? 40);
const SEND_DELAY_MS = Number(process.env.GMAIL_SEND_DELAY_MS ?? 8000);

interface SendQuotaState {
  date: string; // YYYY-MM-DD
  sentToday: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadState(): SendQuotaState {
  if (fs.existsSync(QUOTA_FILE)) {
    const state = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) as SendQuotaState;
    if (state.date === todayKey()) return state;
  }
  return { date: todayKey(), sentToday: 0 };
}

function saveState(state: SendQuotaState) {
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2));
}

// Throws if today's send cap is already hit, so a runaway loop can't blast
// out an unbounded burst of real cold emails in one go.
export function consumeSendQuota(): void {
  const state = loadState();
  if (state.sentToday >= DAILY_SEND_LIMIT) {
    throw new Error(
      `Gmail daily send quota guard tripped: ${state.sentToday}/${DAILY_SEND_LIMIT} real sends used today. ` +
        `Stopping to protect the account from spam-flagging — try again tomorrow, or raise ` +
        `GMAIL_DAILY_SEND_LIMIT in .env if you're deliberately scaling up (e.g. after warming up a ` +
        `dedicated sending domain).`,
    );
  }
  state.sentToday += 1;
  saveState(state);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getSendDelayMs(): number {
  return SEND_DELAY_MS;
}
