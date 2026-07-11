/**
 * Moderation action side-effects (#693) — two-phase execution.
 *
 * Phase 1 (applyTransactionalEffects) runs inside the action route's
 * interactive transaction: user ban flags, session revocation, earnings hold,
 * profile unverification, review soft-delete. All-or-nothing with the
 * ModerationAction row, so a report can never read ACTION_TAKEN while the
 * target's account state didn't move.
 *
 * Phase 2 (applyBestEffortEffects) runs after commit: bulk cancel + refunds
 * (refundPayment owns its own Serializable tx), Stream revocation, Novu.
 * Each step is individually try/caught — one failure never blocks the next —
 * and the outcome lands in ModerationAction.sideEffects for staff visibility.
 */
import * as Sentry from "@sentry/nextjs";
import type { ModerationActionType, Prisma } from "@prisma/client";
import { EarningStatus } from "@prisma/client";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";
import {
  notifyModerationWarning,
  notifyAccountSuspended,
  notifyAccountBanned,
  notifyVerificationStatusChanged,
} from "@/lib/novu";
import {
  cancelFutureEngagementsForUser,
  type BulkCancelSummary,
} from "./cancel-user-engagements";

export interface ModerationSideEffectInput {
  actionType: ModerationActionType;
  report: { id: string; targetUserId: string; reviewId: string | null };
  staffUserId: string;
  notes?: string;
  /** Required for USER_SUSPENDED. */
  suspensionDays?: number;
}

export interface TransactionalEffectResult {
  sessionsRevoked?: number;
  earningsHeld?: number;
  profilesUnverified?: number;
  reviewRemoved?: boolean;
  banExpires?: string | null;
}

type StepStatus = "ok" | "failed" | "skipped";

export interface SideEffectSummary extends TransactionalEffectResult {
  cancellations?: BulkCancelSummary;
  stream?: StepStatus;
  notification?: StepStatus;
  errors?: string[];
}

const HOLDABLE: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.READY,
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function applyTransactionalEffects(
  tx: Prisma.TransactionClient,
  input: ModerationSideEffectInput,
): Promise<TransactionalEffectResult> {
  const { actionType, report, notes, suspensionDays } = input;
  const result: TransactionalEffectResult = {};

  switch (actionType) {
    case "USER_SUSPENDED":
    case "USER_BANNED": {
      const banExpires =
        actionType === "USER_SUSPENDED"
          ? new Date(Date.now() + (suspensionDays ?? 7) * 86_400_000)
          : null;
      await tx.user.update({
        where: { id: report.targetUserId },
        data: {
          banned: true,
          banReason: notes ?? `moderation: ${actionType}`,
          banExpires,
        },
      });
      result.banExpires = banExpires ? banExpires.toISOString() : null;

      const revoked = await tx.session.deleteMany({
        where: { userId: report.targetUserId },
      });
      result.sessionsRevoked = revoked.count;

      if (actionType === "USER_BANNED") {
        // Hold the banned consultant's unpaid earnings for admin disposition;
        // HELD is skipped by the release-earnings cron. PAID/REFUNDED rows are
        // untouchable by doctrine — the guard below enforces it per row.
        const target = await tx.user.findUnique({
          where: { id: report.targetUserId },
          select: { consultantProfileId: true },
        });
        if (target?.consultantProfileId) {
          const holdable = await tx.consultantEarnings.findMany({
            where: {
              consultantProfileId: target.consultantProfileId,
              status: { in: HOLDABLE },
            },
            select: { id: true, status: true },
          });
          for (const row of holdable) {
            assertEarningStatusTransitionLegal(
              row.id,
              row.status,
              EarningStatus.HELD,
            );
          }
          const held = await tx.consultantEarnings.updateMany({
            where: {
              id: { in: holdable.map((r) => r.id) },
              status: { in: HOLDABLE },
            },
            data: { status: EarningStatus.HELD },
          });
          result.earningsHeld = held.count;
        }
      }
      break;
    }

    case "PROFILE_UNVERIFIED": {
      // Both fields: explore + the booking gate filter on verificationStatus,
      // while isVerified is the projected display flag.
      const updated = await tx.consultantProfile.updateMany({
        where: { userId: report.targetUserId },
        data: { isVerified: false, verificationStatus: "REJECTED" },
      });
      result.profilesUnverified = updated.count;
      break;
    }

    case "CONTENT_REMOVED": {
      if (!report.reviewId) break;
      const review = await tx.consultantReview.findUnique({
        where: { id: report.reviewId },
        select: { consultantProfileId: true, deletedAt: true },
      });
      if (!review || review.deletedAt) break;
      await tx.consultantReview.update({
        where: { id: report.reviewId },
        data: { deletedAt: new Date() },
      });
      const remaining = await tx.consultantReview.aggregate({
        where: {
          consultantProfileId: review.consultantProfileId,
          deletedAt: null,
        },
        _avg: { rating: true },
      });
      await tx.consultantProfile.update({
        where: { id: review.consultantProfileId },
        data: { rating: remaining._avg.rating || 0 },
      });
      result.reviewRemoved = true;
      break;
    }

    case "WARNING_ISSUED":
    case "NO_ACTION":
      break;
  }

  return result;
}

