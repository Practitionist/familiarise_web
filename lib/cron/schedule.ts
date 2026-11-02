/** Pure schedule catalog shared by runtime dispatch, health checks and operational documentation. */

/** Relative to `/api/cleanup/`. Order is cosmetic — every request fires in parallel. */
export const STREAM_LIFECYCLE_JOBS = [
  "expire-recordings",
  "reconcile-orphaned-recordings",
  "wind-down-deactivated-orgs",
  "stream-sync",
  "expire-event-channels",
] as const;

export const TARGETS = [
  "sweep-stuck-webhook-events",
  "reconcile-refunds",
  "abandoned-payments",
  "reconcile-payment-status",
  "reconcile-org-invoice-payments",
  "reconcile-orphaned-confirmations",
  "sweep-orphaned-topup-captures",
  "dispatch-outbound-webhooks",
  "sync-payment-earnings",
  "release-earnings",
  "retry-failed-emails",
  "drain-notification-outbox",
  "expire-unpaid-trials",
  "reschedule-proposals",
  "appointment-reminders",
  "tentative-occurrences",
  "expire-stale-requests",
  "auto-complete-appointments",
  "detect-consultant-no-shows",
  "settle-cancelled-sessions",
  "settle-platform-incidents",
  "maintenance-booking-remediation",
  "retry-auto-refunds",
  "alert-orphaned-payments",
  "reconcile-orphaned-payments",
  "sentry-ingest-canary",
  "handle-stuck-payouts",
  "reconcile-payout-status",
  "process-data-exports",
  "retry-moderation-enforcement",
  "reconcile-stream-memberships",
  "vest-referral-credits",
  "support-sla-sweep",
  "purge-deleted-documents",
  "process-payouts",
  "reconcile-disputes",
  "create-payout-batch",
  "settle-invoice-accruals",
  "expire-referral-credits",
  "gst-outward-register-export",
  "generate-subscription-invoices",
  "abandoned-org-top-ups",
  "advance-program-cycles",
  "auto-renew-contracts",
  "irp-uploader",
  "heal-consumer-invoices",
  "sweep-abandoned-overage-charges",
  "expire-contracts",
  "msme-payment-alerts",
  "timeout-member-overages",
  "dunning",
  "wallet-low-balance",
  "reconcile-gateway-settlements",
  "reconcile-ledgers",
  "tds-return-draft",
  "stream-control-plane-drift",
  "transfer-recordings",
  "reconcile-sessions",
  "prune-system-job-executions",
  "prune-system-events",
  "databreach-deadline-alerts",
  "reconcile-occurrence-availability",
  "auth-tokens",
  "reconcile-document-storage",
  "prune-audit-logs",
  "sweep-verification",
  "expire-stale-collaborator-invites",
  "purge-unverified-users",
  "archive-webhook-events",
  "consent-retention-sweeper",
  "expire-onboarding-drafts",
  ...STREAM_LIFECYCLE_JOBS,
] as const;

export type Target = (typeof TARGETS)[number];

/** The ticker's per-slot claim rows; bookkeeping, not a job run, so job views exclude it. */
export const TICK_CLAIM_JOB = "cron-tick";

/**
 * The `SystemJobExecution.jobName` a target's core writes when it differs from the
 * target name; `null` means the core writes no execution row.
 */
const JOB_NAME_OVERRIDES: Partial<Record<Target, string | null>> = {
  "reconcile-refunds": "reconcile-pending-refunds",
  "abandoned-payments": "cleanup-abandoned-payments",
  "reschedule-proposals": "expire-reschedule-proposals",
  "appointment-reminders": "send-appointment-reminders",
  "tentative-occurrences": "cleanup-tentative-occurrences",
  "abandoned-org-top-ups": "cleanup-abandoned-org-top-ups",
  "tds-return-draft": "tds-26q-draft-export",
  "reconcile-sessions": "reconcile-orphaned-sessions",
  "auth-tokens": "cleanup-auth-tokens",
  "sentry-ingest-canary": null,
  "stream-control-plane-drift": null,
};

