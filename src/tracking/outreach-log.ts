import fs from "node:fs";
import path from "node:path";
import { nextFollowUpDate, isDue } from "../utils/workdays";
import { withFileLock } from "../utils/file-lock";

// Tracks real outreach volume against the IMA program's actual milestone
// dates, so progress toward the 4x4 guarantee's requirements is measurable
// instead of guessed.

// Both halves of a channel's state (append-only send/reply history, and
// current negotiation/rating/check-in state) live in one file. These used
// to be two separate JSON files (outreach-log.json + negotiation-state.json)
// joined by channelId at read time — every call site that needed "the full
// picture" for a channel had to load and cross-reference both. One file
// means one lock and one load/save path for what's conceptually a single
// per-channel record. STORE_FILE keeps the outreach-log.json name so
// existing local data (and the milestone/contract history in it) doesn't
// need a rename; LEGACY_NEGOTIATION_FILE is only ever read once, to migrate
// any existing negotiation-state.json content in on first load after this
// change — new writes never touch it again.
const STORE_FILE = path.resolve("outreach-log.json");
const LEGACY_NEGOTIATION_FILE = path.resolve("negotiation-state.json");
const PROGRAM_START_DATE = process.env.PROGRAM_START_DATE ?? "2026-07-16"; // contract signing date

// 2026 deliverability update: sequences longer than 2-3 total emails
// (initial + follow-ups) are now themselves treated as a spam-behavior
// signal by Gmail, replacing the old FAQ guidance of following up up to 7
// times. After 2 follow-ups in the same thread with no reply, stop nudging
// that thread and start a fresh one with a different subject/angle instead.
const MAX_FOLLOW_UPS_PER_THREAD = 2;

interface OutreachEntry {
  timestamp: string; // ISO
  channelId: string;
  channelName: string;
  to: string;
  niche: string;
  // Absent = "youtube", for entries logged before this field existed (the
  // pipeline was YouTube-only at first) — TikTok/Instagram candidates are
  // entered manually (no public discovery API for either), so this is set
  // explicitly by the manual-add flow instead of being inferred.
  platform?: "youtube" | "tiktok" | "instagram" | "other";
  kind?: "initial" | "followup"; // absent = "initial", for entries logged before this field existed
  followUpNumber?: number; // 1-based, only for kind: "followup"
  gmailMessageId?: string;
  gmailThreadId?: string;
  rfcMessageId?: string; // RFC 822 Message-Id header, needed for In-Reply-To/References threading
  replied?: boolean; // set manually via markReplied() once the contact responds
}

// A send only counts toward the contract's real milestone numbers if it went
// to an actual person. Computed from the address itself (not a stored flag)
// so old entries logged before this distinction existed are still classified
// correctly without needing a migration.
export function isPlaceholderEmail(to: string): boolean {
  return /^outreach-placeholder\+/.test(to) || /@example\.com$/i.test(to);
}

// --- Negotiation state -----------------------------------------------------
// OutreachEntry above is an append-only history of sends; negotiation state
// is "current status per channel" — round number, last price on the table,
// deal status — a keyed upsert per channelId rather than another log entry
// shape. Both live in the same file/store (see STORE_FILE above).

export type DealStatus = "cold" | "replied" | "negotiating" | "closed" | "declined" | "parked";

export interface NegotiationState {
  channelId: string;
  channelName: string;
  negotiationRound: number; // 0 = no negotiation reply sent yet
  lastQuotedPrice?: number; // the creator's most recently stated price
  lastCounterOffered?: number; // the agency's most recent counter
  dealStatus: DealStatus;
  timelineSetAt?: string; // ISO — course rule: after provisional close, set and honor a specific next-steps timeline
  checkInsSent: number; // how many post-close check-ins have gone out since timelineSetAt
  lastCheckInAt?: string; // ISO
  // Course's tracking-sheet discipline: a running qualitative rating per
  // creator (1-5) so quality signal isn't lost across a growing list —
  // independent of deal status, since a low-quality creator can still
  // technically close.
  rating?: number;
  ratingNote?: string;
  // Manually-entered audience geography/demographics note — YouTube's API
  // doesn't expose this, so it's only ever populated when the user has
  // checked a media kit or equivalent themselves. Informational only, never
  // used to auto-skip a candidate — partial coverage (only candidates
  // someone bothered to check) shouldn't masquerade as a real filter.
  audienceNote?: string;
  updatedAt: string; // ISO
}

