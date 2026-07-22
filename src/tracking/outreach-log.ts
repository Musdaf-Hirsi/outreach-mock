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

function daysSinceStart(): number {
  const start = new Date(PROGRAM_START_DATE);
  const now = new Date();
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

export interface MilestoneStatus {
  programDay: number;
  totalOutreaches: number;
  outreachesToday: number;
  phase: "day-0-50" | "day-50-120" | "day-120-plus";
  phaseTarget: number;
  phaseProgress: number; // count of outreaches counted toward the current phase's target
  onTrack: boolean;
}

// Milestone rules from the signed IMA agreement:
//  - by day 50: 500 personalized influencer outreaches (or 5 closed partnerships)
//  - days 50-120: an additional ~2,500 brand outreaches (avg 36/day)
export function getMilestoneStatus(): MilestoneStatus {
  const log = loadLog();
  const programDay = daysSinceStart();
  const totalOutreaches = log.entries.length;

  const today = new Date().toISOString().slice(0, 10);
  const outreachesToday = log.entries.filter((e) => e.timestamp.startsWith(today)).length;

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
    phaseProgress = log.entries.filter((e) => new Date(e.timestamp) >= day50Cutoff).length;
  } else {
    phase = "day-120-plus";
    phaseTarget = 2500;
    const day50Cutoff = new Date(new Date(PROGRAM_START_DATE).getTime() + 50 * 24 * 60 * 60 * 1000);
    phaseProgress = log.entries.filter((e) => new Date(e.timestamp) >= day50Cutoff).length;
  }

  // Rough pacing check: are we on track for the phase's deadline given elapsed days?
  const phaseDeadlineDay = phase === "day-0-50" ? 50 : 120;
  const phaseStartDay = phase === "day-0-50" ? 0 : 50;
  const phaseElapsed = Math.max(programDay - phaseStartDay, 1);
  const phaseWindow = phaseDeadlineDay - phaseStartDay;
  const expectedByNow = Math.round((phaseElapsed / phaseWindow) * phaseTarget);
  const onTrack = phaseProgress >= expectedByNow;

  return { programDay, totalOutreaches, outreachesToday, phase, phaseTarget, phaseProgress, onTrack };
}