export function jobNameFor(target: Target): string | null {
  return target in JOB_NAME_OVERRIDES
    ? (JOB_NAME_OVERRIDES[target] ?? null)
    : target;
}

/** Background targets acknowledge admission; their cores record eventual completion. */
export const TARGET_BACKGROUND_FUNCTIONS: Partial<Record<Target, string>> = {
  "transfer-recordings": "recording-transfer-background",
  "expire-recordings": "stream-maintenance-background",
  "reconcile-orphaned-recordings": "stream-maintenance-background",
  "wind-down-deactivated-orgs": "stream-maintenance-background",
  "stream-sync": "stream-maintenance-background",
  "expire-event-channels": "stream-maintenance-background",
};

/** The batch size a target gets when it is not listed in {@link TARGET_LIMITS}. */
const DEFAULT_LIMIT = 50;

/** Per-invocation row limits; null preserves a job-specific non-row request. */
const TARGET_LIMITS: Partial<Record<Target, number | null>> = {
  "abandoned-payments": 10,
  "dispatch-outbound-webhooks": 15,
  "retry-failed-emails": 20,
  "drain-notification-outbox": 20,
  "reconcile-orphaned-confirmations": 10,
  "vest-referral-credits": 10,
  "settle-cancelled-sessions": 10,
  "settle-platform-incidents": 10,
  "maintenance-booking-remediation": 1,
  "retry-auto-refunds": 10,
  "appointment-reminders": 25,
  "expire-stale-requests": 20,
  "reschedule-proposals": 25,
  "tentative-occurrences": 200,
  "expire-unpaid-trials": 25,
  "auto-complete-appointments": 25,
  "detect-consultant-no-shows": 10,
  "alert-orphaned-payments": 10,
  "reconcile-orphaned-payments": 10,
  "reconcile-refunds": 10,
  "reconcile-org-invoice-payments": 5,
  "support-sla-sweep": 20,
  "purge-deleted-documents": 100,
  "process-payouts": 5,
  "handle-stuck-payouts": 5,
  "reconcile-payout-status": 8,
  "create-payout-batch": 10,
  "settle-invoice-accruals": 10,
  "expire-referral-credits": 50,
  "gst-outward-register-export": 25,
  "generate-subscription-invoices": 10,
  "abandoned-org-top-ups": 200,
  "advance-program-cycles": 25,
  "auto-renew-contracts": 10,
  "irp-uploader": 10,
  "heal-consumer-invoices": 25,
  "sweep-abandoned-overage-charges": 25,
  "expire-contracts": 10,
  "msme-payment-alerts": null,
  "timeout-member-overages": 25,
  dunning: 25,
  "wallet-low-balance": 25,
  "reconcile-gateway-settlements": null,
  "reconcile-disputes": 10,
  "reconcile-ledgers": null,
  "tds-return-draft": null,
  "reconcile-stream-memberships": 50,
  "stream-control-plane-drift": null,
  "transfer-recordings": null,
  "reconcile-sessions": 5,
  "prune-system-job-executions": 500,
  "prune-system-events": 500,
  "databreach-deadline-alerts": 50,
  "reconcile-occurrence-availability": null,
  "auth-tokens": null,
  "reconcile-document-storage": null,
  "prune-audit-logs": 500,
  "sweep-verification": null,
  "expire-stale-collaborator-invites": null,
  "purge-unverified-users": null,
  "archive-webhook-events": null,
  // Count-only: deletion stays behind the route's explicit delete flag.
  "consent-retention-sweeper": 500,
  "expire-onboarding-drafts": null,
  "expire-recordings": null,
  "reconcile-orphaned-recordings": null,
  "wind-down-deactivated-orgs": null,
  "stream-sync": null,
  "expire-event-channels": null,
};