interface OutreachStore {
  entries: OutreachEntry[];
  channels: Record<string, NegotiationState>;
}

function loadStore(): OutreachStore {
  if (fs.existsSync(STORE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
    // Older outreach-log.json files predate the merge and have no
    // `channels` key at all — treat that as "no negotiation state yet"
    // rather than a migration case (the real migration case, a standalone
    // negotiation-state.json, is handled below).
    return { entries: parsed.entries ?? [], channels: parsed.channels ?? {} };
  }

  // One-time migration: this is the first load after the two-file ->
  // one-file merge, and neither file has been combined yet. Pull in
  // whatever negotiation-state.json already has on disk so existing ratings/
  // deal statuses aren't silently dropped; entries starts empty since
  // outreach-log.json not existing means there's no send history either.
  const channels = fs.existsSync(LEGACY_NEGOTIATION_FILE)
    ? (JSON.parse(fs.readFileSync(LEGACY_NEGOTIATION_FILE, "utf-8")) as { channels: Record<string, NegotiationState> }).channels
    : {};
  return { entries: [], channels };
}

function saveStore(store: OutreachStore) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

// Returns the current negotiation state for a channel, defaulting to a
// fresh "cold" record if nothing has been tracked yet — callers never have
// to null-check before reading a round number or deal status.
export function getNegotiationState(channelId: string, channelName?: string): NegotiationState {
  const store = loadStore();
  return (
    store.channels[channelId] ?? {
      channelId,
      channelName: channelName ?? channelId,
      negotiationRound: 0,
      dealStatus: "cold",
      checkInsSent: 0,
      updatedAt: new Date().toISOString(),
    }
  );
}

// Merges a partial update into a channel's negotiation state — used after
// each negotiation reply is sent (bump the round, record the latest
// price/counter) or whenever deal status changes (replied, closed, parked).
// Locked across the whole load -> merge -> save sequence: this is a
// read-modify-write, and without the lock two concurrent updates to the
// same channel (e.g. a rating from rate-creator.ts landing while
// run-negotiate.ts is recording a round) can silently drop one of them.
export async function updateNegotiationState(
  channelId: string,
  patch: Partial<Omit<NegotiationState, "channelId" | "updatedAt">> & { channelName?: string },
): Promise<NegotiationState> {
  return withFileLock(STORE_FILE, () => {
    const store = loadStore();
    const current =
      store.channels[channelId] ?? {
        channelId,
        channelName: patch.channelName ?? channelId,
        negotiationRound: 0,
        dealStatus: "cold" as DealStatus,
        checkInsSent: 0,
        updatedAt: new Date().toISOString(),
      };
    const next: NegotiationState = {
      ...current,
      ...patch,
      channelId,
      updatedAt: new Date().toISOString(),
    };
    store.channels[channelId] = next;
    saveStore(store);
    return next;
  });
}

// Convenience wrapper for the common case: a negotiation reply just went
// out — bump the round and record whatever price info applies.
export async function recordNegotiationRound(
  channelId: string,
  update: {
    channelName?: string;
    quotedPrice?: number;
    counterOffered?: number;
    dealStatus?: DealStatus;
  },
): Promise<NegotiationState> {
  const current = getNegotiationState(channelId, update.channelName);
  const dealStatus = update.dealStatus ?? (current.dealStatus === "cold" ? "negotiating" : current.dealStatus);

  // Course rule: once provisionally closed, set and honor a specific
  // next-steps timeline rather than going silent — start that clock the
  // moment the deal first flips to "closed," not on every subsequent update.
  const timelineSetAt = dealStatus === "closed" && !current.timelineSetAt ? new Date().toISOString() : current.timelineSetAt;

  return updateNegotiationState(channelId, {
    channelName: update.channelName ?? current.channelName,
    negotiationRound: current.negotiationRound + 1,
    lastQuotedPrice: update.quotedPrice ?? current.lastQuotedPrice,
    lastCounterOffered: update.counterOffered ?? current.lastCounterOffered,
    dealStatus,
    timelineSetAt,
  });
}

// Course's tracking-sheet discipline: a running qualitative rating per
// creator so quality signal survives a growing list. Independent of deal
// status — a creator can be rated at any point, not just at close.
export async function setCreatorRating(channelId: string, rating: number, note?: string, channelName?: string): Promise<NegotiationState> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`Rating must be an integer 1-5, got ${rating}`);
  }
  return updateNegotiationState(channelId, { channelName, rating, ratingNote: note });
}

