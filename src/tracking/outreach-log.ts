import fs from "node:fs";
import path from "node:path";
import { nextFollowUpDate, isDue } from "../utils/workdays";

// Tracks real outreach volume against the IMA program's actual milestone
// dates, so progress toward the 4x4 guarantee's requirements is measurable
// instead of guessed.

const LOG_FILE = path.resolve("outreach-log.json");
const PROGRAM_START_DATE = process.env.PROGRAM_START_DATE ?? "2026-07-16"; // contract signing date

// FAQ "Followed up 7 times, no responses, what to do?": after 7 follow-ups
// in the same thread with no reply, stop nudging that thread and start a
// fresh one with a different subject/angle instead.
const MAX_FOLLOW_UPS_PER_THREAD = 7;

interface OutreachEntry {
  timestamp: string; // ISO
  channelId: string;
  channelName: string;
  to: string;
  niche: string;
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
// Separate from OutreachEntry above: OutreachEntry is an append-only history
// of sends, but negotiation state is "current status per channel" — round
// number, last price on the table, deal status — so it's a keyed upsert
// store in its own file rather than another log entry shape.

const NEGOTIATION_FILE = path.resolve("negotiation-state.json");

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
  updatedAt: string; // ISO
}

interface NegotiationStore {
  channels: Record<string, NegotiationState>;
}

function loadNegotiationStore(): NegotiationStore {
  if (fs.existsSync(NEGOTIATION_FILE)) {
    return JSON.parse(fs.readFileSync(NEGOTIATION_FILE, "utf-8")) as NegotiationStore;
  }
  return { channels: {} };
}

function saveNegotiationStore(store: NegotiationStore) {
  fs.writeFileSync(NEGOTIATION_FILE, JSON.stringify(store, null, 2));
}

// Returns the current negotiation state for a channel, defaulting to a
// fresh "cold" record if nothing has been tracked yet — callers never have
// to null-check before reading a round number or deal status.
export function getNegotiationState(channelId: string, channelName?: string): NegotiationState {
  const store = loadNegotiationStore();
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
export function updateNegotiationState(
  channelId: string,
  patch: Partial<Omit<NegotiationState, "channelId" | "updatedAt">> & { channelName?: string },
): NegotiationState {
  const store = loadNegotiationStore();
  const current = getNegotiationState(channelId, patch.channelName);
  const next: NegotiationState = {
    ...current,
    ...patch,
    channelId,
    updatedAt: new Date().toISOString(),
  };
  store.channels[channelId] = next;
  saveNegotiationStore(store);
  return next;
}

// Convenience wrapper for the common case: a negotiation reply just went
// out — bump the round and record whatever price info applies.
export function recordNegotiationRound(
  channelId: string,
  update: {
    channelName?: string;
    quotedPrice?: number;
    counterOffered?: number;
    dealStatus?: DealStatus;
  },
): NegotiationState {
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
export function setCreatorRating(channelId: string, rating: number, note?: string, channelName?: string): NegotiationState {
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
  const store = loadNegotiationStore();
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
export function recordCheckIn(channelId: string): NegotiationState {
  const current = getNegotiationState(channelId);
  return updateNegotiationState(channelId, {
    checkInsSent: current.checkInsSent + 1,
    lastCheckInAt: new Date().toISOString(),
  });
}

interface OutreachLog {
  entries: OutreachEntry[];
}

function loadLog(): OutreachLog {
  if (fs.existsSync(LOG_FILE)) {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8")) as OutreachLog;
  }
  return { entries: [] };
}

function saveLog(log: OutreachLog) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

export function recordOutreach(entry: Omit<OutreachEntry, "timestamp">) {
  const log = loadLog();
  log.entries.push({ ...entry, timestamp: new Date().toISOString() });
  saveLog(log);
}

// Marks the most recent entry for a channel as replied-to, so it drops out
// of the follow-up queue. Call this as soon as you see a real reply land.
export function markReplied(channelId: string) {
  const log = loadLog();
  const matches = log.entries.filter((e) => e.channelId === channelId);
  if (matches.length === 0) return;
  matches[matches.length - 1].replied = true;
  saveLog(log);
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
  const log = loadLog();
  const byChannel = new Map<string, OutreachEntry[]>();
  for (const entry of log.entries) {
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
      // Heavy follow-ups are for when a real deal/deadline is on the line —
      // default to light for the first few, only escalate to heavy once
      // several light nudges have gone unanswered.
      weight: followUpNumber >= 4 ? "heavy" : "light",
      nextDueDate: nextDue.toISOString(),
      due: !needsNewThread && isDue(nextDue, now),
      gmailThreadId: last.gmailThreadId,
      rfcMessageId: last.rfcMessageId,
      needsNewThread,
    });
  }

  return queue;
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
  const log = loadLog();
  const matches = log.entries.filter((e) => e.channelId === channelId);
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
  const log = loadLog();
  const matches = log.entries.filter((e) => e.channelId === channelId);
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
  const log = loadLog();
  const programDay = daysSinceStart();

  const realEntries = log.entries.filter((e) => !isPlaceholderEmail(e.to));
  const placeholderCount = log.entries.length - realEntries.length;
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