/**
 * Targets that run on a multiple of the five-minute tick. A missing entry means
 * every tick. The check is on the minute of the UTC day, so an interval must
 * divide 1,440 and a late tick (Netlify fires within the minute) still counts
 * as its slot.
 */
export const TARGET_EVERY_MINUTES: Partial<Record<Target, number>> = {
  "sweep-stuck-webhook-events": 15,
  "sweep-orphaned-topup-captures": 15,
  "dispatch-outbound-webhooks": 15,
  "drain-notification-outbox": 10,
  "retry-failed-emails": 15,
  "sentry-ingest-canary": 1440,
  "sync-payment-earnings": 15,
  "release-earnings": 15,
  "reconcile-refunds": 15,
  "abandoned-payments": 15,
  "reconcile-payment-status": 15,
  "reconcile-org-invoice-payments": 240,
  "reconcile-orphaned-confirmations": 15,
  "expire-unpaid-trials": 15,
  "reschedule-proposals": 15,
  "appointment-reminders": 15,
  "tentative-occurrences": 15,
  "expire-stale-requests": 15,
  "settle-cancelled-sessions": 30,
  "settle-platform-incidents": 60,
  "maintenance-booking-remediation": 15,
  "retry-auto-refunds": 15,
  "auto-complete-appointments": 30,
  "detect-consultant-no-shows": 30,
  "alert-orphaned-payments": 15,
  "reconcile-orphaned-payments": 30,
  "process-data-exports": 10,
  "retry-moderation-enforcement": 30,
  "vest-referral-credits": 30,
  "support-sla-sweep": 30,
  "purge-deleted-documents": 60,
  "process-payouts": 60,
  "handle-stuck-payouts": 120,
  "reconcile-payout-status": 120,
  "create-payout-batch": 15,
  "settle-invoice-accruals": 60,
  "expire-referral-credits": 60,
  "gst-outward-register-export": 60,
  "generate-subscription-invoices": 60,
  "abandoned-org-top-ups": 60,
  "advance-program-cycles": 60,
  "auto-renew-contracts": 60,
  "irp-uploader": 60,
  "heal-consumer-invoices": 360,
  "sweep-abandoned-overage-charges": 60,
  "expire-contracts": 60,
  "msme-payment-alerts": 60,
  "timeout-member-overages": 60,
  dunning: 60,
  "wallet-low-balance": 60,
  "reconcile-gateway-settlements": 60,
  "reconcile-disputes": 60,
  "reconcile-ledgers": 60,
  "tds-return-draft": 60,
  "reconcile-stream-memberships": 60,
  "stream-control-plane-drift": 60,
  "transfer-recordings": 15,
  "reconcile-sessions": 30,
  "prune-system-job-executions": 30,
  "prune-system-events": 60,
  "databreach-deadline-alerts": 60,
  "reconcile-occurrence-availability": 60,
  "auth-tokens": 1440,
  "reconcile-document-storage": 1440,
  "prune-audit-logs": 1440,
  "sweep-verification": 1440,
  "expire-stale-collaborator-invites": 1440,
  "purge-unverified-users": 1440,
  "archive-webhook-events": 1440,
  "consent-retention-sweeper": 1440,
  "expire-onboarding-drafts": 1440,
  "expire-recordings": 60,
  "reconcile-orphaned-recordings": 60,
  "wind-down-deactivated-orgs": 60,
  "stream-sync": 60,
  "expire-event-channels": 60,
};

/**
 * Deterministic phase offsets (in minutes, modulo each target's interval).
 * Interval targets fill busy ticks, so each addition is
 * placed on a minute whose worst-case tick (month start, Monday, quarter start)
 * still has room; the cadence test pins {@link MAX_TARGETS_PER_TICK}.
 */
