// Follow-up timing rules from the IMA course FAQ ("How can I follow up
// mid-conversation?" / "When should I use a light or heavy follow-up?"):
// - only nudge on working days
// - a message sent late Friday doesn't get a Monday follow-up (not enough
//   real working time has passed, and Monday is hectic for most people) —
//   push it to Tuesday instead
// - space escalating follow-ups further apart each time rather than firing
//   them at a fixed interval, so it doesn't read as spammy/robotic

const DAY_MS = 24 * 60 * 60 * 1000;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6; // Sunday, Saturday
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// Escalating wait (in workdays) before each successive follow-up — spaced
// further apart each time so the cadence doesn't look automated.
const WORKDAY_GAPS = [2, 3, 4, 5, 6, 7, 7];

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

  const wasFridaySend = from.getUTCDay() === 5;
  if (wasFridaySend && date.getUTCDay() === 1) {
    // Friday send landing exactly on Monday — not enough real workday time
    // has passed and Monday is hectic anyway, so wait one more day.
    date = addDays(date, 1);
  }
  return date;
}

export function isDue(nextDate: Date, now: Date = new Date()): boolean {
  return now.getTime() >= nextDate.getTime();
}
