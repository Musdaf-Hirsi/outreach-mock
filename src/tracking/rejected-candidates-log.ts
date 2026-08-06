import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../utils/file-lock";

// Rejected channels used to vanish the moment a search ended — only ever
// logged to the terminal/viz dashboard — so every repeat search (within one
// sweep across keywords, or across days/future sweeps) re-spent real quota
// (playlistItems + videos.list calls, on top of channels.list) re-evaluating
// the exact same channel and landing on the exact same rejection. This
// persists rejections so a later search can skip a channel it already knows
// fails, without needing to fetch its stats again.

const STORE_FILE = path.resolve("rejected-candidates.json");

export interface RejectedCandidateEntry {
  channelId: string;
  channelName: string;
  subscribers: number;
  reason: string;
  rejectedAt: string; // ISO
}

function loadStore(): RejectedCandidateEntry[] {
  if (!fs.existsSync(STORE_FILE)) return [];
  const raw = fs.readFileSync(STORE_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${STORE_FILE} is corrupted and can't be parsed as JSON (${(err as Error).message}). ` +
        `If a recent run crashed mid-write, check for a .tmp file next to it or restore from a backup — ` +
        `this file is not safe to auto-repair.`,
    );
  }
}

function saveStore(entries: RejectedCandidateEntry[]) {
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

export async function logRejectedCandidates(entries: RejectedCandidateEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await withFileLock(STORE_FILE, () => {
    const store = loadStore();
    const byChannel = new Map(store.map((e) => [e.channelId, e]));
    for (const entry of entries) byChannel.set(entry.channelId, entry); // latest rejection (and reason) wins
    saveStore([...byChannel.values()]);
  });
}

const RECHECK_AFTER_DAYS = 7;

// Channels rejected within the last week are skipped before spending any
// per-channel quota on them again — a channel's stats rarely change enough
// in under a week to flip a rejection, and if it genuinely does, it gets
// re-evaluated automatically once the window passes.
export function getRecentlyRejectedIds(): Set<string> {
  const cutoff = Date.now() - RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000;
  return new Set(
    loadStore()
      .filter((e) => new Date(e.rejectedAt).getTime() >= cutoff)
      .map((e) => e.channelId),
  );
}