export const TARGET_OFFSET_MINUTES: Partial<Record<Target, number>> = {
  "sweep-stuck-webhook-events": 0,
  "sweep-orphaned-topup-captures": 0,
  "dispatch-outbound-webhooks": 0,
  "retry-failed-emails": 5,
  "sync-payment-earnings": 0,
  "alert-orphaned-payments": 0,
  "sentry-ingest-canary": 50,
  "release-earnings": 5,
  "reconcile-refunds": 5,
  "abandoned-payments": 5,
  "reconcile-payment-status": 5,
  "reconcile-org-invoice-payments": 235,
  "reconcile-orphaned-confirmations": 5,
  "expire-unpaid-trials": 5,
  "drain-notification-outbox": 5,
  "reschedule-proposals": 10,
  "appointment-reminders": 10,
  "tentative-occurrences": 10,
  "expire-stale-requests": 10,
  "settle-cancelled-sessions": 25,
  "settle-platform-incidents": 30,
  "maintenance-booking-remediation": 0,
  "retry-auto-refunds": 10,
  "auto-complete-appointments": 15,
  "detect-consultant-no-shows": 20,
  "reconcile-orphaned-payments": 10,
  "process-data-exports": 0,
  "retry-moderation-enforcement": 25,
  "vest-referral-credits": 5,
  "support-sla-sweep": 10,
  "purge-deleted-documents": 25,
  "process-payouts": 0,
  "reconcile-disputes": 0,
  "create-payout-batch": 5,
  "generate-subscription-invoices": 5,
  "abandoned-org-top-ups": 10,
  "advance-program-cycles": 15,
  "auto-renew-contracts": 20,
  "irp-uploader": 25,
  "heal-consumer-invoices": 110,
  "sweep-abandoned-overage-charges": 30,
  "expire-contracts": 35,
  "msme-payment-alerts": 45,
  "settle-invoice-accruals": 45,
  "expire-referral-credits": 50,
  "gst-outward-register-export": 45,
  "handle-stuck-payouts": 40,
  "reconcile-payout-status": 100,
  "timeout-member-overages": 35,
  dunning: 10,
  "wallet-low-balance": 45,
  "reconcile-gateway-settlements": 55,
  "reconcile-ledgers": 55,
  "tds-return-draft": 55,
  "reconcile-stream-memberships": 20,
  "stream-control-plane-drift": 15,
  "transfer-recordings": 0,
  "reconcile-sessions": 10,
  "prune-system-job-executions": 25,
  "prune-system-events": 10,
  "databreach-deadline-alerts": 15,
  "reconcile-occurrence-availability": 30,
  "auth-tokens": 180,
  "reconcile-document-storage": 185,
  "prune-audit-logs": 190,
  "sweep-verification": 200,
  "expire-stale-collaborator-invites": 205,
  "purge-unverified-users": 215,
  "archive-webhook-events": 20,
  "consent-retention-sweeper": 25,
  "expire-onboarding-drafts": 35,
  "expire-recordings": 5,
  "reconcile-orphaned-recordings": 25,
  "wind-down-deactivated-orgs": 55,
  "stream-sync": 50,
  "expire-event-channels": 55,
};

/** Regression ceiling for due work, enforced by the calendar test. */
export const MAX_TARGETS_PER_TICK = 12;

/**
 * A UTC calendar window. Inside it the target fires on its every/offset slots;
 * outside it never. `weekdayUtc` (0 = Sunday), `dayOfMonthUtc` and `monthsUtc`
 * (1 = January) are checked against the window's start, so a window may run
 * past midnight.
 */