export async function applyBestEffortEffects(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
): Promise<SideEffectSummary> {
  const { actionType, report, staffUserId, notes } = input;
  const summary: SideEffectSummary = { ...transactional };
  const errors: string[] = [];

  if (actionType === "USER_SUSPENDED" || actionType === "USER_BANNED") {
    try {
      summary.cancellations = await cancelFutureEngagementsForUser(
        report.targetUserId,
        { initiatedByUserId: staffUserId, notes },
      );
    } catch (error) {
      errors.push(`cancellations: ${errMsg(error)}`);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }

    try {
      // revokeUserToken expires every previously-issued Stream token; the
      // token provider re-mints only for non-banned users, so suspension
      // self-heals after banExpires without an un-revoke.
      await withStreamCircuitBreaker(async () => {
        const chat = getStreamChatClient();
        await chat.revokeUserToken(report.targetUserId, new Date());
        if (actionType === "USER_BANNED") {
          // Deactivated users cannot connect at all; history is preserved.
          await chat.deactivateUser(report.targetUserId, {
            mark_messages_deleted: false,
          });
        }
      });
      summary.stream = "ok";
    } catch (error) {
      summary.stream = "failed";
      errors.push(`stream: ${errMsg(error)}`);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }
  }

  try {
    switch (actionType) {
      case "WARNING_ISSUED":
      case "CONTENT_REMOVED":
        await notifyModerationWarning(report.targetUserId, {
          reason: notes,
        });
        summary.notification = "ok";
        break;
      case "USER_SUSPENDED":
        await notifyAccountSuspended(report.targetUserId, {
          reason: notes,
          suspendedUntil: transactional.banExpires ?? "",
          appointmentsCancelled: summary.cancellations?.engagementsCancelled,
        });
        summary.notification = "ok";
        break;
      case "USER_BANNED":
        await notifyAccountBanned(report.targetUserId, {
          reason: notes,
          appointmentsCancelled: summary.cancellations?.engagementsCancelled,
        });
        summary.notification = "ok";
        break;
      case "PROFILE_UNVERIFIED":
        await notifyVerificationStatusChanged(report.targetUserId, {
          status: "REJECTED",
          reason: notes,
          dashboardUrl: "/dashboard",
        });
        summary.notification = "ok";
        break;
      case "NO_ACTION":
        summary.notification = "skipped";
        break;
    }
  } catch (error) {
    summary.notification = "failed";
    errors.push(`notification: ${errMsg(error)}`);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "moderation" } },
    );
  }

  if (errors.length > 0) summary.errors = errors;
  return summary;
}