// Course rule: after a creator is provisionally closed, proactively check
// in on a regular cadence (roughly weekly, within the course's 1-3 week
// normal outreach-to-brand-match window) rather than going silent — even
// with no news, an explicit check-in is tolerated far better than silence.
const CHECK_IN_INTERVAL_DAYS = 7;

export interface CheckInCandidate {
  channelId: string;
  channelName: string;
  dealStatus: DealStatus;
  timelineSetAt: string;
  checkInsSent: number;
  nextCheckInDate: string;
  due: boolean;
}

export function getCheckInsDue(now: Date = new Date()): CheckInCandidate[] {
  const store = loadStore();
  const candidates: CheckInCandidate[] = [];

  for (const state of Object.values(store.channels)) {
    if (state.dealStatus !== "closed" || !state.timelineSetAt) continue;

    const base = state.lastCheckInAt ? new Date(state.lastCheckInAt) : new Date(state.timelineSetAt);
    const nextCheckInDate = new Date(base.getTime() + CHECK_IN_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

    candidates.push({
      channelId: state.channelId,
      channelName: state.channelName,
      dealStatus: state.dealStatus,
      timelineSetAt: state.timelineSetAt,
      checkInsSent: state.checkInsSent,
      nextCheckInDate: nextCheckInDate.toISOString(),
      due: now.getTime() >= nextCheckInDate.getTime(),
    });
  }

  return candidates;
}

// Call once a post-close check-in message has actually been sent.
export async function recordCheckIn(channelId: string): Promise<NegotiationState> {
  const current = getNegotiationState(channelId);
  return updateNegotiationState(channelId, {
    checkInsSent: current.checkInsSent + 1,
    lastCheckInAt: new Date().toISOString(),
  });
}

// Deletes every logged entry and negotiation state for a channel — used by
// the Influencers tab's "Remove" button. Not the same as markReplied/"parked"
// (which still keep history); this actually erases the record, e.g. for a
// mistaken manual-add entry or a creator you no longer want tracked.
export async function removeContactedCreator(channelId: string): Promise<void> {
  await withFileLock(STORE_FILE, () => {
    const store = loadStore();
    store.entries = store.entries.filter((e) => e.channelId !== channelId);
    delete store.channels[channelId];
    saveStore(store);
  });
}

export async function recordOutreach(entry: Omit<OutreachEntry, "timestamp">): Promise<void> {
  // Locked for the same reason as updateNegotiationState: this is an
  // append, but "load -> push -> save" still loses a concurrent entry if
  // two sends land at the same instant without a lock around all three steps.
  await withFileLock(STORE_FILE, () => {
    const store = loadStore();
    store.entries.push({ ...entry, timestamp: new Date().toISOString() });
    saveStore(store);
  });
}

// Marks the most recent entry for a channel as replied-to, so it drops out
// of the follow-up queue. Call this as soon as you see a real reply land.
export async function markReplied(channelId: string): Promise<void> {
  await withFileLock(STORE_FILE, () => {
    const store = loadStore();
    const matches = store.entries.filter((e) => e.channelId === channelId);
    if (matches.length === 0) return;
    matches[matches.length - 1].replied = true;
    saveStore(store);
  });
}

export interface FollowUpCandidate {
  channelId: string;
  channelName: string;
  niche: string;
  to: string;
  lastSentAt: string;
  lastSubjectContext: string; // last known subject/thread context, for drafting
  followUpNumber: number; // which follow-up this would be (1-based)
  weight: "light" | "heavy";
  nextDueDate: string;
  due: boolean;
  gmailThreadId?: string;
  rfcMessageId?: string;
  needsNewThread: boolean; // true once MAX_FOLLOW_UPS_PER_THREAD reached with no reply
}

// Walks every channel's thread and figures out who's due for a follow-up
// right now, per the FAQ's escalating-wait rule. Only ever looks at the
// latest entry per channel, since a reply (marked via markReplied) or a
// fresh "kind: initial" entry (new thread/angle) resets the count.
export function getFollowUpQueue(now: Date = new Date()): FollowUpCandidate[] {
  const store = loadStore();
  const byChannel = new Map<string, OutreachEntry[]>();
  for (const entry of store.entries) {
    const list = byChannel.get(entry.channelId) ?? [];
    list.push(entry);
    byChannel.set(entry.channelId, list);
  }

  const queue: FollowUpCandidate[] = [];
  for (const [channelId, entries] of byChannel) {
    const last = entries[entries.length - 1];
    if (last.replied) continue;
    // No point nudging a fake/placeholder address — this is real-outreach
    // territory, not the mock pipeline.
    if (isPlaceholderEmail(last.to)) continue;

    // Count consecutive follow-ups since the last "initial" (i.e. since the
    // last fresh thread), so a new-thread restart resets the escalation.
    let sinceInitial: OutreachEntry[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      sinceInitial.unshift(entries[i]);
      if ((entries[i].kind ?? "initial") === "initial") break;
    }

    const followUpNumber = sinceInitial.length; // next follow-up's ordinal
    const needsNewThread = followUpNumber > MAX_FOLLOW_UPS_PER_THREAD;
    const nextDue = nextFollowUpDate(new Date(last.timestamp), followUpNumber);

    queue.push({
      channelId,
      channelName: last.channelName,
      niche: last.niche,
      to: last.to,
      lastSentAt: last.timestamp,
      lastSubjectContext: last.channelName,
      followUpNumber,
      // With only 2 follow-ups allowed total (see MAX_FOLLOW_UPS_PER_THREAD),
      // there's no room for a long "light for a while, then heavy" ramp —
      // the first follow-up stays light, the second (final, since a new
      // thread starts after this) is the only one that goes heavy.
      weight: followUpNumber >= 2 ? "heavy" : "light",
      nextDueDate: nextDue.toISOString(),
      due: !needsNewThread && isDue(nextDue, now),
      gmailThreadId: last.gmailThreadId,
      rfcMessageId: last.rfcMessageId,
      needsNewThread,
    });
  }

  return queue;
}

export interface ActiveThread {
  channelId: string;
  channelName: string;
  niche: string;
  to: string;
  gmailThreadId: string;
}

// Every real (non-placeholder), not-yet-replied thread that has a Gmail
// thread id on file — i.e. every conversation worth checking for a reply.
// Unlike getFollowUpQueue, this ignores due dates entirely: a reply can
// land at any time, not just when a follow-up happens to be due, so
// reply-checking needs the full set of open threads, not just the due ones.
export function getActiveThreads(): ActiveThread[] {
  const store = loadStore();
  const byChannel = new Map<string, OutreachEntry[]>();
  for (const entry of store.entries) {
    const list = byChannel.get(entry.channelId) ?? [];
    list.push(entry);
    byChannel.set(entry.channelId, list);
  }

  const threads: ActiveThread[] = [];
  for (const [channelId, entries] of byChannel) {
    const last = entries[entries.length - 1];
    if (last.replied) continue;
    if (isPlaceholderEmail(last.to)) continue;
    if (!last.gmailThreadId) continue; // sent before threading was added — nothing to check
    threads.push({ channelId, channelName: last.channelName, niche: last.niche, to: last.to, gmailThreadId: last.gmailThreadId });
  }
  return threads;
}

export interface ContactedCreatorSummary {
  channelId: string;
  channelName: string;
  to: string;
  niche: string;
  platform: "youtube" | "tiktok" | "instagram" | "other";
  firstContactedAt: string;
  lastContactedAt: string;
  timesContacted: number;
  replied: boolean;
  dealStatus: DealStatus;
}

// One row per unique channel/contact ever logged, newest-contacted first —
// the data source for the human-editable INFLUENCERS.md snapshot
// (report-influencers.ts). Real sends only, since placeholder/test runs to
// outreach-placeholder+/@example.com addresses never reached a real person.
export function getAllContactedCreators(): ContactedCreatorSummary[] {
  const store = loadStore();
  const byChannel = new Map<string, OutreachEntry[]>();
  for (const entry of store.entries) {
    if (isPlaceholderEmail(entry.to)) continue;
    const list = byChannel.get(entry.channelId) ?? [];
    list.push(entry);
    byChannel.set(entry.channelId, list);
  }

  const summaries: ContactedCreatorSummary[] = [];
  for (const [channelId, entries] of byChannel) {
    const first = entries[0];
    const last = entries[entries.length - 1];
    summaries.push({
      channelId,
      channelName: last.channelName,
      to: last.to,
      niche: last.niche,
      platform: last.platform ?? "youtube",
      firstContactedAt: first.timestamp,
      lastContactedAt: last.timestamp,
      timesContacted: entries.length,
      replied: entries.some((e) => e.replied),
      dealStatus: store.channels[channelId]?.dealStatus ?? "cold",
    });
  }

  return summaries.sort((a, b) => b.lastContactedAt.localeCompare(a.lastContactedAt));
}

export interface ContactHistory {
  contacted: boolean;
  lastContactedAt?: string;
  timesContacted: number;
}

// Checks whether a channel has already been emailed in a previous run —
// used to stop the same creator getting a duplicate outreach across
// separate `npm run dev` invocations, since each run otherwise starts fresh.
export function getContactHistory(channelId: string): ContactHistory {
  const store = loadStore();
  const matches = store.entries.filter((e) => e.channelId === channelId);
  if (matches.length === 0) {
    return { contacted: false, timesContacted: 0 };
  }
  const last = matches[matches.length - 1];
  return { contacted: true, lastContactedAt: last.timestamp, timesContacted: matches.length };
}

export interface LastSendInfo {
  to: string;
  niche: string;
  channelName: string;
  gmailThreadId?: string;
  rfcMessageId?: string;
}

// Looks up the most recent send to a channel so a negotiation reply can be
// threaded correctly without asking the human to paste a Gmail thread ID by
// hand — reuses the same threading data already captured for follow-ups.
export function getLastSendInfo(channelId: string): LastSendInfo | undefined {
  const store = loadStore();
  const matches = store.entries.filter((e) => e.channelId === channelId);
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  return {
    to: last.to,
    niche: last.niche,
    channelName: last.channelName,
    gmailThreadId: last.gmailThreadId,
    rfcMessageId: last.rfcMessageId,
  };
}

function daysSinceStart(): number {
  const start = new Date(PROGRAM_START_DATE);
  const now = new Date();
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

export interface MilestoneStatus {
  programDay: number;
  totalOutreaches: number; // real sends only — counts toward the contract
  outreachesToday: number; // real sends only
  placeholderCount: number; // test/mock sends logged, shown for visibility but never counted toward milestones
  phase: "day-0-50" | "day-50-120" | "day-120-plus";
  phaseTarget: number;
  phaseProgress: number; // count of REAL outreaches toward the current phase's target
  onTrack: boolean;
}

// Milestone rules from the signed IMA agreement:
//  - by day 50: 500 personalized influencer outreaches (or 5 closed partnerships)
//  - days 50-120: an additional ~2,500 brand outreaches (avg 36/day)
//
// Placeholder/test sends (mock pipeline runs to outreach-placeholder+...@example.com
// addresses) are excluded from every count here — they never reached a real
// person, so they can't be allowed to count toward a contractual guarantee.
export function getMilestoneStatus(): MilestoneStatus {
  const store = loadStore();
  const programDay = daysSinceStart();

  const realEntries = store.entries.filter((e) => !isPlaceholderEmail(e.to));
  const placeholderCount = store.entries.length - realEntries.length;
  const totalOutreaches = realEntries.length;

  const today = new Date().toISOString().slice(0, 10);
  const outreachesToday = realEntries.filter((e) => e.timestamp.startsWith(today)).length;

  let phase: MilestoneStatus["phase"];
  let phaseTarget: number;
  let phaseProgress: number;

  if (programDay <= 50) {
    phase = "day-0-50";
    phaseTarget = 500;
    phaseProgress = totalOutreaches;
  } else if (programDay <= 120) {
    phase = "day-50-120";
    phaseTarget = 2500;
    // Count only outreaches sent after day 50 toward this phase's target.
    const day50Cutoff = new Date(new Date(PROGRAM_START_DATE).getTime() + 50 * 24 * 60 * 60 * 1000);
    phaseProgress = realEntries.filter((e) => new Date(e.timestamp) >= day50Cutoff).length;
  } else {
    phase = "day-120-plus";
    phaseTarget = 2500;
    const day50Cutoff = new Date(new Date(PROGRAM_START_DATE).getTime() + 50 * 24 * 60 * 60 * 1000);
    phaseProgress = realEntries.filter((e) => new Date(e.timestamp) >= day50Cutoff).length;
  }

  // Rough pacing check: are we on track for the phase's deadline given elapsed days?
  const phaseDeadlineDay = phase === "day-0-50" ? 50 : 120;
  const phaseStartDay = phase === "day-0-50" ? 0 : 50;
  const phaseElapsed = Math.max(programDay - phaseStartDay, 1);
  const phaseWindow = phaseDeadlineDay - phaseStartDay;
  const expectedByNow = Math.round((phaseElapsed / phaseWindow) * phaseTarget);
  const onTrack = phaseProgress >= expectedByNow;

  return {
    programDay,
    totalOutreaches,
    outreachesToday,
    placeholderCount,
    phase,
    phaseTarget,
    phaseProgress,
    onTrack,
  };
}