export interface CalendarWindow {
  startMinuteUtc: number;
  windowMinutes: number;
  weekdayUtc?: number;
  dayOfMonthUtc?: number;
  monthsUtc?: readonly number[];
}
const DAILY_0300: CalendarWindow = { startMinuteUtc: 180, windowMinutes: 1020 };
const DAILY_2330: CalendarWindow = { startMinuteUtc: 1410, windowMinutes: 180 };
/** Sunday 00:00–01:00 UTC; each weekly target fires once on its own offset inside it. */
const WEEKLY_SUNDAY: CalendarWindow = {
  weekdayUtc: 0,
  startMinuteUtc: 0,
  windowMinutes: 60,
};
/** Retention band between the daytime money window and the 23:30 one. */
const DAILY_RETENTION: CalendarWindow = {
  startMinuteUtc: 1200,
  windowMinutes: 210,
};

/** Every windowed target re-runs on its slots until the window closes; each run is a bounded, claim-based slice. */
export const TARGET_WINDOWS: Partial<Record<Target, CalendarWindow>> = {
  "expire-recordings": { startMinuteUtc: 0, windowMinutes: 180 },
  "reconcile-orphaned-recordings": { startMinuteUtc: 0, windowMinutes: 180 },
  "wind-down-deactivated-orgs": { startMinuteUtc: 180, windowMinutes: 180 },
  "stream-sync": { startMinuteUtc: 480, windowMinutes: 180 },
  "expire-event-channels": { startMinuteUtc: 480, windowMinutes: 180 },
  "create-payout-batch": {
    weekdayUtc: 1,
    startMinuteUtc: 1200,
    windowMinutes: 180,
  },
  "settle-invoice-accruals": {
    dayOfMonthUtc: 1,
    startMinuteUtc: 240,
    windowMinutes: 960,
  },
  "expire-referral-credits": {
    dayOfMonthUtc: 1,
    startMinuteUtc: 190,
    windowMinutes: 180,
  },
  "gst-outward-register-export": {
    dayOfMonthUtc: 2,
    startMinuteUtc: 240,
    windowMinutes: 1140,
  },
  "generate-subscription-invoices": DAILY_0300,
  "abandoned-org-top-ups": DAILY_0300,
  "advance-program-cycles": DAILY_0300,
  "auto-renew-contracts": DAILY_0300,
  "irp-uploader": DAILY_0300,
  // All day, from its first slot.
  "heal-consumer-invoices": { startMinuteUtc: 110, windowMinutes: 1440 },
  "sweep-abandoned-overage-charges": DAILY_0300,
  "expire-contracts": DAILY_0300,
  "msme-payment-alerts": { startMinuteUtc: 180, windowMinutes: 60 },
  "timeout-member-overages": DAILY_2330,
  dunning: DAILY_2330,
  "wallet-low-balance": DAILY_2330,
  "reconcile-gateway-settlements": { startMinuteUtc: 390, windowMinutes: 360 },
  "tds-return-draft": {
    dayOfMonthUtc: 5,
    monthsUtc: [1, 4, 7, 10],
    startMinuteUtc: 60,
    windowMinutes: 120,
  },
  "reconcile-stream-memberships": { startMinuteUtc: 0, windowMinutes: 180 },
  "stream-control-plane-drift": { startMinuteUtc: 75, windowMinutes: 60 },
  "prune-system-job-executions": DAILY_RETENTION,
  "prune-system-events": DAILY_RETENTION,
  "archive-webhook-events": WEEKLY_SUNDAY,
  "consent-retention-sweeper": WEEKLY_SUNDAY,
  "expire-onboarding-drafts": WEEKLY_SUNDAY,
};

/**
 * The start of the window `now` falls in, or null when the target is windowed
 * and `now` is outside it. Exported so a test can pin the calendar gate.
 */
export function windowStartFor(name: Target, now: Date): Date | null {
  const w = TARGET_WINDOWS[name];
  if (!w) return null;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const sinceStart = (((minuteOfDay - w.startMinuteUtc) % 1440) + 1440) % 1440;
  if (sinceStart >= w.windowMinutes) return null;
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      minuteOfDay - sinceStart,
    ),
  );
  if (w.weekdayUtc !== undefined && start.getUTCDay() !== w.weekdayUtc) {
    return null;
  }
  if (w.dayOfMonthUtc !== undefined && start.getUTCDate() !== w.dayOfMonthUtc) {
    return null;
  }
  if (w.monthsUtc && !w.monthsUtc.includes(start.getUTCMonth() + 1)) {
    return null;
  }
  return start;
}

