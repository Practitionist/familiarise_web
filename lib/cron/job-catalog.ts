import {
  CLEANUP_JOB_BUILDERS,
  getCleanupJobHandlers,
} from "@/lib/cron/cleanup-registry";
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";
import type { JobCategory, SystemJobCard } from "@/lib/cron/job-categories";
import { scheduleFor, type JobSchedule } from "@/lib/cron/schedule";

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

/** A human label for a ticker schedule, read from the schedule catalog rather than copied. */
export function scheduleLabel(schedule: JobSchedule | undefined): string {
  if (!schedule) return "GitHub Actions (currently budget-blocked)";
  const every = cadence(schedule.everyMinutes);
  const w = schedule.window;
  if (!w) return every;
  const span = `${clock(w.startMinuteUtc)}–${clock(w.startMinuteUtc + w.windowMinutes)} UTC`;
  let days = "daily";
  if (w.weekdayUtc !== undefined) days = `on ${WEEKDAYS[w.weekdayUtc]}`;
  else if (w.dayOfMonthUtc !== undefined) {
    days = w.monthsUtc
      ? `on day ${w.dayOfMonthUtc} of months ${w.monthsUtc.join(", ")}`
      : `on day ${w.dayOfMonthUtc} of each month`;
  }
  return `${every}, ${span} ${days}`;
}

/** The serialisable job list the System Jobs page hands its client panel. */
export function systemJobCards(): SystemJobCard[] {
  return Object.entries(CLEANUP_JOB_BUILDERS).map(([id, { meta }]) => ({
    id,
    title: meta.title,
    description: meta.description,
    category: meta.category,
    schedule: scheduleLabel(scheduleFor(id)),
    confirmPhrase: runConfirmPhrase({
      id,
      jobName: getCleanupJobHandlers(id)?.job ?? id,
      category: meta.category,
    }),
  }));
}
