// Follow-up timing rules from the IMA course FAQ ("How can I follow up
// mid-conversation?" / "When should I use a light or heavy follow-up?"):
// - only nudge on working days
// - a message sent late Friday doesn't get a Monday follow-up (not enough
//   real working time has passed, and Monday is hectic for most people) —
//   push it to Tuesday instead
// - space escalating follow-ups further apart each time rather than firing
//   them at a fixed interval, so it doesn't read as spammy/robotic

const DAY_MS = 24 * 60 * 60 * 1000;

// Local day-of-week, not UTC. This whole module exists to protect specific
// local-calendar behavior (don't land on a weekend, don't land right after
// a Friday send) — using getUTCDay() instead of getDay() means a send near
// midnight in any timezone behind/ahead of UTC (Canada included) can read as
// the wrong day of the week entirely, silently defeating the exact rule
// this function was written to enforce.
function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday, Saturday
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// Escalating wait (in workdays) before each successive follow-up. Per the
// 2026 deliverability update, sequences longer than 2-3 total emails
// (initial + 1-2 follow-ups) are now themselves a spam-behavior signal to
// Gmail regardless of personalization quality, so this only covers the two
// follow-ups a thread is allowed (see MAX_FOLLOW_UPS_PER_THREAD in
// outreach-log.ts) — there is deliberately no long tail of gaps beyond that.
const WORKDAY_GAPS = [1, 3];

export function workdayGapForFollowUpNumber(followUpNumber: number): number {
  return WORKDAY_GAPS[Math.min(followUpNumber - 1, WORKDAY_GAPS.length - 1)];
}

// Advances `from` by `workdays` business days, then applies the
// Friday-afternoon rule: if the send would otherwise land on Friday evening
// (day 5) or Monday, push it to Tuesday so it doesn't hit right after the
// weekend when nobody reads outreach email.
export function nextFollowUpDate(from: Date, followUpNumber: number): Date {
  const gap = workdayGapForFollowUpNumber(followUpNumber);
  let date = new Date(from);
  let added = 0;
  while (added < gap) {
    date = addDays(date, 1);
    if (!isWeekend(date)) added++;
  }

  const wasFridaySend = from.getDay() === 5;
  if (wasFridaySend && date.getDay() === 1) {
    // Friday send landing exactly on Monday — not enough real workday time
    // has passed and Monday is hectic anyway, so wait one more day.
    date = addDays(date, 1);
  }
  return date;
}

export function isDue(nextDate: Date, now: Date = new Date()): boolean {
  return now.getTime() >= nextDate.getTime();
}
