import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import { goHref } from "@/lib/dashboard/go";
import { notifyRecordingExpiring } from "@/lib/novu/service";
import { reportSentryError } from "@/lib/observability/report";
import { getAppUrl } from "@/lib/url";
import type { ReconcileRunSnapshot } from "@/scripts/reconcile/reconcile-ledgers";

export type CleanupRouteHandlers = {
  GET: (req: NextRequest) => Promise<NextResponse>;
  POST: (req: NextRequest) => Promise<NextResponse>;
};

const ReconcileLedgersQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  triggeredById: z.string().min(1).max(64).optional(),
  abandon: z.string().min(1).max(500).optional(),
  resume: z.enum(["1", "true"]).optional(),
});

type ReconcileLedgersTwinResult =
  | ({ success: true } & ReconcileRunSnapshot)
  | {
      success: true;
      status: "IDLE";
      runId: null;
      progress: null;
      report: null;
    };

type ExpiringStreamOnly = {
  recordingId: string;
  title: string;
  consultantUserId: string;
  expiresAt: Date;
};

async function notifyConsultantsOfExpiringRecordings(
  expiring: ExpiringStreamOnly[],
): Promise<void> {
  const byConsultant = new Map<string, ExpiringStreamOnly[]>();
  for (const rec of expiring) {
    if (!rec.consultantUserId) continue;
    const list = byConsultant.get(rec.consultantUserId) ?? [];
    list.push(rec);
    byConsultant.set(rec.consultantUserId, list);
  }

  const dashboardUrl = `${getAppUrl()}${goHref("expert", "recordings")}`;
  await Promise.allSettled(
    Array.from(byConsultant.entries()).map(([consultantUserId, recs]) => {
      const soonest = recs.reduce(
        (min, r) => (r.expiresAt < min ? r.expiresAt : min),
        recs[0].expiresAt,
      );
      return notifyRecordingExpiring(consultantUserId, {
        recordingCount: recs.length,
        expiresAt: soonest.toISOString(),
        dashboardUrl,
      });
    }),
  );
}

/**
 * Registry of `/api/cleanup/[job]` HTTP twins.
 *
 * Each entry is annotated with `@cleanup-twin <slug>` and lazily imports its
 * job module inside `run` so:
 * 1. Invoking one cleanup route does not load the other 47 job modules.
 * 2. `__tests__/maintenance/cron-lock-registry.test.ts` can statically inspect
 *    each slug's `job:` literal and imported core module.
 */
