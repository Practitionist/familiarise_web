import {
  cleanupRoute,
  parseLimitParam,
  parseDeleteFlag,
  parseGstPeriodParam,
  parseLimitParamOrDefault,
  parseTdsReturnParams,
  parseWindowStartParam,
  statusFor,
  type CleanupRouteHandlers,
} from "@/lib/cron/cleanup-route";
import { adminActorId } from "@/lib/cron/run-context";
import { reportConfigSkip, type ConfigSkip } from "@/lib/cron/config-skip";
import type { JobCategory } from "@/lib/cron/job-categories";
import { reportSentryError } from "@/lib/observability/report";
import type { FrozenWallet } from "@/lib/payments/wallet-freeze";
import type { Tx } from "@/lib/prisma";
import type {
  Finding,
  ReconcileReport,
} from "@/scripts/reconcile/reconcile-ledgers";

/** What the operations console shows and how its Run door executes each job. */
export interface CleanupJobMeta {
  title: string;
  description: string;
  category: JobCategory;
  /** `after`: answered 202 and run after the response, for runs that outlive the edge timeout. */
  manualRun: "inline" | "after";
}

/**
 * The ticker's idle probe: `hasWork` reuses the job's own claim predicate, and
 * a false answer skips the due tick. It answers true without querying once
 * `outOfTime()`, checked before every statement. `alwaysRun` says why the job has no probe.
 */
export type IdleProbe =
  | {
      hasWork: (
        db: Tx,
        now: Date,
        outOfTime: () => boolean,
      ) => Promise<boolean>;
    }
  | { alwaysRun: string };

export interface CleanupJobEntry {
  meta: CleanupJobMeta;
  build: () => CleanupRouteHandlers;
  idle: IdleProbe;
}

// Per-run defaults for the per-row booking sweeps the ticker drives. `?limit=`
// overrides them (clamped to LIMIT_CAP); no caller gets an unbounded cohort.
/** Sessions per reminder window; each costs a bell and an email. */
const MAX_REMINDER_SESSIONS_PER_WINDOW = 25;
/** Parents and slot outcomes per bite; one Stream report each, bites until the drain deadline. */
const MAX_AUTO_COMPLETE_PER_PASS = 25;
/** Candidates per bite; each is checked against a Stream call report. */
const MAX_NO_SHOW_CANDIDATES = 10;
/** Rows per stale-request arm; the refund arm calls the gateway per row. */
const MAX_STALE_REQUESTS_PER_ARM = 20;
/** Slot rows the stale-RESCHEDULED arm may release; a pure row-lock pass. */
const MAX_STALE_SLOT_RELEASES = 200;
/** Unpaid trials per run; the unanswered arm refunds per payment. */
const MAX_UNPAID_TRIALS = 25;
/** Lapsed proposals per run; each takes the appointment lock and a restore. */
const MAX_RESCHEDULE_PROPOSALS = 25;
/** Tentative slots per run; a cheap soft cancel behind an expensive read. */
const MAX_TENTATIVE_SLOTS = 200;
/** QUALIFYING referrals per run; one Serializable transaction each. */
const MAX_REFERRAL_VESTS = 50;
/** Expired credits per breakage run; one Serializable transaction each. */
const MAX_REFERRAL_BREAKAGE = 500;
/** Payouts minted per rail per batch slice; each is one transaction. */
const MAX_PAYOUT_BATCH_UNITS = 10;
/** Disbursements per rail per run; each is a gateway round trip. */
const MAX_PAYOUT_DISBURSEMENTS = 5;
/** Org invoice rollups per run; each is one Serializable transaction. */
const MAX_ACCRUAL_ROLLUPS = 10;
/** Per-row claims for the daily org billing and contract jobs. */
const MAX_ORG_LIFECYCLE_CLAIMS = 25;
/** IRN submissions per run; each is a GSP round trip. */
const MAX_IRP_UPLOADS = 10;
/** Stuck payouts per model per run; each costs up to two RazorpayX calls. */
const MAX_STUCK_PAYOUT_POLLS = 5;
/** Payouts per reconcile cohort per run (three cohorts); one RazorpayX GET each. */
const MAX_PAYOUT_STATUS_POLLS = 8;
/** Consumer invoices the GST register healer may mint per run; one transaction each. */
const MAX_GST_HEALER_MINTS = 25;
/** Un-invoiced consumer payments minted per run; one transaction each. */
const MAX_CONSUMER_INVOICE_HEALS = 25;
/** Document rows a single purge run may process; each costs one storage delete. */
const MAX_DOCUMENT_PURGE_ROWS = 200;
/** Pending standalone purchases per rail per run; up to two Razorpay calls each. */
const MAX_STANDALONE_PURCHASE_CHECKS = 5;
/** Digital product rows per storage arm per run; one R2 delete each. */
const MAX_DIGITAL_PRODUCT_STORAGE_ROWS = 25;

/**
 * Registry of `/api/cleanup/[job]` HTTP twins and the console's job list.
 *
 * Each entry is annotated with `@cleanup-twin <slug>` and lazily imports its
 * job module inside `run` so:
 * 1. Invoking one cleanup route does not load the other job modules.
 * 2. `__tests__/maintenance/cron-lock-registry.test.ts` can statically inspect
 *    each slug's `job:` literal and imported core module.
 */
