import {
  CLEANUP_JOB_BUILDERS,
  getCleanupJobHandlers,
} from "@/lib/cron/cleanup-registry";
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";
import type { JobCategory, SystemJobCard } from "@/lib/cron/job-categories";
import {
  isWindowedTarget,
  latestWindowStart,
  scheduleFor,
  type JobSchedule,
} from "@/lib/cron/schedule";

/** Money-list jobs that only expire unpaid orders and links; a reason is enough to run them. */
const NO_TYPED_CONFIRM = new Set(["cleanup-abandoned-payments"]);

/** A money job asks for a typed phrase: "RUN PAYOUTS" for the payout pair, else its own slug. */
export function runConfirmPhrase(job: {
  id: string;
  jobName: string;
  category: JobCategory;
}): string | null {
  if (
    !FINANCIAL_JOB_NAMES.has(job.jobName) ||
    NO_TYPED_CONFIRM.has(job.jobName)
  )
    return null;
  return job.category === "Payouts" ? "RUN PAYOUTS" : job.id;
}

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

function clock(minuteOfDay: number): string {
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function cadence(everyMinutes: number): string {
  if (everyMinutes === 60) return "Hourly";
  if (everyMinutes % 60 === 0) return `Every ${everyMinutes / 60} hours`;
  return `Every ${everyMinutes} minutes`;
}

// India keeps one offset all year, so the IST label is the UTC window shifted by it.
const IST_OFFSET_MINUTES = 330;

/** "10:00 IST to 12:00 IST", with "the next day" when the window crosses midnight. */
function windowSpan(start: number, end: number, zone: "IST" | "UTC"): string {
  const crossesMidnight = Math.floor(end / 1440) > Math.floor(start / 1440);
  const nextDay = crossesMidnight ? " the next day" : "";
  return `${clock(start)} ${zone} to ${clock(end)} ${zone}${nextDay}`;
}

function describeSchedule(
  schedule: JobSchedule | undefined,
  shiftMinutes: number,
  zone: "IST" | "UTC",
): string {
  if (!schedule) return "GitHub Actions (currently budget-blocked)";
  const every = cadence(schedule.everyMinutes);
  const w = schedule.window;
  if (!w) return every;
  const start = w.startMinuteUtc + shiftMinutes;
  const end = start + w.windowMinutes;
  // A window opening after 18:30 UTC opens on the next calendar day in IST.
  const startsNextDay = start >= 1440;
  const span =
    w.windowMinutes >= 1440 ? "all day" : windowSpan(start, end, zone);
  let days = "daily";
  if (w.weekdayUtc !== undefined) {
    days = `on ${WEEKDAYS[(w.weekdayUtc + (startsNextDay ? 1 : 0)) % 7]}`;
  } else if (w.dayOfMonthUtc !== undefined) {
    const day = startsNextDay
      ? `the day after day ${w.dayOfMonthUtc}`
      : `day ${w.dayOfMonthUtc}`;
    days = w.monthsUtc
      ? `on ${day} of months ${w.monthsUtc.join(", ")}`
      : `on ${day} of each month`;
  }
  return `${every}, ${span}, ${days}`;
}

/** A human label for a ticker schedule in IST, read from the schedule catalog rather than copied. */
export function scheduleLabel(schedule: JobSchedule | undefined): string {
  return describeSchedule(schedule, IST_OFFSET_MINUTES, "IST");
}

/** The same schedule as the catalog defines it, in UTC. */
export function scheduleLabelUtc(schedule: JobSchedule | undefined): string {
  return describeSchedule(schedule, 0, "UTC");
}

/** A windowed job repeats its latest due window by hand, so it cannot run before its first window. */
function runBlocked(id: string, now: Date): string | null {
  return isWindowedTarget(id) && !latestWindowStart(id, now)
    ? "No calendar window has come due yet, so there is no slice to repeat."
    : null;
}

/** The serialisable job list the System Jobs page hands its client panel. */
export function systemJobCards(now = new Date()): SystemJobCard[] {
  return Object.entries(CLEANUP_JOB_BUILDERS).map(([id, { meta }]) => ({
    id,
    title: meta.title,
    description: meta.description,
    category: meta.category,
    schedule: scheduleLabel(scheduleFor(id)),
    scheduleUtc: scheduleLabelUtc(scheduleFor(id)),
    confirmPhrase: runConfirmPhrase({
      id,
      jobName: getCleanupJobHandlers(id)?.job ?? id,
      category: meta.category,
    }),
    runBlocked: runBlocked(id, now),
  }));
}