/** How far back a calendar window (weekly, monthly, quarterly) is searched. */
const WINDOW_SEARCH_DAYS = 400;
const DAY_MS = 24 * 60 * 60_000;
const WINDOWED_TARGETS: ReadonlySet<string> = new Set(
  Object.keys(TARGET_WINDOWS),
);

export function isWindowedTarget(name: string): name is Target {
  return WINDOWED_TARGETS.has(name);
}

/** The start of the newest window that opened at or before `at`, or null when none has in the search range. */
export function latestWindowStart(name: Target, at: Date): Date | null {
  const w = TARGET_WINDOWS[name];
  if (!w) return null;
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  for (let d = 0; d <= WINDOW_SEARCH_DAYS; d++) {
    const start = new Date(day - d * DAY_MS + w.startMinuteUtc * 60_000);
    if (start.getTime() > at.getTime()) continue;
    if (windowStartFor(name, start)?.getTime() === start.getTime()) {
      return start;
    }
  }
  return null;
}

/** The targets due on this tick; exported so a test can pin the cadence. */
export function dueTargets(now: Date): Target[] {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const due = TARGETS.filter((name) => {
    if (name in TARGET_WINDOWS && windowStartFor(name, now) === null) {
      return false;
    }
    const every = TARGET_EVERY_MINUTES[name];
    if (every === undefined) return true;
    const offset = TARGET_OFFSET_MINUTES[name] ?? 0;
    return (((minuteOfDay - offset) % every) + every) % every < 5;
  });
  // The ledger report persists its cursor and yields past the cap; other jobs keep their slots.
  return due.length > MAX_TARGETS_PER_TICK
    ? due.filter((name) => name !== "reconcile-ledgers")
    : due;
}

/** Well under the 26 s Next function ceiling and the 30 s scheduled-function cap. */
const PER_TARGET_TIMEOUT_MS = 15_000;

/** 20 s still sits under the 30 s scheduled cap for gateway/outbox round-trip sweeps. */
const TARGET_TIMEOUTS_MS: Partial<Record<Target, number>> = {
  "abandoned-payments": 20_000,
  "retry-failed-emails": 20_000,
  "drain-notification-outbox": 20_000,
  "reconcile-orphaned-confirmations": 20_000,
  "appointment-reminders": 20_000,
  "expire-stale-requests": 20_000,
  "reschedule-proposals": 20_000,
  "settle-cancelled-sessions": 20_000,
  "settle-platform-incidents": 20_000,
  "retry-auto-refunds": 20_000,
  "vest-referral-credits": 20_000,
  "reconcile-refunds": 20_000,
  "reconcile-org-invoice-payments": 24_000,
  "auto-complete-appointments": 24_000,
  "detect-consultant-no-shows": 24_000,
  "alert-orphaned-payments": 20_000,
  "reconcile-orphaned-payments": 20_000,
  "process-data-exports": 20_000,
  "purge-deleted-documents": 20_000,
  "retry-moderation-enforcement": 20_000,
  "process-payouts": 24_000,
  "handle-stuck-payouts": 24_000,
  "reconcile-payout-status": 24_000,
  "gst-outward-register-export": 24_000,
  "create-payout-batch": 20_000,
  "settle-invoice-accruals": 20_000,
  "expire-referral-credits": 20_000,
  "generate-subscription-invoices": 20_000,
  "advance-program-cycles": 20_000,
  "auto-renew-contracts": 20_000,
  "irp-uploader": 20_000,
  "heal-consumer-invoices": 20_000,
  "sweep-abandoned-overage-charges": 20_000,
  "expire-contracts": 20_000,
  "msme-payment-alerts": 20_000,
  "timeout-member-overages": 20_000,
  dunning: 20_000,
  "wallet-low-balance": 20_000,
  "reconcile-gateway-settlements": 20_000,
  "reconcile-disputes": 20_000,
  "reconcile-ledgers": 20_000,
  "tds-return-draft": 20_000,
  "reconcile-stream-memberships": 24_000,
  "reconcile-sessions": 24_000,
  "prune-system-job-executions": 24_000,
  "prune-system-events": 20_000,
  "databreach-deadline-alerts": 20_000,
  "reconcile-occurrence-availability": 24_000,
  "auth-tokens": 20_000,
  "reconcile-document-storage": 24_000,
  "prune-audit-logs": 20_000,
  "sweep-verification": 24_000,
  "purge-unverified-users": 20_000,
  "archive-webhook-events": 20_000,
  "consent-retention-sweeper": 20_000,
  "expire-onboarding-drafts": 20_000,
};