export const CLEANUP_JOB_BUILDERS: Record<string, CleanupJobEntry> = {
  // @cleanup-twin consent-retention-sweeper
  "consent-retention-sweeper": {
    meta: {
      title: "Consent retention slice",
      description:
        "Examine one expired-retention slice; deletion requires the existing delete gate",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a week; a probe would save at most 4 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "consent-retention-sweeper",
        run: async (req, { startedAt }) => {
          const { runConsentRetentionSweeper } =
            await import("@/lib/compliance/consent-retention");
          return runConsentRetentionSweeper({
            limit: parseLimitParamOrDefault(req, 100),
            startedAt,
            delete: parseDeleteFlag(req),
          });
        },
        items: (r) => ({ processed: r.expiredSampled }),
        failureMessage: "Consent retention slice failed",
      }),
  },
  // @cleanup-twin databreach-deadline-alerts
  "databreach-deadline-alerts": {
    meta: {
      title: "Breach deadline alerts",
      description:
        "Stage the next bounded recipient slice of the oldest unfinished deadline digest",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasDataBreachDeadlineWork } =
          await import("@/lib/compliance/databreach-deadline-alerts");
        return hasDataBreachDeadlineWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "databreach-deadline-alerts",
        run: async (req, { startedAt }) => {
          const { runDataBreachDeadlineAlerts } =
            await import("@/lib/compliance/databreach-deadline-alerts");
          return runDataBreachDeadlineAlerts({
            limit: parseLimitParamOrDefault(req, 5),
            startedAt,
          });
        },
        items: (r) => ({ processed: r.atRisk }),
        failureMessage: "Data breach deadline alert staging failed",
      }),
  },
  // @cleanup-twin prune-system-events
  "prune-system-events": {
    meta: {
      title: "Prune system events",
      description:
        "Remove one oldest-first slice of system events past 400 days, keeping each state-bearing key's newest event",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due four times a day in its retention window; a probe would save at most 120 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "prune-system-events",
        run: async (req, { startedAt }) => {
          const { pruneSystemEvents } =
            await import("@/lib/observability/system-event-retention");
          return pruneSystemEvents({
            limit: parseLimitParamOrDefault(req, 100),
            startedAt,
          });
        },
        failureMessage: "System event retention slice failed",
      }),
  },

  // @cleanup-twin abandoned-org-top-ups
  "abandoned-org-top-ups": {
    meta: {
      title: "Abandoned org top-ups",
      description:
        "Reap unpaid organisation wallet top-up orders and confirm late captures",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAbandonedOrgTopUpWork } =
          await import("@/scripts/cleanup/cleanup-abandoned-org-top-ups");
        return hasAbandonedOrgTopUpWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "cleanup-abandoned-org-top-ups",
        run: async (req) => {
          const { cleanupAbandonedOrgTopUps } =
            await import("@/scripts/cleanup/cleanup-abandoned-org-top-ups");
          // One gateway read per row, so an unparameterised call stays bounded too.
          return cleanupAbandonedOrgTopUps({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
          });
        },
        summarize: (r) => ({
          reaped: r.reaped,
          confirmed: r.confirmed,
          kept: r.kept,
          errors: r.errors.length,
          graceHours: r.graceHours,
          success: r.success,
        }),
        unauthorizedMessage:
          "Please provide a valid authorization header with the CRON_SECRET",
        items: (r) => ({ processed: r.reaped + r.confirmed + r.kept }),
        failureMessage: "Cleanup failed",
      }),
  },

  // @cleanup-twin abandoned-payments
  "abandoned-payments": {
    meta: {
      title: "Abandoned payments",
      description:
        "Expire abandoned checkouts and lapsed approval pay-links, and remind payers who owe one",
      category: "Payments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAbandonedPaymentWork } =
          await import("@/scripts/payments/cleanup-abandoned-payments");
        return hasAbandonedPaymentWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "cleanup-abandoned-payments",
        run: async (req) => {
          const {
            cleanupAbandonedPayments,
            cleanupExpiredApprovalPendingPayments,
            disconnectDatabase,
            remindApprovalPaymentsDue,
          } = await import("@/scripts/payments/cleanup-abandoned-payments");
          const limit = parseLimitParam(req);
          const perPass: Array<number | undefined> =
            limit === undefined
              ? [undefined, undefined, undefined]
              : (() => {
                  const first = Math.ceil(limit / 3);
                  const second = Math.ceil((limit - first) / 2);
                  return [first, second, limit - first - second];
                })();
          try {
            const paymentResult = await cleanupAbandonedPayments({
              limit: perPass[0],
            });
            const consultationResult =
              await cleanupExpiredApprovalPendingPayments({
                limit: perPass[1],
              });
            const reminderResult = await remindApprovalPaymentsDue({
              limit: perPass[2],
            });
            const overallSuccess =
              paymentResult.success &&
              consultationResult.success &&
              reminderResult.success;
            return {
              paymentCleanup: paymentResult,
              consultationCleanup: consultationResult,
              paymentReminders: reminderResult,
              overallSuccess,
            };
          } finally {
            try {
              await disconnectDatabase();
            } catch (disconnectError) {
              reportSentryError(disconnectError, {
                subsystem: "cron",
                tags: { job: "cleanup-abandoned-payments", task: "disconnect" },
              });
              console.error(
                "Disconnect after abandoned-payments failed:",
                disconnectError,
              );
            }
          }
        },
        summarize: (r) => ({
          paymentSuccess: r.paymentCleanup.success,
          consultationSuccess: r.consultationCleanup.success,
          reminderSuccess: r.paymentReminders.success,
          errorCount:
            r.paymentCleanup.errors.length +
            r.consultationCleanup.errors.length +
            r.paymentReminders.errors.length,
        }),
        status: (r) =>
          statusFor(
            { success: r.overallSuccess },
            r.paymentCleanup.errors.length +
              r.consultationCleanup.errors.length +
              r.paymentReminders.errors.length >
              0,
          ),
        unauthorizedMessage:
          "Please provide a valid authorization header with the CRON_SECRET",
        items: (r) => ({
          processed:
            r.paymentCleanup.totalProcessed +
            r.consultationCleanup.totalProcessed +
            r.paymentReminders.totalProcessed,
        }),
        failureMessage: "Cleanup job failed",
      }),
  },

  // @cleanup-twin alert-orphaned-payments
  "alert-orphaned-payments": {
    meta: {
      title: "Orphaned payment alert",
      description:
        "Find succeeded payments with no booking and raise a critical alert",
      category: "Alerts",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasOrphanedPaymentAlertWork } =
          await import("@/scripts/alerts/alert-orphaned-payments");
        return hasOrphanedPaymentAlertWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "alert-orphaned-payments",
        run: async (req) => {
          const { alertOrphanedPayments } =
            await import("@/scripts/alerts/alert-orphaned-payments");
          return alertOrphanedPayments({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          totalOrphaned: r.totalOrphaned,
          criticalCount: r.criticalCount,
          totalAmount: r.totalAmount,
          sideChargeCount: r.sideChargeCount,
        }),
        status: (r) => (r.totalOrphaned > 0 ? 500 : 200),
        items: (r) => ({ processed: r.totalOrphaned }),
        failureMessage: "Failed to check for orphaned payments",
      }),
  },

  // @cleanup-twin advance-program-cycles
  "advance-program-cycles": {
    meta: {
      title: "Advance program cycles",
      description:
        "Roll organisation program assignments into their next cycle",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAdvanceProgramCyclesWork } =
          await import("@/jobs/billing/advance-program-cycles");
        return hasAdvanceProgramCyclesWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "advance-program-cycles",
        run: async (req) => {
          const { runAdvanceProgramCycles } =
            await import("@/jobs/billing/advance-program-cycles");
          return runAdvanceProgramCycles({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
            windowStart: parseWindowStartParam(req),
          });
        },
        status: (r) => statusFor({}, r.failed > 0),
        failureMessage: "Failed to advance program cycles",
      }),
  },

  // @cleanup-twin appointment-reminders
  "appointment-reminders": {
    meta: {
      title: "Appointment reminders",
      description: "Send the 24-hour, 1-hour and 15-minute session reminders",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAppointmentReminderWork } =
          await import("@/scripts/appointments/send-appointment-reminders");
        return hasAppointmentReminderWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "appointment-reminders",
        run: async (req) => {
          const { sendAppointmentReminders } =
            await import("@/scripts/appointments/send-appointment-reminders");
          return sendAppointmentReminders({
            maxPerWindow: parseLimitParamOrDefault(
              req,
              MAX_REMINDER_SESSIONS_PER_WINDOW,
            ),
          });
        },
        summarize: (r) => ({
          reminders24h: r.reminders24h,
          reminders1h: r.reminders1h,
          reminders15m: r.reminders15m,
        }),
        items: (r) => ({
          processed: r.reminders24h + r.reminders1h + r.reminders15m,
        }),
        failureMessage: "Failed to send appointment reminders",
      }),
  },

  // @cleanup-twin archive-webhook-events
  "archive-webhook-events": {
    meta: {
      title: "Archive webhook events",
      description:
        "Delete webhook events past one calendar year and terminal outbound deliveries past 30 days",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a week; a probe would save at most 4 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "archive-webhook-events",
        run: async (_req, { startedAt }) => {
          const { archiveWebhookEvents } =
            await import("@/scripts/cleanup/archive-webhook-events");
          return archiveWebhookEvents({ startedAt });
        },
        items: (r) => ({ processed: r.totalDeleted }),
        summarize: (r) => ({
          hasMore: r.hasMore,
          webhookEventsDeleted: r.webhookEventsDeleted,
          outboundDeliveriesDeleted: r.outboundDeliveriesDeleted,
          totalDeleted: r.totalDeleted,
        }),
        failureMessage: "Failed to archive webhook events",
      }),
  },

  // @cleanup-twin auth-tokens
  "auth-tokens": {
    meta: {
      title: "Auth token cleanup",
      description:
        "Delete expired verification tokens and sessions (logged to the access log first), access-log rows 180 days after their session ended, and stale invitations",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a day; a probe would save at most 30 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "cleanup-auth-tokens",
        run: async (req, { startedAt }) => {
          const { cleanupAuthTokens } =
            await import("@/lib/auth/cleanup-auth-tokens");
          return cleanupAuthTokens({ limit: parseLimitParam(req), startedAt });
        },
        summarize: (r) => ({
          hasMore: r.hasMore,
          verificationTokensDeleted: r.verificationTokensDeleted,
          sessionsDeleted: r.sessionsDeleted,
          accessLogsDeleted: r.accessLogsDeleted,
          idempotencyRecordsDeleted: r.idempotencyRecordsDeleted,
          staleInvitationsExpired: r.staleInvitationsExpired,
          totalCleaned: r.totalCleaned,
        }),
        failureMessage: "Failed to cleanup auth tokens",
      }),
  },

  // @cleanup-twin auto-renew-contracts
  "auto-renew-contracts": {
    meta: {
      title: "Auto-renew contracts",
      description: "Renew organisation contracts due for automatic renewal",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAutoRenewContractsWork } =
          await import("@/jobs/contracts/auto-renew-contracts");
        return hasAutoRenewContractsWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "auto-renew-contracts",
        run: async (req) => {
          const { runAutoRenewContracts } =
            await import("@/jobs/contracts/auto-renew-contracts");
          return runAutoRenewContracts({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
            windowStart: parseWindowStartParam(req),
          });
        },
        status: (r) => statusFor({}, r.failed > 0),
        failureMessage: "Failed to auto-renew contracts",
      }),
  },

  // A financial job (it stamps class-end refunds owed): fail-closed, and held in degraded maintenance.
  // @cleanup-twin auto-complete-appointments
  "auto-complete-appointments": {
    meta: {
      title: "Auto-complete appointments",
      description: "Move finished sessions to completed after they end",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAutoCompleteWork } =
          await import("@/scripts/appointments/auto-complete-appointments");
        return hasAutoCompleteWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "auto-complete-appointments",
        run: async (req, { startedAt }) => {
          const { autoCompleteAppointments } =
            await import("@/scripts/appointments/auto-complete-appointments");
          const limit = parseLimitParamOrDefault(
            req,
            MAX_AUTO_COMPLETE_PER_PASS,
          );
          return autoCompleteAppointments({
            maxParents: limit,
            maxSlotOutcomes: limit,
            startedAt,
          });
        },
        summarize: (r) => ({
          webinarsCompleted: r.webinarsCompleted,
          classesCompleted: r.classesCompleted,
          consultationsCompleted: r.consultationsCompleted,
          subscriptionsCompleted: r.subscriptionsCompleted,
          trialsCompleted: r.trialsCompleted,
          sessionsCompleted: r.sessionsCompleted,
          sessionsVoided: r.sessionsVoided,
          sessionsUnverified: r.sessionsUnverified,
          classEndSeatsOwed: r.classEndSeatsOwed,
          classEndOwedPaise: r.classEndOwedPaise,
          classEndCreditSeatsEscalated: r.classEndCreditSeatsEscalated,
        }),
        items: (r) => ({
          processed:
            r.webinarsCompleted +
            r.classesCompleted +
            r.consultationsCompleted +
            r.subscriptionsCompleted +
            r.trialsCompleted +
            r.sessionsCompleted +
            r.sessionsVoided +
            r.sessionsUnverified +
            r.classEndSeatsOwed,
        }),
        failureMessage: "Failed to auto-complete appointments",
      }),
  },

  // @cleanup-twin drain-admin-run-requests
  "drain-admin-run-requests": {
    meta: {
      title: "Drain admin run requests",
      description:
        "Retry admin Run-now requests whose dispatch was lost or whose run crashed",
      category: "Reconciliation",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAdminRunRequestWork } =
          await import("@/lib/cron/admin-run-requests");
        return hasAdminRunRequestWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "drain-admin-run-requests",
        run: async (req, { startedAt }) => {
          const { drainAdminRunRequests } =
            await import("@/lib/cron/admin-run-requests");
          return drainAdminRunRequests({
            limit: parseLimitParam(req),
            startedAt,
          });
        },
        items: (r) => ({ processed: r.picked }),
        failureMessage: "Admin run request drain failed",
      }),
  },

  // @cleanup-twin create-payout-batch
  "create-payout-batch": {
    meta: {
      title: "Create payout batch",
      description: "Mint the weekly consultant and organisation payout batch",
      category: "Payouts",
      manualRun: "after",
    },
    idle: {
      alwaysRun:
        "Due only in the Monday window; a probe would save at most 48 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "create-payout-batch",
        run: async (req) => {
          const { runCreatePayoutBatches } =
            await import("@/lib/payments/payouts/scheduled-runs");
          // An admin-started batch names its maker, so maker-checker keeps that admin off its approval.
          return runCreatePayoutBatches({
            limit: parseLimitParamOrDefault(req, MAX_PAYOUT_BATCH_UNITS),
            windowStart: parseWindowStartParam(req),
            createdBy: adminActorId(),
          });
        },
        summarize: (r) => ({
          batchId: r.batchId,
          consultantPayoutsMinted: r.consultantPayoutsMinted,
          orgPayoutsCreated: r.org.payoutsCreated,
          failed: r.failed,
          remaining: r.remaining,
        }),
        status: (r) => statusFor(r, r.failed > 0),
        items: (r) => ({
          processed: r.consultantPayoutsMinted + r.org.payoutsCreated,
        }),
        failureMessage: "Failed to create payout batch",
      }),
  },

  // @cleanup-twin detect-consultant-no-shows
  "detect-consultant-no-shows": {
    meta: {
      title: "Detect consultant no-shows",
      description: "Cancel and refund sessions the consultant never joined",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasConsultantNoShowWork } =
          await import("@/scripts/appointments/detect-consultant-no-shows");
        return hasConsultantNoShowWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "detect-consultant-no-shows",
        run: async (req, { startedAt }) => {
          const { detectConsultantNoShows } =
            await import("@/scripts/appointments/detect-consultant-no-shows");
          return detectConsultantNoShows({
            maxCandidates: parseLimitParamOrDefault(
              req,
              MAX_NO_SHOW_CANDIDATES,
            ),
            startedAt,
          });
        },
        summarize: (r) => ({
          detected: r.detected,
          refunded: r.refunded,
          contradicted: r.contradicted,
        }),
        items: (r) => ({ processed: r.detected }),
        failureMessage: "Failed to detect consultant no-shows",
      }),
  },

  // @cleanup-twin dispatch-outbound-webhooks
  "dispatch-outbound-webhooks": {
    meta: {
      title: "Dispatch outbound webhooks",
      description: "Deliver queued organisation webhooks",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasOutboundWebhookWork } =
          await import("@/scripts/cleanup/dispatch-outbound-webhooks");
        return hasOutboundWebhookWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "dispatch-outbound-webhooks",
        run: async (req) => {
          const { dispatchOutboundWebhooks } =
            await import("@/scripts/cleanup/dispatch-outbound-webhooks");
          return dispatchOutboundWebhooks({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          succeeded: r.succeeded,
          retried: r.retried,
          failed: r.failed,
        }),
        unauthorizedMessage: "Provide a valid Bearer CRON_SECRET",
        failureMessage: "Dispatch tick failed",
      }),
  },

  // @cleanup-twin drain-notification-outbox
  "drain-notification-outbox": {
    meta: {
      title: "Drain notification outbox",
      description: "Relay queued notifications to Novu",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasNotificationOutboxWork } =
          await import("@/jobs/notifications/drain-notification-outbox");
        return hasNotificationOutboxWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "drain-notification-outbox",
        run: async (req) => {
          const { drainNotificationOutbox } =
            await import("@/jobs/notifications/drain-notification-outbox");
          return drainNotificationOutbox({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          sent: r.sent,
          retried: r.retried,
          deadLettered: r.deadLettered,
          errors: r.errors.length,
        }),
        status: (r) => (r.errors.length > 0 ? 500 : 200),
        unauthorizedMessage: "Provide a valid Bearer CRON_SECRET",
        failureMessage: "Notification outbox drain failed",
      }),
  },

  // @cleanup-twin novu-step-failure-probe
  "novu-step-failure-probe": {
    meta: {
      title: "Novu step failure probe",
      description:
        "Read Novu's activity feed for in-app steps that failed after acceptance and dead-letter them for review",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Reads a time window of Novu's activity feed; no local queue.",
    },
    build: () =>
      cleanupRoute({
        job: "novu-step-failure-probe",
        run: async () => {
          const { probeNovuStepFailures } =
            await import("@/jobs/notifications/novu-step-failure-probe");
          return probeNovuStepFailures();
        },
        summarize: (r) => ({
          scanned: r.scanned,
          pages: r.pages,
          failedSteps: r.failedSteps,
          inserted: r.inserted,
          unmatched: r.unmatched,
          truncated: r.truncated,
          skipped: r.skipped,
        }),
        items: (r) => ({ processed: r.scanned }),
        needsAttention: (r) => r.truncated,
        failureMessage: "Novu step failure probe failed",
      }),
  },

  // @cleanup-twin dunning
  dunning: {
    meta: {
      title: "Dunning",
      description: "Chase overdue organisation invoices",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due three times a day in its window; a probe would save at most 90 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "dunning",
        run: async (req) => {
          const { runDunning } = await import("@/jobs/billing/dunning");
          return runDunning({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
            windowStart: parseWindowStartParam(req),
          });
        },
        status: (r) => statusFor({}, r.failed > 0),
        items: (r) => ({ processed: r.scannedStage1 + r.scannedStage2 }),
        failureMessage: "Failed to run dunning",
      }),
  },

  // @cleanup-twin expire-contracts
  "expire-contracts": {
    meta: {
      title: "Expire contracts",
      description: "End organisation contracts past their term",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasExpireContractsWork } =
          await import("@/jobs/contracts/expire-contracts");
        return hasExpireContractsWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "expire-contracts",
        run: async (req) => {
          const { runExpireContracts } =
            await import("@/jobs/contracts/expire-contracts");
          return runExpireContracts({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
            windowStart: parseWindowStartParam(req),
          });
        },
        failureMessage: "Failed to expire contracts",
      }),
  },

  // @cleanup-twin expire-event-channels
  "expire-event-channels": {
    meta: {
      title: "Expire event channels",
      description: "Queue ended event and dormant conversation cleanup",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due three times a day in its window; a probe would save at most 90 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "expire-event-channels",
        run: async () => {
          const { dispatchBackgroundJob } =
            await import("@/lib/cron/dispatch-background");
          return dispatchBackgroundJob("expire-event-channels");
        },
        status: () => 202,
        failureMessage: "Stream lifecycle dispatch failed",
      }),
  },

  // @cleanup-twin expire-recordings
  "expire-recordings": {
    meta: {
      title: "Expire recordings",
      description: "Queue recording retention and asset cleanup",
      category: "Recordings",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due three times a day in its window; a probe would save at most 90 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "expire-recordings",
        run: async () => {
          const { dispatchBackgroundJob } =
            await import("@/lib/cron/dispatch-background");
          return dispatchBackgroundJob("expire-recordings");
        },
        status: () => 202,
        failureMessage: "Stream lifecycle dispatch failed",
      }),
  },

  // @cleanup-twin expire-onboarding-drafts
  "expire-onboarding-drafts": {
    meta: {
      title: "Expire onboarding drafts",
      description: "Delete abandoned onboarding drafts",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a week; a probe would save at most 4 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "expire-onboarding-drafts",
        run: async (req, { startedAt }) => {
          const { expireOnboardingDrafts } =
            await import("@/scripts/cleanup/expire-onboarding-drafts");
          return expireOnboardingDrafts({
            limit: parseLimitParam(req),
            startedAt,
          });
        },
        summarize: (r) => ({ deleted: r.deleted, hasMore: r.hasMore }),
        items: (r) => ({ processed: r.deleted }),
        failureMessage: "Failed to expire onboarding drafts",
      }),
  },

  // @cleanup-twin expire-referral-credits
  "expire-referral-credits": {
    meta: {
      title: "Expire referral credits",
      description: "Post breakage for expired referral credits",
      category: "Earnings",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due only on the 1st of the month; a probe would save at most 3 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "expire-referral-credits",
        run: async (req) => {
          const { runExpireReferralCredits } =
            await import("@/lib/referrals/vesting");
          return runExpireReferralCredits({
            limit: parseLimitParamOrDefault(req, MAX_REFERRAL_BREAKAGE),
          });
        },
        summarize: (r) => ({
          expired: r.expired,
          breakagePaise: r.breakagePaise,
          failed: r.failed,
        }),
        items: (r) => ({ processed: r.expired }),
        failureMessage: "Failed to expire referral credits",
      }),
  },

  // @cleanup-twin expire-stale-requests
  "expire-stale-requests": {
    meta: {
      title: "Expire stale requests",
      description:
        "Expire unanswered requests and refund approved requests that were never scheduled",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasStaleRequestWork } =
          await import("@/scripts/appointments/expire-stale-requests");
        return hasStaleRequestWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "expire-stale-requests",
        run: async (req, { startedAt }) => {
          const { expireStaleRequests } =
            await import("@/scripts/appointments/expire-stale-requests");
          return expireStaleRequests({
            limits: {
              maxRequests: parseLimitParamOrDefault(
                req,
                MAX_STALE_REQUESTS_PER_ARM,
              ),
              maxSlotReleases: MAX_STALE_SLOT_RELEASES,
            },
            startedAt,
          });
        },
        summarize: (r) => ({
          consultationsExpired: r.consultationsExpired,
          parkedConsultationsCancelled: r.parkedConsultationsCancelled,
          subscriptionsExpired: r.subscriptionsExpired,
          subscriptionNudgesSent: r.subscriptionNudgesSent,
          paymentPendingExpired: r.paymentPendingExpired,
          unallocatedHasMore: r.unallocatedHasMore,
          unallocatedRefundsDeferred: r.unallocatedRefundsDeferred,
        }),
        items: (r) => ({
          processed:
            r.consultationsExpired +
            r.parkedConsultationsCancelled +
            r.subscriptionsExpired +
            r.paymentPendingExpired,
        }),
        failureMessage: "Failed to expire stale requests",
      }),
  },

  // @cleanup-twin expire-unpaid-trials
  "expire-unpaid-trials": {
    meta: {
      title: "Expire unpaid trials",
      description:
        "Expire unpaid trials and refund paid trials nobody answered",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasUnpaidTrialWork } =
          await import("@/scripts/trials/expire-unpaid-trials");
        return hasUnpaidTrialWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "expire-unpaid-trials",
        run: async (req) => {
          const { expireUnpaidTrials } =
            await import("@/scripts/trials/expire-unpaid-trials");
          return expireUnpaidTrials({
            maxTrials: parseLimitParamOrDefault(req, MAX_UNPAID_TRIALS),
          });
        },
        summarize: (r) => ({ trialsExpired: r.trialsExpired }),
        items: (r) => ({ processed: r.trialsExpired }),
        failureMessage: "Failed to expire unpaid trial sessions",
      }),
  },

  // @cleanup-twin expire-stale-collaborator-invites
  "expire-stale-collaborator-invites": {
    meta: {
      title: "Expire collaborator invites",
      description: "Expire collaborator invitations nobody accepted",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a day; a probe would save at most 30 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "expire-stale-collaborator-invites",
        run: async (req) => {
          const { expireStaleCollaboratorInvites } =
            await import("@/lib/collaborators/cleanup");
          return expireStaleCollaboratorInvites(
            parseLimitParamOrDefault(req, 50),
          );
        },
        summarize: (r) => ({ expired: r.expired, scanned: r.scanned }),
        failureMessage: "Failed to expire stale collaborator invites",
      }),
  },

  // @cleanup-twin gst-outward-register-export
  "gst-outward-register-export": {
    meta: {
      title: "GST outward register",
      description:
        "Heal missing tax invoices and export the monthly GST outward register",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "A monthly statutory export in its calendar window; the period is the work.",
    },
    build: () =>
      cleanupRoute({
        job: "gst-outward-register-export",
        run: async (req) => {
          const { runGstOutwardRegisterExport } =
            await import("@/jobs/compliance/gst-outward-register-export");
          return runGstOutwardRegisterExport({
            limit: parseLimitParamOrDefault(req, MAX_GST_HEALER_MINTS),
            period: parseGstPeriodParam(req),
          });
        },
        summarize: (r) => ({
          period: r.period,
          storagePath: r.storagePath,
          mintedByHealer: r.mintedByHealer,
          documentCount: r.documentCount,
          warnings: r.warnings,
        }),
        status: () => 200,
        items: (r) => ({ processed: r.documentCount }),
        failureMessage: "Failed to export the GST outward-supplies register",
      }),
  },

  // @cleanup-twin generate-subscription-invoices
  "generate-subscription-invoices": {
    meta: {
      title: "Subscription invoices",
      description: "Generate due organisation subscription invoices",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Surfaces a bad supplier GSTIN on every slot of its daily window.",
    },
    build: () =>
      cleanupRoute({
        job: "generate-subscription-invoices",
        run: async (req) => {
          const { runGenerateSubscriptionInvoices } =
            await import("@/jobs/billing/generate-subscription-invoices");
          return runGenerateSubscriptionInvoices({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
            windowStart: parseWindowStartParam(req),
          });
        },
        status: (r) => statusFor({}, r.failed > 0),
        items: (r) => ({ processed: r.generated + r.skipped }),
        failureMessage: "Failed to generate subscription invoices",
      }),
  },

  // @cleanup-twin handle-stuck-payouts
  "handle-stuck-payouts": {
    meta: {
      title: "Handle stuck payouts",
      description:
        "Query the gateway for payouts stuck in processing and settle or retry them",
      category: "Payouts",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasStuckPayoutWork } =
          await import("@/scripts/payouts/handle-stuck-payouts");
        return hasStuckPayoutWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "handle-stuck-payouts",
        run: async (req, { startedAt }) => {
          const { handleStuckPayouts } =
            await import("@/scripts/payouts/handle-stuck-payouts");
          return handleStuckPayouts({
            limit: parseLimitParamOrDefault(req, MAX_STUCK_PAYOUT_POLLS),
            startedAt,
          });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          retriedCount: r.retriedCount,
          failedCount: r.failedCount,
        }),
        failureMessage: "Failed to handle stuck payouts",
      }),
  },

  // @cleanup-twin heal-consumer-invoices
  "heal-consumer-invoices": {
    meta: {
      title: "Heal consumer invoices",
      description:
        "Mint missing consumer tax invoices for captured, unrefunded payments",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due four times a day; a probe would save at most 120 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "heal-consumer-invoices",
        run: async (req, { startedAt }) => {
          const { healConsumerInvoices } =
            await import("@/lib/payments/billing/consumer-invoice-healer");
          return healConsumerInvoices({
            limit: parseLimitParamOrDefault(req, MAX_CONSUMER_INVOICE_HEALS),
            startedAt,
          });
        },
        status: (r) => statusFor({}, r.failed > 0),
        failureMessage: "Failed to heal consumer tax invoices",
      }),
  },

  // @cleanup-twin irp-uploader
  "irp-uploader": {
    meta: {
      title: "IRP uploader",
      description: "Register pending e-invoices with the government portal",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "An unconfigured GSP records a config skip on every run; an idle skip would hide it.",
    },
    build: () =>
      cleanupRoute({
        job: "irp-uploader",
        run: async (req) => {
          const { runIrpUploader } =
            await import("@/jobs/compliance/irp-uploader");
          return runIrpUploader({
            limit: parseLimitParamOrDefault(req, MAX_IRP_UPLOADS),
            windowStart: parseWindowStartParam(req),
          });
        },
        status: (r) => statusFor({}, r.failed > 0),
        failureMessage: "Failed to upload invoices to the IRP",
      }),
  },

  // @cleanup-twin msme-payment-alerts
  "msme-payment-alerts": {
    meta: {
      title: "MSME payment alerts",
      description:
        "Send the daily digest of MSME vendor payments nearing the statutory deadline",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a day; a probe would save at most 30 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "msme-payment-alerts",
        run: async () => {
          const { runMsmePaymentAlerts } =
            await import("@/jobs/compliance/msme-payment-alerts");
          return runMsmePaymentAlerts();
        },
        items: (r) => ({ processed: r.atRisk }),
        failureMessage: "Failed to send MSME payment alerts",
      }),
  },

  // @cleanup-twin ops-digest
  "ops-digest": {
    meta: {
      title: "Daily ops digest",
      description:
        "Email the daily operations digest to the observability inbox, then ping its Better Stack heartbeat",
      category: "Alerts",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Sent every day: its arrival is the signal.",
    },
    build: () =>
      cleanupRoute({
        job: "ops-digest",
        run: async () => {
          const { withCronLock } = await import("@/lib/cron/with-cron-lock");
          const { runOpsDigest } =
            await import("@/lib/observability/ops-digest");
          // Fail-open: read-only, and a repeat costs one extra email.
          return withCronLock("ops-digest", { failMode: "open" }, () =>
            runOpsDigest(),
          );
        },
        status: (r) => (r.success ? 200 : 500),
        items: () => ({ processed: 1 }),
        failureMessage: "Failed to build the daily ops digest",
      }),
  },

  // @cleanup-twin process-data-exports
  "process-data-exports": {
    meta: {
      title: "Process data exports",
      description: "Build queued data export files",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasDataExportWork } =
          await import("@/scripts/cleanup/process-data-exports");
        return hasDataExportWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "process-data-exports",
        run: async () => {
          const { processDataExports } =
            await import("@/scripts/cleanup/process-data-exports");
          return processDataExports();
        },
        summarize: (r) => ({
          picked: r.picked,
          succeeded: r.succeeded,
          failed: r.failed,
        }),
        items: (r) => ({ processed: r.picked }),
        failureMessage: "Data export tick failed",
      }),
  },

  // @cleanup-twin process-payouts
  "process-payouts": {
    meta: {
      title: "Process payouts",
      description:
        "Disburse approved consultant and organisation payouts through RazorpayX",
      category: "Payouts",
      manualRun: "after",
    },
    idle: {
      alwaysRun:
        "Surfaces a broken payout lock (Redis) or payout config within the hour.",
    },
    build: () =>
      cleanupRoute({
        job: "process-payouts",
        run: async (req) => {
          const { runProcessPayouts } =
            await import("@/lib/payments/payouts/scheduled-runs");
          // An admin-started run skips payouts that same admin approved.
          return runProcessPayouts({
            limit: parseLimitParamOrDefault(req, MAX_PAYOUT_DISBURSEMENTS),
            triggeredByUserId: adminActorId(),
          });
        },
        summarize: (r) => ({
          succeeded: r.succeeded,
          failed: r.failed,
          processed: r.processed,
          orgAdvanced: r.orgAdvanced,
          orgErrors: r.orgErrors,
          notice: r.notice,
        }),
        status: (r) => statusFor(r, r.failed > 0 || r.orgErrors > 0),
        failureMessage: "Failed to process payouts",
      }),
  },

  // @cleanup-twin prune-audit-logs
  "prune-audit-logs": {
    meta: {
      title: "Prune audit logs",
      description:
        "Remove organisation and console audit rows (8 years money, 2 years other), booking history 3 years after a terminal booking and ledger reports past 2 years; null referral request signals 180 days after a terminal referral and payer hashes 2 years after capture",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a day; a probe would save at most 30 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "prune-audit-logs",
        run: async (req, { startedAt }) => {
          const { pruneAuditLogs } =
            await import("@/scripts/cleanup/prune-audit-logs");
          return pruneAuditLogs({ limit: parseLimitParam(req), startedAt });
        },
        items: (r) => ({
          processed:
            r.deleted8y +
            r.deleted2y +
            r.opsActionsDeleted8y +
            r.opsActionsDeleted2y +
            r.opsProposalsDeleted +
            r.bookingHistoryDeleted +
            r.ledgerReportsDeleted +
            r.referralSignalsNulled +
            r.payerSignalsNulled,
          errors: r.errors.length,
        }),
        failureMessage: "Audit prune failed",
      }),
  },

  // @cleanup-twin prune-system-job-executions
  "prune-system-job-executions": {
    meta: {
      title: "Prune job history",
      description:
        "Remove no-op job runs past 14 days and other runs past 180, close stranded runs, and prune admin run requests, messaging, export, cookie, meeting presence and settled Stream revocation rows",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due seven times a day in its retention window; a probe would save at most 210 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "prune-system-job-executions",
        run: async (req, { startedAt }) => {
          const { pruneSystemJobExecutions } =
            await import("@/scripts/cleanup/prune-system-job-executions");
          return pruneSystemJobExecutions({
            limit: parseLimitParam(req),
            startedAt,
          });
        },
        summarize: (r) => ({
          pruned: r.pruned,
          noOpRunsPruned: r.noOpRunsPruned,
          stranded: r.stranded,
          adminRunRequestsPruned: r.adminRunRequestsPruned,
          failedEmailsBodyScrubbed: r.failedEmailsBodyScrubbed,
          failedEmailBatchesScrubbed: r.failedEmailBatchesScrubbed,
          failedEmailsPruned: r.failedEmailsPruned,
          failedEmailBatchesPruned: r.failedEmailBatchesPruned,
          notificationOutboxPruned: r.notificationOutboxPruned,
          emailEventsPruned: r.emailEventsPruned,
          dataExportJobsPruned: r.dataExportJobsPruned,
          cookiePreferencesPruned: r.cookiePreferencesPruned,
          unconfirmedNewsletterPruned: r.unconfirmedNewsletterPruned,
          meetingPresencePruned: r.meetingPresencePruned,
          meetingAttendancePruned: r.meetingAttendancePruned,
          streamRevocationRetriesPruned: r.streamRevocationRetriesPruned,
          hasMore: r.hasMore,
        }),
        items: (r) => ({
          processed:
            r.pruned +
            r.adminRunRequestsPruned +
            r.failedEmailsPruned +
            r.failedEmailBatchesPruned +
            r.notificationOutboxPruned +
            r.emailEventsPruned +
            r.dataExportJobsPruned +
            r.cookiePreferencesPruned +
            r.unconfirmedNewsletterPruned +
            r.meetingPresencePruned +
            r.meetingAttendancePruned +
            r.streamRevocationRetriesPruned,
        }),
        failureMessage: "System job execution prune failed",
      }),
  },

  // @cleanup-twin purge-unverified-users
  "purge-unverified-users": {
    meta: {
      title: "Purge unverified users",
      description: "Delete accounts that never verified their email",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a day; a probe would save at most 30 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "purge-unverified-users",
        run: async (req) => {
          const { purgeUnverifiedUsers, DEFAULT_PURGE_LIMIT } =
            await import("@/lib/auth/purge-unverified-users");
          return purgeUnverifiedUsers({
            limit: parseLimitParamOrDefault(req, DEFAULT_PURGE_LIMIT),
          });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          purged: r.purged,
          failed: r.failed,
        }),
        failureMessage: "Failed to purge unverified users",
      }),
  },

  // @cleanup-twin reconcile-disputes
  "reconcile-disputes": {
    meta: {
      title: "Reconcile disputes",
      description:
        "Sync dispute status with Razorpay and track urgent deadlines",
      category: "Disputes",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasDisputeReconcileWork } =
          await import("@/scripts/disputes/reconcile-disputes");
        return hasDisputeReconcileWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-disputes",
        run: async (req) => {
          const { reconcileDisputes } =
            await import("@/scripts/disputes/reconcile-disputes");
          const result = await reconcileDisputes({
            limit: parseLimitParam(req),
          });
          if (result.urgentCount > 0) {
            console.warn(
              `ALERT: ${result.urgentCount} disputes require immediate attention!`,
            );
          }
          return result;
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          urgentCount: r.urgentCount,
          razorpayManualReviewCount: r.razorpayManualReviewCount,
        }),
        failureMessage: "Failed to reconcile disputes",
      }),
  },

  // @cleanup-twin purge-deleted-documents
  "purge-deleted-documents": {
    meta: {
      title: "Purge deleted documents",
      description:
        "Tombstone session documents past retention, then purge tombstones past the grace window",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasDocumentPurgeWork } =
          await import("@/lib/documents/document-purge");
        return hasDocumentPurgeWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "purge-deleted-documents",
        run: async (req) => {
          const { purgeDeletedDocuments } =
            await import("@/lib/documents/document-purge");
          return purgeDeletedDocuments(new Date(), {
            limit: parseLimitParamOrDefault(req, MAX_DOCUMENT_PURGE_ROWS),
          });
        },
        summarize: (r) => ({
          tombstoned: r.tombstoned,
          failedTombstones: r.failedTombstones,
          purged: r.purged,
          failedStorage: r.failedStorage,
          failedRows: r.failedRows,
          remaining: r.remaining,
          byReason: r.byReason,
        }),
        status: (r) => statusFor(r),
        items: (r) => ({
          processed: r.tombstoned + r.purged,
          errors: r.failedTombstones + r.failedStorage + r.failedRows,
        }),
        failureMessage: "Document purge failed",
      }),
  },

  // @cleanup-twin reconcile-document-storage
  "reconcile-document-storage": {
    meta: {
      title: "Reconcile document storage",
      description: "Find orphaned and missing files in Supabase storage",
      category: "Reconciliation",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Compares Supabase Storage objects with document rows; vendor state.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-document-storage",
        run: async () => {
          const { reconcileDocumentStorage } =
            await import("@/scripts/cleanup/reconcile-document-storage");
          return reconcileDocumentStorage();
        },
        summarize: (r) => ({
          orphanedFilesFound: r.orphanedFilesFound,
          orphanedFilesDeleted: r.orphanedFilesDeleted,
          missingFilesFound: r.missingFilesFound,
        }),
        needsAttention: (r) => r.missingFilesFound > 0,
        items: (r) => ({
          processed: r.orphanedFilesFound + r.missingFilesFound,
        }),
        failureMessage: "Failed to reconcile document storage",
      }),
  },

  // @cleanup-twin reconcile-gateway-settlements
  "reconcile-gateway-settlements": {
    meta: {
      title: "Reconcile gateway settlements",
      description:
        "Post gateway fees and settlements from the Razorpay settlement report",
      category: "Reconciliation",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Reads Razorpay's settlement report; vendor state, no row marks the work.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-gateway-settlements",
        run: async (_req, { startedAt }) => {
          const { runReconcileGatewaySettlements } =
            await import("@/jobs/reconcile/reconcile-gateway-settlements");
          return runReconcileGatewaySettlements(startedAt);
        },
        needsAttention: (r) =>
          r.byStatus.AMOUNT_MISMATCH +
            r.byStatus.FEE_MISMATCH +
            r.byStatus.UNMATCHED >
          0,
        items: (r) => ({ processed: r.fetched }),
        failureMessage: "Failed to reconcile gateway settlements",
      }),
  },

  // @cleanup-twin reconcile-ledgers
  "reconcile-ledgers": {
    meta: {
      title: "Reconcile ledgers",
      description:
        "Compare ledger balances with cached balances and freeze drifted wallets",
      category: "Reconciliation",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Re-totals ledger aggregates against cached balances; no row marks the work.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-ledgers",
        run: async () => {
          const { runReconcileLedgers } =
            await import("@/scripts/reconcile/reconcile-ledgers");
          const { respondToLedgerDrift, reportWalletDriftFreeze } =
            await import("@/scripts/reconcile/ledger-drift-response");
          const { freezeDriftedWallets } =
            await import("@/lib/payments/wallet-freeze");
          // Freeze each page immediately; the report identity deduplicates its fatal alert.
          const frozenWallets: FrozenWallet[] = [];
          const walletFindings: Finding[] = [];
          let walletReportId: string | undefined;
          let report: ReconcileReport;
          try {
            report = await runReconcileLedgers({
              scope: "full",
              onWalletDrift: async (reportId, findings) => {
                walletReportId = reportId;
                walletFindings.push(...findings);
                await freezeDriftedWallets(
                  { id: reportId, findings },
                  frozenWallets,
                );
              },
            });
          } finally {
            if (walletReportId)
              await reportWalletDriftFreeze(
                walletReportId,
                walletFindings,
                frozenWallets,
              );
          }
          // A reused same-day verdict already raised its drift response.
          if (
            report.summary.status !== "RUNNING" &&
            !report.ok &&
            !report.reused
          )
            await respondToLedgerDrift(report);
          return {
            success: true,
            runId: report.id,
            scope: report.scope,
            status:
              report.summary.status === "RUNNING"
                ? ("RUNNING" as const)
                : ("OK" as const),
            report,
            frozenWallets,
          };
        },
        summarize: (r) => ({
          runId: r.runId,
          status: r.status,
          ok: r.report.ok,
          // Every finding the run raised, and the ones the checked-in baseline
          // does not excuse. A green night has a non-zero total and a zero
          // unbaselined count.
          discrepanciesCount: r.report.summary?.discrepanciesCount ?? 0,
          unbaselinedCount: r.report.summary?.unbaselinedCount ?? 0,
          frozenWallets: r.frozenWallets.length,
        }),
        needsAttention: (r) => r.status !== "RUNNING" && !r.report.ok,
        items: (r) => ({
          processed: r.report.summary?.discrepanciesCount ?? 0,
          errors: r.report.summary?.unbaselinedCount ?? 0,
        }),
        failureMessage: "Failed to run ledger reconciliation",
      }),
  },

  // @cleanup-twin reconcile-occurrence-availability
  "reconcile-occurrence-availability": {
    meta: {
      title: "Reconcile occurrence availability",
      description: "Clear stale tentative flags and detect double bookings",
      category: "Reconciliation",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Its double-booking and drift findings are computed in code over every future booking.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-occurrence-availability",
        run: async () => {
          const { reconcileOccurrenceAvailability } =
            await import("@/scripts/appointments/reconcile-occurrence-availability");
          return reconcileOccurrenceAvailability();
        },
        summarize: (r) => ({
          tentativeFlagsCleared: r.tentativeFlagsCleared,
          doubleBookingsDetected: r.doubleBookingsDetected,
          topUpsPlaced: r.topUps.placed,
          topUpSessionsPlaced: r.topUps.sessionsPlaced,
        }),
        needsAttention: (r) => r.doubleBookingsDetected > 0,
        items: (r) => ({
          processed:
            r.tentativeFlagsCleared +
            r.doubleBookingsDetected +
            r.topUps.placed,
        }),
        failureMessage: "Failed to reconcile slot availability",
      }),
  },

  // @cleanup-twin reconcile-orphaned-confirmations
  "reconcile-orphaned-confirmations": {
    meta: {
      title: "Reconcile orphaned confirmations",
      description: "Re-drive captured payments whose confirmation never landed",
      category: "Payments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasOrphanedConfirmationWork } =
          await import("@/scripts/payments/reconcile-orphaned-confirmations");
        return hasOrphanedConfirmationWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-orphaned-confirmations",
        run: async (req) => {
          const { reconcileOrphanedConfirmations } =
            await import("@/scripts/payments/reconcile-orphaned-confirmations");
          const limit = parseLimitParam(req);
          return reconcileOrphanedConfirmations(
            limit === undefined ? {} : { limit },
          );
        },
        summarize: (r) => ({
          scanned: r.scanned,
          confirmed: r.confirmed,
          stillBlocked: r.stillBlocked,
          channelsEnsured: r.channelsEnsured,
          channelsFailed: r.channelsFailed,
          channelsSkipped: r.channelsSkipped,
          channelBuyerOps: r.channelBuyerOps,
          channelsDeferred: r.channelsDeferred,
        }),
        status: (r) => statusFor(r, r.channelsFailed > 0),
        failureMessage: "Failed to reconcile orphaned confirmations",
      }),
  },

  // @cleanup-twin reconcile-orphaned-payments
  "reconcile-orphaned-payments": {
    meta: {
      title: "Heal orphaned payments",
      description: "Link, refund or escrow succeeded payments with no booking",
      category: "Payments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasOrphanedPaymentWork } =
          await import("@/scripts/payments/reconcile-orphaned-confirmations");
        return hasOrphanedPaymentWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-orphaned-payments",
        run: async (req) => {
          const { reconcileOrphanedPayments } =
            await import("@/scripts/payments/reconcile-orphaned-confirmations");
          const limit = parseLimitParam(req);
          return reconcileOrphanedPayments(
            limit === undefined ? {} : { limit },
          );
        },
        summarize: (r) => ({
          scanned: r.scanned,
          linked: r.linked,
          refunded: r.refunded,
          escrowed: r.escrowed,
          nonGatewaySkipped: r.nonGatewaySkipped,
          topupSkipped: r.topupSkipped,
          stillFailing: r.stillFailing,
        }),
        status: (r) => statusFor(r, r.escrowed > 0 || r.stillFailing > 0),
        failureMessage: "Failed to reconcile orphaned payments",
      }),
  },

  // @cleanup-twin reconcile-orphaned-recordings
  "reconcile-orphaned-recordings": {
    meta: {
      title: "Recover missing recordings",
      description: "Queue recovery of missing recording webhook deliveries",
      category: "Recordings",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Lists recordings at Stream to recover missed webhooks; vendor state.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-orphaned-recordings",
        run: async () => {
          const { dispatchBackgroundJob } =
            await import("@/lib/cron/dispatch-background");
          return dispatchBackgroundJob("reconcile-orphaned-recordings");
        },
        status: () => 202,
        failureMessage: "Stream lifecycle dispatch failed",
      }),
  },

  // @cleanup-twin reconcile-org-invoice-payments
  "reconcile-org-invoice-payments": {
    meta: {
      title: "Recover invoice payments",
      description: "Recover captured invoice orders after missed webhooks",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due six times a day; a probe would save at most 180 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-org-invoice-payments",
        run: async (req, { startedAt }) => {
          const { reconcileOrgInvoicePayments } =
            await import("@/lib/payments/billing/reconcile-invoice-payments");
          return reconcileOrgInvoicePayments({
            limit: parseLimitParamOrDefault(req, 5),
            startedAt,
          });
        },
        needsAttention: (r) => r.unapplied > 0,
        failureMessage: "Failed to reconcile invoice payments",
      }),
  },

  // @cleanup-twin reconcile-payment-status
  "reconcile-payment-status": {
    meta: {
      title: "Reconcile payment status",
      description:
        "Query Razorpay for the actual status of stale pending payments",
      category: "Payments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasPaymentStatusReconcileWork } =
          await import("@/scripts/payments/reconcile-payment-status");
        return hasPaymentStatusReconcileWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-payment-status",
        run: async (req) => {
          const { reconcilePaymentStatus } =
            await import("@/scripts/payments/reconcile-payment-status");
          return reconcilePaymentStatus({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          succeededCount: r.succeededCount,
          failedCount: r.failedCount,
          unresolvableCount: r.unresolvableCount,
          retiredCount: r.retiredCount,
          deadLettered: r.deadLettered,
          errors: r.errors.slice(0, 5),
        }),
        needsAttention: (r) =>
          r.succeededCount > 0 || r.unresolvableCount > 0 || r.retiredCount > 0,
        failureMessage: "Failed to reconcile payment status",
      }),
  },

  // @cleanup-twin reconcile-payout-status
  "reconcile-payout-status": {
    meta: {
      title: "Reconcile payout status",
      description: "Sync pending and processing payout status with RazorpayX",
      category: "Payouts",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasPayoutStatusReconcileWork } =
          await import("@/scripts/payouts/reconcile-payout-status");
        return hasPayoutStatusReconcileWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-payout-status",
        run: async (req, { startedAt }) => {
          const { reconcilePayoutStatus } =
            await import("@/scripts/payouts/reconcile-payout-status");
          return reconcilePayoutStatus({
            limit: parseLimitParamOrDefault(req, MAX_PAYOUT_STATUS_POLLS),
            startedAt,
          });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          completedCount: r.completedCount,
          failedCount: r.failedCount,
          discrepanciesCount: r.discrepancies.length,
        }),
        needsAttention: (r) => r.discrepancies.length > 0,
        failureMessage: "Failed to reconcile payout status",
      }),
  },

  // @cleanup-twin reconcile-refunds
  "reconcile-refunds": {
    meta: {
      title: "Reconcile pending refunds",
      description: "Sync pending refund status with Razorpay",
      category: "Refunds",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasPendingRefundWork } =
          await import("@/scripts/refunds/reconcile-pending-refunds");
        return hasPendingRefundWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-pending-refunds",
        run: async (req) => {
          const { reconcilePendingRefunds } =
            await import("@/scripts/refunds/reconcile-pending-refunds");
          return reconcilePendingRefunds({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          failedCount: r.failedCount,
          skippedCount: r.skippedCount,
          failedUnknownId: r.failedUnknownId,
          redrivenCount: r.redrivenCount,
          redriveFailedCount: r.redriveFailedCount,
          redriveDeadLettered: r.redriveDeadLettered,
          errors: r.errors.slice(0, 5),
        }),
        failureMessage: "Failed to reconcile refunds",
      }),
  },

  // @cleanup-twin reconcile-sessions
  "reconcile-sessions": {
    meta: {
      title: "Reconcile ended sessions",
      description: "Recover overdue meeting end and presence state",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasOrphanedSessionWork } =
          await import("@/lib/meetings/reconcile-orphaned-sessions");
        return hasOrphanedSessionWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-orphaned-sessions",
        run: async (req) => {
          const { reconcileOrphanedSessions } =
            await import("@/lib/meetings/reconcile-orphaned-sessions");
          return reconcileOrphanedSessions({ limit: parseLimitParam(req) });
        },
        unauthorizedMessage:
          "Please provide a valid authorization header with the CRON_SECRET",
        failureMessage: "Reconciliation job failed",
      }),
  },

  // @cleanup-twin release-earnings
  "release-earnings": {
    meta: {
      title: "Release earnings",
      description: "Move held earnings to ready after the hold period",
      category: "Earnings",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasReleasableEarningsWork } =
          await import("@/scripts/earnings/release-earnings");
        return hasReleasableEarningsWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "release-earnings",
        run: async (req) => {
          const { releaseEarningsFromHold } =
            await import("@/scripts/earnings/release-earnings");
          return releaseEarningsFromHold({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          releasedCount: r.releasedCount,
          organizationEarningsReleased: r.organizationEarningsReleased,
          errorCount: r.errorCount,
        }),
        items: (r) => ({
          processed: r.releasedCount + r.organizationEarningsReleased,
        }),
        failureMessage: "Failed to release earnings",
      }),
  },

  // @cleanup-twin reschedule-proposals
  "reschedule-proposals": {
    meta: {
      title: "Expire reschedule proposals",
      description:
        "Lapse reschedule proposals nobody answered and restore the original time",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasRescheduleProposalWork } =
          await import("@/scripts/appointments/expire-reschedule-proposals");
        return hasRescheduleProposalWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "expire-reschedule-proposals",
        run: async (req) => {
          const { expireRescheduleProposals } =
            await import("@/scripts/appointments/expire-reschedule-proposals");
          return expireRescheduleProposals({
            maxPerRun: parseLimitParamOrDefault(req, MAX_RESCHEDULE_PROPOSALS),
          });
        },
        summarize: (r) => ({
          proposalsExpired: r.proposalsExpired,
          proposalsExpiredUnrestored: r.proposalsExpiredUnrestored,
          hasMore: r.hasMore,
        }),
        items: (r) => ({ processed: r.proposalsExpired }),
        failureMessage: "Failed to expire reschedule proposals",
      }),
  },

  // @cleanup-twin retry-auto-refunds
  "retry-auto-refunds": {
    meta: {
      title: "Retry owed refunds",
      description:
        "Re-drive auto-refunds the capture webhook could not complete",
      category: "Refunds",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAutoRefundRetryWork } =
          await import("@/scripts/payments/retry-auto-refunds");
        return hasAutoRefundRetryWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "retry-auto-refunds",
        run: async (req) => {
          const { retryAutoRefunds } =
            await import("@/scripts/payments/retry-auto-refunds");
          return retryAutoRefunds({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          refunded: r.refunded,
          settled: r.settled,
          // Owed attempts that failed this run count too, so a gateway outage reads as partial.
          failed: r.failed + r.owed.failed,
          stuck: r.stuck,
          errors: r.errors,
          owed: r.owed,
          hasMore: r.hasMore,
        }),
        // A failed owed attempt answers 207 too; the summary's `failed` keeps it partial, not attention.
        needsAttention: (r) =>
          r.stuck.length > 0 || r.owed.stuck.length > 0 || r.owed.failed > 0,
        failureMessage: "Failed to retry auto-refunds",
      }),
  },

  // @cleanup-twin reconcile-standalone-purchases
  "reconcile-standalone-purchases": {
    meta: {
      title: "Recover standalone purchases",
      description:
        "Settle digital product and replay purchases whose capture never arrived; fail empty orders after 24 hours",
      category: "Payments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasStandalonePurchaseWork } =
          await import("@/scripts/payments/reconcile-standalone-purchases");
        return hasStandalonePurchaseWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-standalone-purchases",
        run: async (req) => {
          const { reconcileStandalonePurchases } =
            await import("@/scripts/payments/reconcile-standalone-purchases");
          return reconcileStandalonePurchases({
            limit: parseLimitParamOrDefault(
              req,
              MAX_STANDALONE_PURCHASE_CHECKS,
            ),
          });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          recovered: r.recovered,
          expired: r.expired,
          receipts: r.receipts,
          errors: r.errors,
        }),
        items: (r) => ({ processed: r.scanned, errors: r.errors }),
        failureMessage: "Failed to reconcile standalone purchases",
      }),
  },

  // @cleanup-twin reconcile-digital-product-storage
  "reconcile-digital-product-storage": {
    meta: {
      title: "Digital product storage",
      description:
        "Delete superseded, rejected and abandoned product files and bucket objects no row names",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Compares Supabase Storage objects with product file rows; vendor state.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-digital-product-storage",
        run: async (req) => {
          const { reconcileDigitalProductStorage } =
            await import("@/lib/digital-products/storage-sweep");
          return reconcileDigitalProductStorage({
            limit: parseLimitParamOrDefault(
              req,
              MAX_DIGITAL_PRODUCT_STORAGE_ROWS,
            ),
          });
        },
        status: (r) => statusFor(r),
        items: (r) => ({
          processed: r.supersededPurged + r.uploadsCleared + r.orphansDeleted,
          errors: r.failed,
        }),
        failureMessage: "Failed to reconcile digital product storage",
      }),
  },

  // @cleanup-twin retry-failed-emails
  "retry-failed-emails": {
    meta: {
      title: "Retry failed emails",
      description: "Resend emails whose delivery failed",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasEmailRetryWork } =
          await import("@/jobs/email/retry-failed-emails");
        return hasEmailRetryWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "retry-failed-emails",
        run: async (req) => {
          const { retryFailedEmails } =
            await import("@/jobs/email/retry-failed-emails");
          return retryFailedEmails({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          sent: r.sent,
          retried: r.retried,
          deadLettered: r.deadLettered,
          batchesScanned: r.batchesScanned,
          batchesSent: r.batchesSent,
          batchesRetried: r.batchesRetried,
          batchesDeadLettered: r.batchesDeadLettered,
          errors: r.errors.length,
        }),
        status: (r) => (r.errors.length > 0 ? 500 : 200),
        unauthorizedMessage: "Provide a valid Bearer CRON_SECRET",
        failureMessage: "Email relay tick failed",
      }),
  },

  // @cleanup-twin retry-moderation-enforcement
  "retry-moderation-enforcement": {
    meta: {
      title: "Retry moderation enforcement",
      description: "Re-apply chat moderation writes that failed at Stream",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasModerationRetryWork } =
          await import("@/scripts/cleanup/retry-moderation-enforcement");
        return hasModerationRetryWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "retry-moderation-enforcement",
        run: async () => {
          const { retryModerationEnforcement } =
            await import("@/scripts/cleanup/retry-moderation-enforcement");
          return retryModerationEnforcement();
        },
        summarize: (r) => ({
          scanned: r.scanned,
          recovered: r.recovered,
          collaboratorRecovered: r.collaboratorRecovered,
          erasureRevocationsRecovered: r.erasureRevocationsRecovered,
          accessRevocationsRecovered: r.accessRevocationsRecovered,
          stillFailing: r.stillFailing,
          gaveUp: r.gaveUp,
          streamUnconfigured: r.streamUnconfigured,
        }),
        status: (r) =>
          r.stillFailing > 0 || r.gaveUp > 0 || r.streamUnconfigured > 0
            ? 207
            : 200,
        failureMessage: "Failed to retry moderation enforcement",
      }),
  },

  // @cleanup-twin reconcile-stream-memberships
  "reconcile-stream-memberships": {
    meta: {
      title: "Reconcile chat memberships",
      description: "Align Stream channel members with database access",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Compares Stream channel members with database access; vendor state.",
    },
    build: () =>
      cleanupRoute({
        job: "reconcile-stream-memberships",
        run: async (req, { startedAt }) => {
          const { reconcileStreamMemberships, DEFAULT_CHANNELS_PER_RUN } =
            await import("@/lib/stream/membership-reconciler");
          return reconcileStreamMemberships({
            limit: parseLimitParamOrDefault(req, DEFAULT_CHANNELS_PER_RUN),
            startedAt,
          });
        },
        summarize: (r) => ({
          channelsScanned: r.channelsScanned,
          channelsSkipped: r.channelsSkipped,
          channelsSkippedSuspicious: r.channelsSkippedSuspicious,
          membersRemoved: r.membersRemoved,
          failures: r.failures,
          checkpoint: r.checkpoint,
        }),
        status: (r) => (r.failures > 0 ? 207 : 200),
        items: (r) => ({
          processed: r.channelsScanned,
          errors: r.failures,
        }),
        failureMessage: "Failed to reconcile Stream channel memberships",
      }),
  },

  // @cleanup-twin sentry-ingest-canary
  "sentry-ingest-canary": {
    meta: {
      title: "Sentry ingest canary",
      description:
        "Read Sentry's error outcomes for the last day and alert by email and Better Stack on rejections",
      category: "Alerts",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "A time-based check of Sentry's ingest outcomes; no queue to probe.",
    },
    build: () =>
      cleanupRoute({
        job: "sentry-ingest-canary",
        run: async () => {
          const token = process.env.SENTRY_STATS_TOKEN;
          if (!token) {
            const skipped: ConfigSkip = "SENTRY_STATS_TOKEN not configured";
            reportConfigSkip("sentry-ingest-canary", skipped);
            return { healthy: true, skipped };
          }
          const { withCronLock } = await import("@/lib/cron/with-cron-lock");
          const { checkSentryIngest, describeIngest, isIngestHealthy } =
            await import("@/lib/observability/ingest-canary");
          const { sendSentryIngestAlert } =
            await import("@/lib/observability/ingest-alert");
          const { checkSentryQuota } =
            await import("@/lib/observability/quota-alert");
          // Fail-open: a read-only vendor probe whose repeat costs one stats read.
          return withCronLock(
            "sentry-ingest-canary",
            { failMode: "open" },
            async () => {
              const check = await checkSentryIngest(token);
              const healthy = isIngestHealthy(check);
              const alerted = healthy
                ? false
                : await sendSentryIngestAlert(check);
              // After the page: the 70% warning must not spend the ceiling ahead of it.
              const quota = await checkSentryQuota();
              return {
                healthy,
                verdict: check.verdict,
                accepted: check.accepted,
                rejections: check.rejections,
                alerted,
                detail: describeIngest(check),
                quota,
              };
            },
          );
        },
        // An unhealthy verdict is a finding with its own email; the run still counts as ran.
        needsAttention: (result) => !result.healthy,
        items: () => ({ processed: 1 }),
        failureMessage:
          "The Sentry ingest canary route failed to run. This is a fault in the canary, not a verdict about Sentry.",
      }),
  },

  // @cleanup-twin settle-cancelled-sessions
  "settle-cancelled-sessions": {
    meta: {
      title: "Settle cancelled sessions",
      description: "Refund cancelled class sessions not made up within 14 days",
      category: "Refunds",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasSettleCancelledSessionsWork } =
          await import("@/scripts/appointments/settle-cancelled-sessions");
        return hasSettleCancelledSessionsWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "settle-cancelled-sessions",
        run: async (req) => {
          const { settleCancelledSessions } =
            await import("@/scripts/appointments/settle-cancelled-sessions");
          return settleCancelledSessions({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          plansScanned: r.plansScanned,
          plansWaiting: r.plansWaiting,
          stamped: r.stamped,
          refunded: r.refunded,
          errors: r.errors,
          hasMore: r.hasMore,
          checkpoint: r.checkpoint,
        }),
        failureMessage: "Failed to settle cancelled class sessions",
      }),
  },

  // @cleanup-twin maintenance-booking-remediation
  "maintenance-booking-remediation": {
    meta: {
      title: "Maintenance booking remediation",
      description:
        "Process one explicitly confirmed booking cancellation; held until maintenance ends",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasMaintenanceRemediationWork } =
          await import("@/lib/maintenance-remediation");
        return hasMaintenanceRemediationWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "maintenance-booking-remediation",
        run: async () => {
          const { runMaintenanceRemediationSlice } =
            await import("@/lib/maintenance-remediation");
          return runMaintenanceRemediationSlice();
        },
        summarize: (r) => ({ processed: r.processed }),
        failureMessage: "Failed to process confirmed maintenance cancellations",
      }),
  },

  // @cleanup-twin settle-platform-incidents
  "settle-platform-incidents": {
    meta: {
      title: "Settle platform incidents",
      description:
        "Void and refund the sessions of a declared platform incident",
      category: "Refunds",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasPlatformIncidentWork } =
          await import("@/scripts/appointments/settle-platform-incidents");
        return hasPlatformIncidentWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "settle-platform-incidents",
        run: async (req, { startedAt }) => {
          const { settlePlatformIncidents } =
            await import("@/scripts/appointments/settle-platform-incidents");
          return settlePlatformIncidents({
            limit: parseLimitParam(req),
            startedAt,
          });
        },
        summarize: (r) => ({
          incidents: r.incidents,
          voided: r.voided,
          remediesCreated: r.remediesCreated,
          remediesDone: r.remediesDone,
          deadLettered: r.deadLettered,
          digests: r.digests,
          settled: r.settled,
          errors: r.errors,
        }),
        items: (r) => ({ processed: r.incidents }),
        failureMessage: "Failed to settle declared platform incidents",
      }),
  },

  // @cleanup-twin settle-invoice-accruals
  "settle-invoice-accruals": {
    meta: {
      title: "Settle invoice accruals",
      description: "Roll the month's organisation accruals into invoices",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due only on the 1st of the month; a probe would save at most 16 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "settle-invoice-accruals",
        run: async (req) => {
          const { runSettleInvoiceAccruals } =
            await import("@/jobs/billing/settle-invoice-accruals");
          return runSettleInvoiceAccruals({
            limit: parseLimitParamOrDefault(req, MAX_ACCRUAL_ROLLUPS),
            windowStart: parseWindowStartParam(req),
          });
        },
        summarize: (r) => ({
          orgsProcessed: r.orgsProcessed,
          invoicesCreated: r.invoicesCreated,
          failed: r.failed,
          remaining: r.remaining,
        }),
        status: (r) => statusFor({}, r.failed > 0),
        items: (r) => ({ processed: r.orgsProcessed }),
        failureMessage: "Failed to settle invoice accruals",
      }),
  },

  // @cleanup-twin stream-control-plane-drift
  "stream-control-plane-drift": {
    meta: {
      title: "Stream configuration drift",
      description:
        "Check Stream app settings against the expected configuration",
      category: "Alerts",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Compares Stream app settings with the expected configuration; vendor state.",
    },
    build: () =>
      cleanupRoute({
        job: "stream-control-plane-drift",
        run: async () => {
          const { withCronLock } = await import("@/lib/cron/with-cron-lock");
          const { detectStreamControlPlaneDrift } =
            await import("@/lib/stream/control-plane-drift");
          // Fail-open: the detector only reads Stream settings.
          return withCronLock(
            "stream-control-plane-drift",
            { failMode: "open" },
            () => detectStreamControlPlaneDrift(),
          );
        },
        summarize: (r) => ({
          drifted: r.drifted,
          findings: r.findings.length,
          unverified: r.unverified.length,
        }),
        // Drift is already reported once to Sentry by the detector; 207 only marks the run.
        needsAttention: (r) => r.drifted,
        items: (r) => ({ processed: r.findings.length }),
        failureMessage: "Failed to check the Stream control plane for drift",
      }),
  },

  // @cleanup-twin stream-sync
  "stream-sync": {
    meta: {
      title: "Sync Stream users",
      description:
        "Queue a comparison of Stream principals against database ownership",
      category: "Messaging",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Compares Stream principals with database ownership; vendor state.",
    },
    build: () =>
      cleanupRoute({
        job: "stream-sync",
        run: async (req) => {
          const { dispatchBackgroundJob } =
            await import("@/lib/cron/dispatch-background");
          return dispatchBackgroundJob("stream-sync", {
            dryRun: req.nextUrl.searchParams.get("dry-run") === "true",
          });
        },
        status: () => 202,
        failureMessage: "Stream lifecycle dispatch failed",
      }),
  },

  // @cleanup-twin support-sla-sweep
  "support-sla-sweep": {
    meta: {
      title: "Support SLA sweep",
      description: "Stage support SLA and dispute deadline notices",
      category: "Support",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasSupportSlaSweepWork } =
          await import("@/lib/support/sla-sweep");
        return hasSupportSlaSweepWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "support-sla-sweep",
        run: async (req, { startedAt }) => {
          const { runSupportSlaSweep } =
            await import("@/lib/support/sla-sweep");
          return runSupportSlaSweep({ limit: parseLimitParam(req), startedAt });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          slaNoticesStaged: r.slaNoticesStaged,
          orgEscalationEmailsSent: r.orgEscalationEmailsSent,
          autoClosedCount: r.autoClosedCount,
          autoCloseHeldOpen: r.autoCloseHeldOpen,
          autoCloseHolds: r.autoCloseHolds,
          autoCloseHasMore: r.autoCloseHasMore,
          incidentsCascaded: r.incidentsCascaded,
          incidentsHeldOpen: r.incidentsHeldOpen,
          evidenceCasesPurged: r.evidenceCasesPurged,
          evidenceFilesDeleted: r.evidenceFilesDeleted,
          chatAccessEnded: r.chatAccessEnded,
          chatInterventionsJoined: r.chatInterventionsJoined,
          chatInterventionsLeft: r.chatInterventionsLeft,
          chatBoundariesSynced: r.chatBoundariesSynced,
          chatReviewNotices: r.chatReviewNotices,
          disputeNoticesStaged: r.disputeNoticesStaged,
          errors: r.errors.length,
        }),
        status: (r) => statusFor(r, r.errors.length > 0),
        failureMessage: "Failed to run support SLA sweep",
      }),
  },

  // @cleanup-twin sweep-abandoned-overage-charges
  "sweep-abandoned-overage-charges": {
    meta: {
      title: "Abandoned overage charges",
      description: "Write off member overage charges nobody paid",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasAbandonedOverageWork } =
          await import("@/scripts/cleanup/sweep-abandoned-overage-charges");
        return hasAbandonedOverageWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "sweep-abandoned-overage-charges",
        run: async (req) => {
          const { sweepAbandonedOverageCharges } =
            await import("@/scripts/cleanup/sweep-abandoned-overage-charges");
          return sweepAbandonedOverageCharges({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({ scanned: r.scanned, failed: r.failed }),
        failureMessage: "Failed to sweep abandoned overage charges",
      }),
  },

  // @cleanup-twin sweep-orphaned-topup-captures
  "sweep-orphaned-topup-captures": {
    meta: {
      title: "Orphaned top-up captures",
      description:
        "Credit wallet top-ups whose capture never reached the wallet",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasOrphanedTopupCaptureWork } =
          await import("@/scripts/cleanup/sweep-orphaned-topup-captures");
        return hasOrphanedTopupCaptureWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "sweep-orphaned-topup-captures",
        run: async (req) => {
          const { sweepOrphanedTopupCaptures } =
            await import("@/scripts/cleanup/sweep-orphaned-topup-captures");
          return sweepOrphanedTopupCaptures({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          recredited: r.recredited,
          stillFailing: r.stillFailing,
        }),
        status: (r) => (r.stillFailing > 0 ? 207 : 200),
        failureMessage: "Failed to sweep captured top-ups",
      }),
  },

  // @cleanup-twin sweep-stuck-webhook-events
  "sweep-stuck-webhook-events": {
    meta: {
      title: "Stuck webhook events",
      description:
        "Re-drive inbound webhook events left unprocessed or transiently failed",
      category: "Payments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasStuckWebhookEventWork } =
          await import("@/scripts/cleanup/sweep-stuck-webhook-events");
        return hasStuckWebhookEventWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "sweep-stuck-webhook-events",
        run: async (req) => {
          const { sweepStuckWebhookEvents } =
            await import("@/scripts/cleanup/sweep-stuck-webhook-events");
          return sweepStuckWebhookEvents({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          recovered: r.recovered,
          stillFailing: r.stillFailing,
        }),
        status: (r) => (r.stillFailing > 0 ? 207 : 200),
        failureMessage: "Failed to sweep stuck webhook events",
      }),
  },

  // @cleanup-twin sweep-verification
  "sweep-verification": {
    meta: {
      title: "Verification housekeeping",
      description:
        "Remove unlinked verification uploads and expire stale verification state",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun: "Due once a day; a probe would save at most 30 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "sweep-verification",
        run: async () => {
          const { sweepVerification } =
            await import("@/scripts/cleanup/sweep-verification");
          return sweepVerification();
        },
        summarize: (r) => ({
          unlinkedDeleted: r.unlinkedDeleted,
          remindersSent: r.remindersSent,
          staleClosed: r.staleClosed,
          errors: r.errors.length,
        }),
        status: (r) => statusFor(r, r.errors.length > 0),
        items: (r) => ({
          processed: r.unlinkedDeleted + r.remindersSent + r.staleClosed,
        }),
        failureMessage: "Failed to sweep verification",
      }),
  },

  // @cleanup-twin sync-payment-earnings
  "sync-payment-earnings": {
    meta: {
      title: "Sync payment earnings",
      description: "Create missing earnings records for succeeded payments",
      category: "Earnings",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasPaymentEarningsSyncWork } =
          await import("@/scripts/earnings/sync-payment-earnings");
        return hasPaymentEarningsSyncWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "sync-payment-earnings",
        run: async (req) => {
          const { syncPaymentEarnings } =
            await import("@/scripts/earnings/sync-payment-earnings");
          return syncPaymentEarnings({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          createdCount: r.createdCount,
          skippedCount: r.skippedCount,
          errorCount: r.errorCount,
        }),
        failureMessage: "Failed to sync payment earnings",
      }),
  },

  // @cleanup-twin timeout-member-overages
  "timeout-member-overages": {
    meta: {
      title: "Time out member overages",
      description: "Fail member overage charges past their payment window",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due three times a day in its window; a probe would save at most 90 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "timeout-member-overages",
        run: async (req) => {
          const { runTimeoutMemberOverages } =
            await import("@/jobs/billing/timeout-member-overages");
          return runTimeoutMemberOverages({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
            windowStart: parseWindowStartParam(req),
          });
        },
        failureMessage: "Failed to time out member overages",
      }),
  },

  // @cleanup-twin tds-return-draft
  "tds-return-draft": {
    meta: {
      title: "TDS return draft",
      description: "Export the quarterly 26Q TDS return draft",
      category: "Compliance",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "A quarterly statutory export in its calendar window; the period is the work.",
    },
    build: () =>
      cleanupRoute({
        job: "tds-26q-draft-export",
        run: async (req) => {
          const { runTdsReturnDraftExport } =
            await import("@/jobs/compliance/tds-26q-draft-export");
          return runTdsReturnDraftExport(parseTdsReturnParams(req));
        },
        summarize: (r) => ({
          financialYear: r.financialYear,
          quarter: r.quarter,
          deducteeCount: r.deducteeCount,
          alreadyReported: r.alreadyReported,
          warnings: r.warnings.length,
          storagePath: r.storagePath,
        }),
        status: () => 200,
        items: (r) => ({ processed: r.deducteeCount }),
        failureMessage: "Failed to export the TDS return draft",
      }),
  },

  // @cleanup-twin tentative-occurrences
  "tentative-occurrences": {
    meta: {
      title: "Release tentative slots",
      description: "Release slots held for abandoned booking flows",
      category: "Appointments",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasTentativeOccurrenceWork } =
          await import("@/scripts/appointments/cleanup-tentative-occurrences");
        return hasTentativeOccurrenceWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "cleanup-tentative-occurrences",
        run: async (req) => {
          const { cleanupTentativeOccurrences } =
            await import("@/scripts/appointments/cleanup-tentative-occurrences");
          return cleanupTentativeOccurrences({
            maxPerRun: parseLimitParamOrDefault(req, MAX_TENTATIVE_SLOTS),
          });
        },
        summarize: (r) => ({
          slotsReleased: r.slotsReleased,
          appointmentsAffected: r.appointmentsAffected,
        }),
        items: (r) => ({ processed: r.slotsReleased }),
        failureMessage: "Failed to cleanup tentative slots",
      }),
  },

  // @cleanup-twin transfer-recordings
  "transfer-recordings": {
    meta: {
      title: "Copy recordings",
      description: "Queue the next session recording for permanent storage",
      category: "Recordings",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasRecordingTransferWork } =
          await import("@/lib/stream/recording-transfer-service");
        return hasRecordingTransferWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "transfer-recordings",
        run: async (req) => {
          parseLimitParam(req);
          const { dispatchBackgroundJob } =
            await import("@/lib/cron/dispatch-background");
          return dispatchBackgroundJob("transfer-recordings");
        },
        status: () => 202,
        failureMessage: "Recording copy sweep failed",
      }),
  },

  // @cleanup-twin vest-referral-credits
  "vest-referral-credits": {
    meta: {
      title: "Vest referral credits",
      description: "Vest qualifying referral credits",
      category: "Earnings",
      manualRun: "inline",
    },
    idle: {
      hasWork: async (db, now, outOfTime) => {
        const { hasVestReferralWork } = await import("@/lib/referrals/vesting");
        return hasVestReferralWork(db, now, outOfTime);
      },
    },
    build: () =>
      cleanupRoute({
        job: "vest-referral-credits",
        run: async (req) => {
          const { runVestReferralCredits } =
            await import("@/lib/referrals/vesting");
          return runVestReferralCredits({
            limit: parseLimitParamOrDefault(req, MAX_REFERRAL_VESTS),
          });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          vested: r.vested,
          voided: r.voided,
          deferred: r.deferred,
          budgetExhausted: r.budgetExhausted,
          held: r.held,
          failed: r.failed,
        }),
        failureMessage: "Failed to vest referral credits",
      }),
  },

  // @cleanup-twin wallet-low-balance
  "wallet-low-balance": {
    meta: {
      title: "Wallet low balance",
      description:
        "Warn organisations whose wallet balance fell below their floor",
      category: "Billing",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due three times a day in its window; a probe would save at most 90 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "wallet-low-balance",
        run: async (req) => {
          const { runWalletLowBalance } =
            await import("@/jobs/billing/wallet-low-balance");
          return runWalletLowBalance({
            limit: parseLimitParamOrDefault(req, MAX_ORG_LIFECYCLE_CLAIMS),
          });
        },
        failureMessage: "Failed to run the wallet low-balance check",
      }),
  },

  // @cleanup-twin wind-down-deactivated-orgs
  "wind-down-deactivated-orgs": {
    meta: {
      title: "Wind down organisations",
      description:
        "Queue Stream access and recording cleanup for deactivated organisations",
      category: "Cleanup",
      manualRun: "inline",
    },
    idle: {
      alwaysRun:
        "Due three times a day in its window; a probe would save at most 90 calls a month.",
    },
    build: () =>
      cleanupRoute({
        job: "wind-down-deactivated-orgs",
        run: async () => {
          const { dispatchBackgroundJob } =
            await import("@/lib/cron/dispatch-background");
          return dispatchBackgroundJob("wind-down-deactivated-orgs");
        },
        status: () => 202,
        failureMessage: "Stream lifecycle dispatch failed",
      }),
  },
};

const handlerCache = new Map<string, CleanupRouteHandlers>();

export function getCleanupJobHandlers(
  slug: string,
): CleanupRouteHandlers | null {
  const cached = handlerCache.get(slug);
  if (cached) return cached;
  if (!Object.hasOwn(CLEANUP_JOB_BUILDERS, slug)) return null;
  const entry = CLEANUP_JOB_BUILDERS[slug];
  const built = entry.build();
  handlerCache.set(slug, built);
  return built;
}
