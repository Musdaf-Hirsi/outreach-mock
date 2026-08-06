import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../../utils/file-lock";

// YouTube Data API v3 has a fixed daily quota (10,000 units by default).
// search.list costs 100 units; channels/playlistItems/videos.list cost 1 each.
// This tracks usage across runs (persisted to disk) so a busy day of testing
// doesn't silently blow through the quota and start failing mid-run.

const QUOTA_FILE = path.resolve("youtube-quota.json");
const DAILY_LIMIT = Number(process.env.YOUTUBE_DAILY_QUOTA_LIMIT ?? 9000); // leave a buffer under the real 10,000 cap

interface QuotaState {
  date: string; // YYYY-MM-DD
  unitsUsed: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadState(): QuotaState {
  if (fs.existsSync(QUOTA_FILE)) {
    let state: QuotaState;
    try {
      state = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) as QuotaState;
    } catch {
      // A truncated/corrupted quota file (crash mid-write) used to throw a
      // raw JSON.parse error here and take down every YouTube call. This
      // file resets daily anyway, so a corrupted read is safe to treat as
      // "start the day over" rather than a hard failure.
      return { date: todayKey(), unitsUsed: 0 };
    }
    if (state.date === todayKey()) return state;
  }
  return { date: todayKey(), unitsUsed: 0 };
}

// Write to a temp file then rename over the real one — rename is atomic on
// the same filesystem, so a crash mid-write can't leave a truncated file
// for the next loadState() call to choke on.
function saveState(state: QuotaState) {
  const tmpFile = `${QUOTA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, QUOTA_FILE);
}

export async function consumeQuota(units: number): Promise<void> {
  // Load, check, and save inside the same lock — otherwise two concurrent
  // callers (e.g. the CLI and the web dashboard both making YouTube calls)
  // can both read the same unitsUsed, both pass the check, and both save,
  // silently losing one of the increments and letting real usage drift past
  // DAILY_LIMIT without ever tripping the guard.
  await withFileLock(QUOTA_FILE, () => {
    const state = loadState();
    if (state.unitsUsed + units > DAILY_LIMIT) {
      throw new Error(
        `YouTube API daily quota guard tripped: ${state.unitsUsed}/${DAILY_LIMIT} units used, ` +
          `this call needs ${units} more. Stopping to avoid a hard quota failure — try again tomorrow, ` +
          `or raise YOUTUBE_DAILY_QUOTA_LIMIT in .env if you're sure you have headroom.`,
      );
    }
    state.unitsUsed += units;
    saveState(state);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