export const CLEANUP_JOB_BUILDERS: Record<string, () => CleanupRouteHandlers> =
  {
    // @cleanup-twin abandoned-org-top-ups
    "abandoned-org-top-ups": () =>
      cleanupRoute({
        job: "cleanup-abandoned-org-top-ups",
        run: async () => {
          const { cleanupAbandonedOrgTopUps } = await import(
            "@/scripts/cleanup/cleanup-abandoned-org-top-ups"
          );
          return cleanupAbandonedOrgTopUps();
        },
        summarize: (r) => ({
          reaped: r.reaped,
          graceHours: r.graceHours,
          success: r.success,
        }),
        unauthorizedMessage:
          "Please provide a valid authorization header with the CRON_SECRET",
        failureMessage: "Cleanup failed",
      }),

    // @cleanup-twin abandoned-payments
    "abandoned-payments": () =>
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
        }),
        status: (r) => statusFor({ success: r.overallSuccess }),
        unauthorizedMessage:
          "Please provide a valid authorization header with the CRON_SECRET",
        failureMessage: "Cleanup job failed",
      }),

    // @cleanup-twin alert-dispute-deadlines
    "alert-dispute-deadlines": () =>
      cleanupRoute({
        job: "alert-dispute-deadlines",
        run: async () => {
          const { alertDisputeDeadlines } = await import(
            "@/scripts/disputes/alert-dispute-deadlines"
          );
          return alertDisputeDeadlines();
        },
        summarize: (r) => ({
          urgentCount: r.urgentCount,
          criticalCount: r.criticalCount,
        }),
        status: (r) => (r.criticalCount > 0 ? 207 : 200),
        failureMessage: "Failed to check dispute deadlines",
      }),

    // @cleanup-twin alert-orphaned-payments
    "alert-orphaned-payments": () =>
      cleanupRoute({
        job: "alert-orphaned-payments",
        run: async () => {
          const { alertOrphanedPayments } = await import(
            "@/scripts/alerts/alert-orphaned-payments"
          );
          return alertOrphanedPayments();
        },
        summarize: (r) => ({
          totalOrphaned: r.totalOrphaned,
          criticalCount: r.criticalCount,
          totalAmount: r.totalAmount,
        }),
        status: (r) => (r.totalOrphaned > 0 ? 500 : 200),
        failureMessage: "Failed to check for orphaned payments",
      }),

    // @cleanup-twin appointment-reminders
    "appointment-reminders": () =>
      cleanupRoute({
        job: "appointment-reminders",
        run: async () => {
          const { sendAppointmentReminders } = await import(
            "@/scripts/appointments/send-appointment-reminders"
          );
          return sendAppointmentReminders();
        },
        summarize: (r) => ({
          reminders24h: r.reminders24h,
          reminders1h: r.reminders1h,
        }),
        failureMessage: "Failed to send appointment reminders",
      }),

    // @cleanup-twin archive-webhook-events
    "archive-webhook-events": () =>
      cleanupRoute({
        job: "archive-webhook-events",
        run: async () => {
          const { archiveWebhookEvents } = await import(
            "@/scripts/cleanup/archive-webhook-events"
          );
          return archiveWebhookEvents();
        },
        summarize: (r) => ({
          processedEventsDeleted: r.processedEventsDeleted,
          failedEventsDeleted: r.failedEventsDeleted,
          totalDeleted: r.totalDeleted,
        }),
        failureMessage: "Failed to archive webhook events",
      }),

    // @cleanup-twin auth-tokens
    "auth-tokens": () =>
      cleanupRoute({
        job: "cleanup-auth-tokens",
        run: async () => {
          const { cleanupAuthTokens } = await import(
            "@/scripts/cleanup/cleanup-auth-tokens"
          );
          return cleanupAuthTokens();
        },
        summarize: (r) => ({
          verificationTokensDeleted: r.verificationTokensDeleted,
          sessionsDeleted: r.sessionsDeleted,
          passwordResetTokensCleared: r.passwordResetTokensCleared,
          totalCleaned: r.totalCleaned,
        }),
        failureMessage: "Failed to cleanup auth tokens",
      }),

    // @cleanup-twin auto-complete-appointments
    "auto-complete-appointments": () =>
      cleanupRoute({
        job: "auto-complete-appointments",
        run: async () => {
          const { autoCompleteAppointments } = await import(
            "@/scripts/appointments/auto-complete-appointments"
          );
          return autoCompleteAppointments();
        },
        summarize: (r) => ({
          webinarsCompleted: r.webinarsCompleted,
          classesCompleted: r.classesCompleted,
          consultationsCompleted: r.consultationsCompleted,
          subscriptionsCompleted: r.subscriptionsCompleted,
        }),
        failureMessage: "Failed to auto-complete appointments",
      }),

    // @cleanup-twin create-payout-batch
    "create-payout-batch": () =>
      cleanupRoute({
        job: "create-payout-batch",
        run: async () => {
          const { createPayoutBatch } = await import("@/lib/payments/payouts");
          return { success: true, batchId: await createPayoutBatch() };
        },
        summarize: (r) => ({ batchId: r.batchId }),
        failureMessage: "Failed to create payout batch",
      }),

    // @cleanup-twin detect-consultant-no-shows
    "detect-consultant-no-shows": () =>
      cleanupRoute({
        job: "detect-consultant-no-shows",
        run: async () => {
          const { detectConsultantNoShows } = await import(
            "@/scripts/appointments/detect-consultant-no-shows"
          );
          return detectConsultantNoShows();
        },
        summarize: (r) => ({
          detected: r.detected,
          refunded: r.refunded,
          contradicted: r.contradicted,
          bothAbsentTickets: r.bothAbsentTickets,
        }),
        failureMessage: "Failed to detect consultant no-shows",
      }),

    // @cleanup-twin dispatch-outbound-webhooks
    "dispatch-outbound-webhooks": () =>
      cleanupRoute({
        job: "dispatch-outbound-webhooks",
        run: async (req) => {
          const { dispatchOutboundWebhooks } = await import(
            "@/scripts/cleanup/dispatch-outbound-webhooks"
          );
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

    // @cleanup-twin drain-notification-outbox
    "drain-notification-outbox": () =>
      cleanupRoute({
        job: "drain-notification-outbox",
        run: async (req) => {
          const { drainNotificationOutbox } = await import(
            "@/jobs/notifications/drain-notification-outbox"
          );
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

    // @cleanup-twin expire-stale-requests
    "expire-stale-requests": () =>
      cleanupRoute({
        job: "expire-stale-requests",
        run: async () => {
          const { expireStaleRequests } = await import(
            "@/scripts/appointments/expire-stale-requests"
          );
          return expireStaleRequests();
        },
        summarize: (r) => ({
          consultationsExpired: r.consultationsExpired,
          subscriptionsExpired: r.subscriptionsExpired,
          subscriptionNudgesSent: r.subscriptionNudgesSent,
          paymentPendingExpired: r.paymentPendingExpired,
        }),
        failureMessage: "Failed to expire stale requests",
      }),

    // @cleanup-twin expire-unpaid-trials
    "expire-unpaid-trials": () =>
      cleanupRoute({
        job: "expire-unpaid-trials",
        run: async () => {
          const { expireUnpaidTrials } = await import(
            "@/scripts/trials/expire-unpaid-trials"
          );
          return expireUnpaidTrials();
        },
        summarize: (r) => ({ trialsExpired: r.trialsExpired }),
        failureMessage: "Failed to expire unpaid trial sessions",
      }),

    // @cleanup-twin gst-outward-register-export
    "gst-outward-register-export": () =>
      cleanupRoute({
        job: "gst-outward-register-export",
        run: async () => {
          const { runGstOutwardRegisterExport } = await import(
            "@/jobs/compliance/gst-outward-register-export"
          );
          return runGstOutwardRegisterExport({ writeCsv: false });
        },
        summarize: (r) => ({
          period: r.period,
          mintedByHealer: r.mintedByHealer,
          documentCount: r.documentCount,
          warnings: r.warnings,
        }),
        status: () => 200,
        failureMessage: "Failed to export the GST outward-supplies register",
      }),

    // @cleanup-twin handle-stuck-payouts
    "handle-stuck-payouts": () =>
      cleanupRoute({
        job: "handle-stuck-payouts",
        run: async () => {
          const { handleStuckPayouts } = await import(
            "@/scripts/payouts/handle-stuck-payouts"
          );
          return handleStuckPayouts();
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          retriedCount: r.retriedCount,
          failedCount: r.failedCount,
        }),
        failureMessage: "Failed to handle stuck payouts",
      }),

    // @cleanup-twin mark-expired-recordings
    "mark-expired-recordings": () =>
      cleanupRoute({
        job: "mark-expired-recordings",
        run: async () => {
          const { RecordingTransferService } = await import(
            "@/lib/stream/recording-transfer-service"
          );
          const { withCronLock } = await import("@/lib/cron/with-cron-lock");
          const expiredCount = await withCronLock(
            "mark-expired-recordings",
            { failMode: "open" },
            () => RecordingTransferService.markExpiredRecordings(),
          );
          return { success: true, expiredCount };
        },
        summarize: (r) => ({ expiredCount: r.expiredCount }),
        failureMessage: "Cron job failed",
      }),

    // @cleanup-twin old-stream-recordings
    "old-stream-recordings": () =>
      cleanupRoute({
        job: "cleanup-old-stream-recordings",
        run: async () => {
          const { cleanupOldStreamRecordings } = await import(
            "@/scripts/cleanup/cleanup-old-stream-recordings"
          );
          return cleanupOldStreamRecordings();
        },
        summarize: (r) => ({ success: r.success }),
        failureMessage: "Stream retention sweep failed",
      }),

    // @cleanup-twin process-data-exports
    "process-data-exports": () =>
      cleanupRoute({
        job: "process-data-exports",
        run: async () => {
          const { processDataExports } = await import(
            "@/scripts/cleanup/process-data-exports"
          );
          return processDataExports();
        },
        summarize: (r) => ({
          picked: r.picked,
          succeeded: r.succeeded,
          failed: r.failed,
        }),
        failureMessage: "Data export tick failed",
      }),

    // @cleanup-twin process-payouts
    "process-payouts": () =>
      cleanupRoute({
        job: "process-payouts",
        run: async () => {
          const { processApprovedPayouts, REQUEST_PAYOUT_RUN_BOUNDS } =
            await import("@/lib/payments/payouts");
          const results = await processApprovedPayouts(
            REQUEST_PAYOUT_RUN_BOUNDS,
          );
          const succeeded = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;
          return {
            success: failed === 0,
            processed: results.length,
            succeeded,
            failed,
            results,
          };
        },
        summarize: (r) => ({
          succeeded: r.succeeded,
          failed: r.failed,
          processed: r.processed,
        }),
        failureMessage: "Failed to process payouts",
      }),

    // @cleanup-twin prune-audit-logs
    "prune-audit-logs": () =>
      cleanupRoute({
        job: "prune-audit-logs",
        run: async () => {
          const { pruneAuditLogs } = await import(
            "@/scripts/cleanup/prune-audit-logs"
          );
          return pruneAuditLogs();
        },
        failureMessage: "Audit prune failed",
      }),

    // @cleanup-twin prune-system-job-executions
    "prune-system-job-executions": () =>
      cleanupRoute({
        job: "prune-system-job-executions",
        run: async () => {
          const { pruneSystemJobExecutions } = await import(
            "@/scripts/cleanup/prune-system-job-executions"
          );
          return pruneSystemJobExecutions();
        },
        status: () => 200,
        failureMessage: "System job execution prune failed",
      }),

    // @cleanup-twin reconcile-disputes
    "reconcile-disputes": () =>
      cleanupRoute({
        job: "reconcile-disputes",
        run: async () => {
          const { reconcileDisputes } = await import(
            "@/scripts/disputes/reconcile-disputes"
          );
          const result = await reconcileDisputes();
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
          skippedFenced: r.skippedFenced,
        }),
        failureMessage: "Failed to reconcile disputes",
      }),

    // @cleanup-twin reconcile-document-storage
    "reconcile-document-storage": () =>
      cleanupRoute({
        job: "reconcile-document-storage",
        run: async () => {
          const { reconcileDocumentStorage } = await import(
            "@/scripts/cleanup/reconcile-document-storage"
          );
          return reconcileDocumentStorage();
        },
        summarize: (r) => ({
          orphanedFilesFound: r.orphanedFilesFound,
          orphanedFilesDeleted: r.orphanedFilesDeleted,
          missingFilesFound: r.missingFilesFound,
        }),
        status: (r) => statusFor(r, r.missingFilesFound > 0),
        failureMessage: "Failed to reconcile document storage",
      }),

    // @cleanup-twin reconcile-ledgers
    "reconcile-ledgers": () =>
      cleanupRoute({
        job: "reconcile-ledgers",
        run: async (req): Promise<ReconcileLedgersTwinResult> => {
          const {
            advanceReconcileRun,
            findInFlightReconcileRun,
            markReconcileRunFailed,
          } = await import("@/scripts/reconcile/reconcile-ledgers");
          const limit = parseLimitParam(req);
          const q = ReconcileLedgersQuerySchema.parse({
            runId: req.nextUrl.searchParams.get("runId") ?? undefined,
            triggeredById:
              req.nextUrl.searchParams.get("triggeredById") ?? undefined,
            abandon: req.nextUrl.searchParams.get("abandon") ?? undefined,
            resume: req.nextUrl.searchParams.get("resume") ?? undefined,
          });
          if (q.abandon && q.runId) {
            await markReconcileRunFailed(q.runId, q.abandon);
            return {
              success: true,
              runId: q.runId,
              scope: "full",
              status: "FAILED",
              progress: null,
              report: null,
              error: q.abandon,
            };
          }
          if (q.resume && !q.runId) {
            const inFlight = await findInFlightReconcileRun();
            if (!inFlight) {
              return {
                success: true,
                status: "IDLE",
                runId: null,
                progress: null,
                report: null,
              };
            }
            const snap = await advanceReconcileRun({
              runId: inFlight,
              ...(limit === undefined ? {} : { limit }),
            });
            return { success: true, ...snap };
          }
          const snap = await advanceReconcileRun({
            runId: q.runId ?? randomUUID(),
            ...(limit === undefined ? {} : { limit }),
            createIfMissing: { scope: "full", triggeredById: q.triggeredById },
          });
          return { success: true, ...snap };
        },
        summarize: (r) => ({
          runId: r.runId,
          status: r.status,
          step: r.progress?.step ?? null,
          calls: r.progress?.calls ?? r.report?.summary.calls ?? null,
          ok: r.report?.ok ?? null,
        }),
        status: (r) => statusFor(r, r.report !== null && !r.report.ok),
        failureMessage: "Failed to advance ledger reconciliation",
      }),

    // @cleanup-twin reconcile-occurrence-availability
    "reconcile-occurrence-availability": () =>
      cleanupRoute({
        job: "reconcile-occurrence-availability",
        run: async () => {
          const { reconcileOccurrenceAvailability } = await import(
            "@/scripts/appointments/reconcile-occurrence-availability"
          );
          return reconcileOccurrenceAvailability();
        },
        summarize: (r) => ({
          tentativeFlagsCleared: r.tentativeFlagsCleared,
          doubleBookingsDetected: r.doubleBookingsDetected,
          topUpsPlaced: r.topUps.placed,
          topUpSessionsPlaced: r.topUps.sessionsPlaced,
        }),
        status: (r) => statusFor(r, r.doubleBookingsDetected > 0),
        failureMessage: "Failed to reconcile slot availability",
      }),

    // @cleanup-twin reconcile-orphaned-confirmations
    "reconcile-orphaned-confirmations": () =>
      cleanupRoute({
        job: "reconcile-orphaned-confirmations",
        run: async (req) => {
          const { reconcileOrphanedConfirmations } = await import(
            "@/scripts/payments/reconcile-orphaned-confirmations"
          );
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

    // @cleanup-twin reconcile-payment-status
    "reconcile-payment-status": () =>
      cleanupRoute({
        job: "reconcile-payment-status",
        run: async (req) => {
          const { reconcilePaymentStatus } = await import(
            "@/scripts/payments/reconcile-payment-status"
          );
          return reconcilePaymentStatus({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          succeededCount: r.succeededCount,
          failedCount: r.failedCount,
          unresolvableCount: r.unresolvableCount,
          retiredCount: r.retiredCount,
        }),
        status: (r) =>
          statusFor(
            r,
            r.succeededCount > 0 ||
              r.unresolvableCount > 0 ||
              r.retiredCount > 0,
          ),
        failureMessage: "Failed to reconcile payment status",
      }),

    // @cleanup-twin reconcile-payout-status
    "reconcile-payout-status": () =>
      cleanupRoute({
        job: "reconcile-payout-status",
        run: async () => {
          const { reconcilePayoutStatus } = await import(
            "@/scripts/payouts/reconcile-payout-status"
          );
          return reconcilePayoutStatus();
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          completedCount: r.completedCount,
          failedCount: r.failedCount,
          discrepanciesCount: r.discrepancies.length,
        }),
        status: (r) => statusFor(r, r.discrepancies.length > 0),
        failureMessage: "Failed to reconcile payout status",
      }),

    // @cleanup-twin reconcile-refunds
    "reconcile-refunds": () =>
      cleanupRoute({
        job: "reconcile-pending-refunds",
        run: async (req) => {
          const { reconcilePendingRefunds } = await import(
            "@/scripts/refunds/reconcile-pending-refunds"
          );
          return reconcilePendingRefunds({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          totalProcessed: r.totalProcessed,
          reconciledCount: r.reconciledCount,
          failedCount: r.failedCount,
          skippedCount: r.skippedCount,
          skippedFenced: r.skippedFenced,
          failedUnknownId: r.failedUnknownId,
        }),
        status: (r) => statusFor(r, r.skippedFenced > 0),
        failureMessage: "Failed to reconcile refunds",
      }),

    // @cleanup-twin reconcile-sessions
    "reconcile-sessions": () =>
      cleanupRoute({
        job: "reconcile-orphaned-sessions",
        run: async () => {
          const { reconcileOrphanedSessions } = await import(
            "@/jobs/meetings/reconcile-orphaned-sessions"
          );
          return reconcileOrphanedSessions();
        },
        status: () => 200,
        unauthorizedMessage:
          "Please provide a valid authorization header with the CRON_SECRET",
        failureMessage: "Reconciliation job failed",
      }),

    // @cleanup-twin release-earnings
    "release-earnings": () =>
      cleanupRoute({
        job: "release-earnings",
        run: async (req) => {
          const { releaseEarningsFromHold } = await import(
            "@/scripts/earnings/release-earnings"
          );
          return releaseEarningsFromHold({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          releasedCount: r.releasedCount,
          organizationEarningsReleased: r.organizationEarningsReleased,
          errorCount: r.errorCount,
        }),
        failureMessage: "Failed to release earnings",
      }),

    // @cleanup-twin reschedule-proposals
    "reschedule-proposals": () =>
      cleanupRoute({
        job: "expire-reschedule-proposals",
        run: async () => {
          const { expireRescheduleProposals } = await import(
            "@/scripts/appointments/expire-reschedule-proposals"
          );
          return expireRescheduleProposals();
        },
        summarize: (r) => ({
          proposalsExpired: r.proposalsExpired,
          proposalsExpiredUnrestored: r.proposalsExpiredUnrestored,
        }),
        failureMessage: "Failed to expire reschedule proposals",
      }),

    // @cleanup-twin retry-auto-refunds
    "retry-auto-refunds": () =>
      cleanupRoute({
        job: "retry-auto-refunds",
        run: async (req) => {
          const { retryAutoRefunds } = await import(
            "@/scripts/payments/retry-auto-refunds"
          );
          return retryAutoRefunds({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          refunded: r.refunded,
          settled: r.settled,
          failed: r.failed,
          stuck: r.stuck,
          errors: r.errors,
        }),
        status: (r) => statusFor(r, r.stuck.length > 0),
        failureMessage: "Failed to retry auto-refunds",
      }),

    // @cleanup-twin retry-failed-emails
    "retry-failed-emails": () =>
      cleanupRoute({
        job: "retry-failed-emails",
        run: async (req) => {
          const { retryFailedEmails } = await import(
            "@/jobs/email/retry-failed-emails"
          );
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

    // @cleanup-twin retry-moderation-enforcement
    "retry-moderation-enforcement": () =>
      cleanupRoute({
        job: "retry-moderation-enforcement",
        run: async () => {
          const { retryModerationEnforcement } = await import(
            "@/scripts/cleanup/retry-moderation-enforcement"
          );
          return retryModerationEnforcement();
        },
        summarize: (r) => ({
          scanned: r.scanned,
          recovered: r.recovered,
          collaboratorRecovered: r.collaboratorRecovered,
          erasureRevocationsRecovered: r.erasureRevocationsRecovered,
          stillFailing: r.stillFailing,
          gaveUp: r.gaveUp,
        }),
        status: (r) => (r.stillFailing > 0 || r.gaveUp > 0 ? 207 : 200),
        failureMessage: "Failed to retry moderation enforcement",
      }),

    // @cleanup-twin sentry-ingest-canary
    "sentry-ingest-canary": () =>
      cleanupRoute({
        job: "sentry-ingest-canary",
        run: async () => {
          const { describeIngest, isIngestHealthy, probeSentryIngest } =
            await import("@/lib/observability/ingest-canary");
          const {
            sendSentryIngestAlert,
            canaryAlertNeeded,
            recordCanaryAlertSent,
          } = await import("@/lib/observability/ingest-alert");
          const { checkSentryQuota } = await import(
            "@/lib/observability/quota-alert"
          );
          const probe = await probeSentryIngest();
          const healthy = isIngestHealthy(probe);
          // #1933 — 70% quota warning rides the canary; never throws.
          const quota = await checkSentryQuota();

          if (!healthy) {
            const needed = await canaryAlertNeeded(probe.verdict);
            const alerted = needed
              ? await sendSentryIngestAlert(probe).catch((err: unknown) => {
                  console.error(
                    "[sentry-ingest-canary] alert could not be sent:",
                    err instanceof Error ? err.message : String(err),
                  );
                  return false;
                })
              : false;
            if (alerted) await recordCanaryAlertSent(probe.verdict);
            return {
              healthy,
              verdict: probe.verdict,
              status: probe.status,
              eventId: probe.eventId,
              alerted,
              alertSuppressed: !needed,
              detail: describeIngest(probe),
              quota,
            };
          }

          return {
            healthy: true,
            verdict: probe.verdict,
            status: probe.status,
            eventId: probe.eventId,
            alerted: false,
            quota,
          };
        },
        status: (result) => (result.healthy ? 200 : 503),
        failureMessage:
          "The Sentry ingest canary route failed to run. This is a fault in the canary, not a verdict about Sentry — check the log line above.",
      }),

    // @cleanup-twin settle-cancelled-sessions
    "settle-cancelled-sessions": () =>
      cleanupRoute({
        job: "settle-cancelled-sessions",
        run: async (req) => {
          const { settleCancelledSessions } = await import(
            "@/scripts/appointments/settle-cancelled-sessions"
          );
          return settleCancelledSessions({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({
          scanned: r.scanned,
          stamped: r.stamped,
          refunded: r.refunded,
          errors: r.errors,
        }),
        failureMessage: "Failed to settle cancelled class sessions",
      }),

    // @cleanup-twin settle-invoice-accruals
    "settle-invoice-accruals": () =>
      cleanupRoute({
        job: "settle-invoice-accruals",
        run: async () => {
          const { runSettleInvoiceAccruals } = await import(
            "@/jobs/billing/settle-invoice-accruals"
          );
          return runSettleInvoiceAccruals();
        },
        summarize: (r) => ({
          orgsProcessed: r.orgsProcessed,
          invoicesCreated: r.invoicesCreated,
        }),
        status: () => 200,
        failureMessage: "Failed to settle invoice accruals",
      }),

    // @cleanup-twin stream-sync
    "stream-sync": () =>
      cleanupRoute({
        job: "stream-sync",
        run: async (req) => {
          const { performStreamUserSync } = await import(
            "@/scripts/stream/stream-sync"
          );
          const dryRun = req.nextUrl.searchParams.get("dry-run") === "true";
          if (dryRun) {
            console.log("Stream user sync: DRY RUN");
          }
          return performStreamUserSync({ dryRun });
        },
        summarize: (r) => ({
          usersProcessed: r.totalStreamUsersProcessed,
          staleIdentified: r.totalStaleUsersIdentified,
          usersDeleted: r.totalStaleUsersDeleted,
          failedDeletions: r.totalFailedDeletions,
        }),
        failureMessage: "Failed to sync Stream users",
      }),

    // @cleanup-twin sweep-abandoned-overage-charges
    "sweep-abandoned-overage-charges": () =>
      cleanupRoute({
        job: "sweep-abandoned-overage-charges",
        run: async (req) => {
          const { sweepAbandonedOverageCharges } = await import(
            "@/scripts/cleanup/sweep-abandoned-overage-charges"
          );
          return sweepAbandonedOverageCharges({ limit: parseLimitParam(req) });
        },
        summarize: (r) => ({ scanned: r.scanned, failed: r.failed }),
        failureMessage: "Failed to sweep abandoned overage charges",
      }),

    // @cleanup-twin sweep-orphaned-topup-captures
    "sweep-orphaned-topup-captures": () =>
      cleanupRoute({
        job: "sweep-orphaned-topup-captures",
        run: async (req) => {
          const { sweepOrphanedTopupCaptures } = await import(
            "@/scripts/cleanup/sweep-orphaned-topup-captures"
          );
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

    // @cleanup-twin sweep-stuck-webhook-events
    "sweep-stuck-webhook-events": () =>
      cleanupRoute({
        job: "sweep-stuck-webhook-events",
        run: async (req) => {
          const { sweepStuckWebhookEvents } = await import(
            "@/scripts/cleanup/sweep-stuck-webhook-events"
          );
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

    // @cleanup-twin sweep-verification
    "sweep-verification": () =>
      cleanupRoute({
        job: "sweep-verification",
        run: async () => {
          const { sweepVerification } = await import(
            "@/scripts/cleanup/sweep-verification"
          );
          return sweepVerification();
        },
        summarize: (r) => ({
          unlinkedDeleted: r.unlinkedDeleted,
          remindersSent: r.remindersSent,
          staleClosed: r.staleClosed,
          errors: r.errors.length,
        }),
        status: (r) => statusFor(r, r.errors.length > 0),
        failureMessage: "Failed to sweep verification",
      }),

    // @cleanup-twin sync-payment-earnings
    "sync-payment-earnings": () =>
      cleanupRoute({
        job: "sync-payment-earnings",
        run: async (req) => {
          const { syncPaymentEarnings } = await import(
            "@/scripts/earnings/sync-payment-earnings"
          );
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

    // @cleanup-twin tds-return-draft
    "tds-return-draft": () =>
      cleanupRoute({
        job: "tds-26q-draft-export",
        run: async () => {
          const { runTdsReturnDraftExport } = await import(
            "@/jobs/compliance/tds-26q-draft-export"
          );
          return runTdsReturnDraftExport();
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
        failureMessage: "Failed to export the TDS return draft",
      }),

    // @cleanup-twin tentative-occurrences
    "tentative-occurrences": () =>
      cleanupRoute({
        job: "cleanup-tentative-occurrences",
        run: async () => {
          const { cleanupTentativeOccurrences } = await import(
            "@/scripts/appointments/cleanup-tentative-occurrences"
          );
          return cleanupTentativeOccurrences();
        },
        summarize: (r) => ({
          slotsReleased: r.slotsReleased,
          appointmentsAffected: r.appointmentsAffected,
        }),
        failureMessage: "Failed to cleanup tentative slots",
      }),

    // @cleanup-twin transfer-expiring-recordings
    "transfer-expiring-recordings": () =>
      cleanupRoute({
        job: "transfer-expiring-recordings",
        run: async () => {
          const { RecordingTransferService } = await import(
            "@/lib/stream/recording-transfer-service"
          );
          const { streamLogger } = await import("@/lib/stream-logger");
          const { withCronLock } = await import("@/lib/cron/with-cron-lock");
          const { transferResult, expiringStreamOnly } = await withCronLock(
            "transfer-expiring-recordings",
            { failMode: "open" },
            async () => {
              const transferResult =
                await RecordingTransferService.processExpiringRecordings(
                  14,
                  10,
                  "PERMANENT",
                );
              const expiringStreamOnly =
                await RecordingTransferService.getExpiringStreamOnlyRecordings(
                  3,
                );
              if (expiringStreamOnly.length > 0) {
                streamLogger.info("STREAM_ONLY recordings expiring soon", {
                  count: expiringStreamOnly.length,
                });
                await notifyConsultantsOfExpiringRecordings(expiringStreamOnly);
              }
              return { transferResult, expiringStreamOnly };
            },
          );
          return {
            success: true,
            transferred: transferResult.succeeded,
            failed: transferResult.failed,
            expiringStreamOnly: expiringStreamOnly.length,
            errors: transferResult.errors,
          };
        },
        summarize: (r) => ({
          transferred: r.transferred,
          failed: r.failed,
          expiringStreamOnly: r.expiringStreamOnly,
        }),
        status: () => 200,
        failureMessage: "Cron job failed",
      }),
  };

const handlerCache = new Map<string, CleanupRouteHandlers>();

export function getCleanupJobHandlers(
  slug: string,
): CleanupRouteHandlers | null {
  const cached = handlerCache.get(slug);
  if (cached) return cached;
  const builder = CLEANUP_JOB_BUILDERS[slug];
  if (!builder) return null;
  const built = builder();
  handlerCache.set(slug, built);
  return built;
}
