import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../utils/file-lock";

// Append-only record of every candidate find-influencers-tool has ever
// surfaced, from any entry point (web UI search, CLI runs, the manager
// agent's find-candidates-for-niche tool). None of that ever got written to
// disk before — a search's results only ever lived in the JSON response to
// whichever client asked — so there was no way to look back at "everyone
// we've found so far" for the Excel sheet without re-running every past
// search. This is a read view export feeds off, not a second source of
// truth for outreach state (outreach-log.json / negotiation state stays
// authoritative for anything actually contacted).

const STORE_FILE = path.resolve("found-candidates.json");

export interface FoundCandidateEntry {
  foundAt: string; // ISO
  niche: string;
  channelId: string;
  channelName: string;
  subscribers: number;
  avgViews: number;
  engagementRate: number;
  recentVideoTopic: string;
  postingConsistency: "consistent" | "sporadic" | "unknown";
  possibleFakeEngagement: boolean;
  // Absent on entries logged before this field existed — treat as "unknown"
  // (blank), not "just uploaded." Course tracking-sheet column.
  daysSinceLastUpload?: number | null;
  // Course pricing/qualification red flag: wildly fluctuating view counts
  // across recent videos — informational, was never used to exclude a
  // candidate from this list.
  inconsistentViews?: boolean;
  contactEmail?: string; // first auto-found real email, if any
  contactLink?: string; // first auto-found link (linktree/website), if any
  aboutUrl?: string; // channel's public About page — where email lookup happens if none was auto-found
  // Real brand names scanned from this creator's own video descriptions
  // ("sponsored by X", "in partnership with X", etc.) — existing sponsors
  // they've actually worked with, not a suggestion. A creator with several
  // of these is both a proven-monetizable prospect and a personalization
  // hook ("saw you didn't have a sponsor on your last video" only works
  // when this list is empty for their most recent upload).
  sponsorBrandsMentioned: string[];
  suggestedBrandsToOffer: string[];
}

function loadStore(): FoundCandidateEntry[] {
  if (!fs.existsSync(STORE_FILE)) return [];
  const raw = fs.readFileSync(STORE_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Same failure mode outreach-log.ts used to have: a crash mid-write
    // (before the atomic-rename fix below existed) could truncate this
    // file, and a raw JSON.parse error here used to take down every
    // caller, including read-only ones like the status tool.
    throw new Error(
      `${STORE_FILE} is corrupted and can't be parsed as JSON (${(err as Error).message}). ` +
        `If a recent run crashed mid-write, check for a .tmp file next to it or restore from a backup — ` +
        `this file is not safe to auto-repair.`,
    );
  }
}

// Write to a temp file then rename over the real one — rename is atomic on
// the same filesystem, so a crash mid-write leaves either the old complete
// file or the new complete file, never a half-written one that the next
// loadStore() call chokes on.
function saveStore(entries: FoundCandidateEntry[]) {
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

export async function logFoundCandidates(entries: FoundCandidateEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await withFileLock(STORE_FILE, () => {
    const store = loadStore();
    store.push(...entries);
    saveStore(store);
  });
}

// One row per channel for the export, not one row per search — the same
// channel legitimately turns up again across repeated/overlapping searches
// (different niche keywords, re-runs while iterating), and a raw dump would
// otherwise repeat it with stale numbers. Keeps the most recently found
// record per channelId; niches it was found under are merged so that
// history isn't lost just because the latest hit came from a narrower
// keyword.
export function getAllFoundCandidatesDeduped(): (FoundCandidateEntry & { niches: string[]; channelUrl: string })[] {
  const entries = loadStore();
  const byChannel = new Map<string, FoundCandidateEntry & { niches: string[] }>();

  for (const entry of entries) {
    const existing = byChannel.get(entry.channelId);
    if (!existing) {
      byChannel.set(entry.channelId, { ...entry, niches: [entry.niche] });
      continue;
    }
    if (!existing.niches.includes(entry.niche)) existing.niches.push(entry.niche);
    if (entry.foundAt > existing.foundAt) {
      byChannel.set(entry.channelId, { ...entry, niches: existing.niches });
    }
  }

  // channelUrl is a pure derivation of channelId, not stored — every entry
  // ever logged already has channelId, so deriving it here means old
  // entries logged before this existed still get a working link, no
  // migration needed.
  return [...byChannel.values()]
    .map((c) => ({ ...c, channelUrl: `https://www.youtube.com/channel/${c.channelId}` }))
    .sort((a, b) => (a.foundAt < b.foundAt ? 1 : -1));
}