/**
 * The request one target gets; exported so a test can pin it without a Netlify
 * runtime. A windowed target also carries its window start, from `now`.
 */
export function targetRequest(
  baseUrl: string,
  name: Target,
  now?: Date,
): { url: string; timeoutMs: number } {
  const limit = name in TARGET_LIMITS ? TARGET_LIMITS[name] : DEFAULT_LIMIT;
  const windowStart = now ? windowStartFor(name, now) : null;
  const backgroundFunction = TARGET_BACKGROUND_FUNCTIONS[name];
  const query = [
    backgroundFunction === "stream-maintenance-background"
      ? `job=${name}`
      : null,
    limit === null || limit === undefined ? null : `limit=${limit}`,
    windowStart ? `windowStart=${windowStart.toISOString()}` : null,
  ]
    .filter((q): q is string => q !== null)
    .join("&");
  const querySuffix = query ? "?" + query : "";
  return {
    url: backgroundFunction
      ? `${baseUrl}/.netlify/functions/${backgroundFunction}${querySuffix}`
      : `${baseUrl}/api/cleanup/${name}${querySuffix}`,
    timeoutMs: TARGET_TIMEOUTS_MS[name] ?? PER_TARGET_TIMEOUT_MS,
  };
}

const EVERY_BY_NAME: Partial<Record<string, number>> = TARGET_EVERY_MINUTES;
const OFFSET_BY_NAME: Partial<Record<string, number>> = TARGET_OFFSET_MINUTES;

/** A failing target reports at most once an hour: on its own first due tick of that hour. */
export function isFirstDueTickOfHour(name: string, now: Date): boolean {
  const every = EVERY_BY_NAME[name];
  const first =
    every === undefined
      ? 0
      : ((((OFFSET_BY_NAME[name] ?? 0) % every) + every) % every) % 60;
  const sinceFirst = now.getUTCMinutes() - first;
  return sinceFirst >= 0 && sinceFirst < 5;
}

/** Effective scheduling and request bounds for each capability; contains no runtime secrets. */
export const JOB_SCHEDULES = TARGETS.map((name) => ({
  name,
  everyMinutes: TARGET_EVERY_MINUTES[name] ?? 5,
  offsetMinutes: TARGET_OFFSET_MINUTES[name] ?? 0,
  window: TARGET_WINDOWS[name] ?? null,
  limit: name in TARGET_LIMITS ? (TARGET_LIMITS[name] ?? null) : DEFAULT_LIMIT,
  timeoutMs: TARGET_TIMEOUTS_MS[name] ?? PER_TARGET_TIMEOUT_MS,
  backgroundFunction: TARGET_BACKGROUND_FUNCTIONS[name] ?? null,
}));

export type JobSchedule = (typeof JOB_SCHEDULES)[number];

export function scheduleFor(name: string): JobSchedule | undefined {
  return JOB_SCHEDULES.find((schedule) => schedule.name === name);
}
