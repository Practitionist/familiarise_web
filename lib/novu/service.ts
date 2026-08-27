/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 * Pattern follows lib/email.ts (graceful degradation).
 */
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { getNovuClient, isNovuConfigured } from "./client";
import {
  NOVU_WORKFLOWS,
  type AppointmentPayload,
  type AppointmentCancelledPayload,
  type AppointmentRescheduledPayload,
  type PaymentSuccessPayload,
  type PaymentFailedPayload,
  type RefundPayload,
  type SupportTicketPayload,
  type FeedbackPayload,
  type ReviewPayload,
  type TrialSessionPayload,
  type SubscriptionPayload,
  type BookingRequestPayload,
  type VerificationPayload,
  type ModerationWarningPayload,
  type AccountSuspendedPayload,
  type AccountBannedPayload,
  type PayoutPayload,
  type AnnouncementPayload,
  type DisputePayload,
  type RecordingPayload,
  type RecordingFailedPayload,
  type RecordingExpiringPayload,
  type DocumentUploadedPayload,
  type DocumentReviewedPayload,
  type ConsultantApplicationPayload,
  type ReferralBonusPayload,
  type RefereeWelcomeBonusPayload,
  type ReferralCreditsAppliedPayload,
  type CollaboratorInvitedPayload,
  type CollaboratorAcceptedPayload,
  type CollaboratorRemovedPayload,
  type MaintenancePayload,
  type OrgExpertRemovedPayload,
} from "./workflows";

// ============================================================================
// Core trigger function
// ============================================================================

/** Payload base type — all workflow payloads extend this. */
type NovuPayload = Record<string, string | number | boolean | null | undefined>;

interface TriggerResult {
  success: boolean;
  error?: Error | string;
}

// Unconfigured Novu in a deployed env means notifications silently vanish —
// a console.warn nobody reads is not enough. Local dev stays console-only.
function reportNotConfigured(workflowId: string): void {
  console.warn(`[Novu] Not configured. Skipped workflow: ${workflowId}`);
  if (process.env.NODE_ENV === "production") {
    Sentry.captureMessage(`[Novu] Not configured — dropped ${workflowId}`, {
      level: "warning",
      tags: { subsystem: "novu" },
    });
  }
}

// Deterministic transactionId so app-level retries can't double-notify: Novu
// rejects a repeated transactionId. Derived from recipient(s) + workflow +
// canonical payload (the payloads carry the entity ids). `dedupeKey` lets a
// caller that legitimately re-sends an identical payload (e.g. 24h vs 1h
// appointment reminders) disambiguate the sends.
function deriveTransactionId(
  workflowId: string,
  recipients: string | string[],
  payload: NovuPayload,
  dedupeKey?: string,
): string {
  const canonicalPayload = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const recipientKey = Array.isArray(recipients)
    ? recipients.toSorted((a, b) => a.localeCompare(b)).join(",")
    : recipients;
  const hash = createHash("sha256")
    .update(`${workflowId}|${recipientKey}|${dedupeKey ?? canonicalPayload}`)
    .digest("hex");
  return `${workflowId}:${hash.slice(0, 32)}`;
}

async function triggerWorkflow<T extends NovuPayload>(
  workflowId: string,
  subscriberId: string,
  payload: T,
  dedupeKey?: string,
): Promise<TriggerResult> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return { success: false, error: "Novu not configured" };
  }

  try {
    const novu = getNovuClient();
    await novu.trigger({
      workflowId,
      to: subscriberId,
      payload,
      transactionId: deriveTransactionId(
        workflowId,
        subscriberId,
        payload,
        dedupeKey,
      ),
    });
    console.log(`[Novu] Triggered ${workflowId} for ${subscriberId}`);
    return { success: true };
  } catch (error) {
    console.error(`[Novu] Failed to trigger ${workflowId}:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "novu" }, level: "warning" },
    );
    return {
      success: false,
      error: error instanceof Error ? error : String(error),
    };
  }
}

/**
 * Helper to trigger the same workflow for multiple users (e.g. both parties).
 * Uses a single API call with array `to` field (max 100 per call).
 */
async function triggerForMultiple<T extends NovuPayload>(
  workflowId: string,
  userIds: string[],
  payload: T,
  dedupeKey?: string,
): Promise<TriggerResult[]> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return userIds.map(() => ({
      success: false,
      error: "Novu not configured" as const,
    }));
  }

  if (userIds.length === 0) return [];
  if (userIds.length === 1)
    return [await triggerWorkflow(workflowId, userIds[0], payload, dedupeKey)];

  const BATCH_SIZE = 100;
  const results: TriggerResult[] = [];

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    try {
      const novu = getNovuClient();
      await novu.trigger({
        workflowId,
        to: batch,
        payload,
        transactionId: deriveTransactionId(
          workflowId,
          batch,
          payload,
          dedupeKey,
        ),
      });
      console.log(
        `[Novu] Triggered ${workflowId} for ${batch.length} subscribers`,
      );
      results.push(...batch.map(() => ({ success: true }) as TriggerResult));
    } catch (error) {
      console.error(`[Novu] Failed to trigger ${workflowId} for batch:`, error);
      const err: TriggerResult = {
        success: false,
        error: error instanceof Error ? error : String(error),
      };
      results.push(...batch.map(() => err));
    }
  }

  return results;
}

/**
 * Trigger a broadcast workflow to all existing subscribers.
 * Uses Novu's triggerBroadcast API — no need to fetch user IDs.
 */
async function triggerBroadcastWorkflow<T extends NovuPayload>(
  workflowId: string,
  payload: T,
): Promise<TriggerResult> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return { success: false, error: "Novu not configured" };
  }

  try {
    const novu = getNovuClient();
    await novu.triggerBroadcast({
      name: workflowId,
      payload,
    });
    console.log(`[Novu] Broadcast triggered: ${workflowId}`);
    return { success: true };
  } catch (error) {
    console.error(`[Novu] Failed to broadcast ${workflowId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error : String(error),
    };
  }
}

// ============================================================================
// Appointment Notifications
// ============================================================================

export async function notifyAppointmentBooked(
  userIds: string[],
  payload: AppointmentPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_BOOKED,
    userIds,
    payload,
  );
}

export async function notifyAppointmentCancelled(
  userIds: string[],
  payload: AppointmentCancelledPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
    userIds,
    payload,
  );
}

export async function notifyAppointmentRescheduled(
  userIds: string[],
  payload: AppointmentRescheduledPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED,
    userIds,
    payload,
  );
}

export async function notifyAppointmentCompleted(
  userIds: string[],
  payload: AppointmentPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_COMPLETED,
    userIds,
    payload,
  );
}

// `dedupeKey` (appointment + window) keeps the 1h reminder from being
// swallowed as a duplicate of the 24h one — their payloads are identical.
export async function notifyAppointmentReminder(
  userIds: string[],
  payload: AppointmentPayload,
  dedupeKey?: string,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_REMINDER,
    userIds,
    payload,
    dedupeKey,
  );
}

// ============================================================================
// Payment Notifications
// ============================================================================

export async function notifyPaymentSuccess(
  userId: string,
  payload: PaymentSuccessPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.PAYMENT_SUCCESS, userId, payload);
}

export async function notifyPaymentFailed(
  userId: string,
  payload: PaymentFailedPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.PAYMENT_FAILED, userId, payload);
}

export async function notifyRefundProcessed(
  userId: string,
  payload: RefundPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.REFUND_PROCESSED, userId, payload);
}

// #779 §A — the gateway rejected a refund (Refund.status = FAILED). Notifies
// the payer; `reason` on the payload carries the gateway failure reason.
export async function notifyRefundFailed(
  userId: string,
  payload: RefundPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.REFUND_FAILED, userId, payload);
}

export async function notifyRefundRequested(
  adminUserIds: string[],
  payload: RefundPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.REFUND_REQUESTED,
    adminUserIds,
    payload,
  );
}

// ============================================================================
// Support Ticket Notifications
// ============================================================================

export async function notifySupportTicketCreated(
  staffUserIds: string[],
  payload: SupportTicketPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUPPORT_TICKET_CREATED,
    staffUserIds,
    payload,
  );
}

export async function notifySupportTicketUpdate(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE, userId, payload);
}

export async function notifySupportTicketResponse(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUPPORT_TICKET_RESPONSE,
    userId,
    payload,
  );
}

// ============================================================================
// Feedback & Review Notifications
// ============================================================================

export async function notifyFeedbackReceived(
  adminUserIds: string[],
  payload: FeedbackPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.FEEDBACK_RECEIVED,
    adminUserIds,
    payload,
  );
}

export async function notifyNewReview(
  consultantUserId: string,
  payload: ReviewPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.NEW_REVIEW_RECEIVED,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Trial Session Notifications
// ============================================================================

export async function notifyTrialSessionRequested(
  consultantUserId: string,
  payload: TrialSessionPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.TRIAL_SESSION_REQUESTED,
    consultantUserId,
    payload,
  );
}

export async function notifyTrialSessionScheduled(
  consulteeUserId: string,
  payload: TrialSessionPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.TRIAL_SESSION_SCHEDULED,
    consulteeUserId,
    payload,
  );
}

export async function notifyTrialSessionCompleted(
  userIds: string[],
  payload: TrialSessionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.TRIAL_SESSION_COMPLETED,
    userIds,
    payload,
  );
}

export async function notifyTrialSessionCancelled(
  userIds: string[],
  payload: TrialSessionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.TRIAL_SESSION_CANCELLED,
    userIds,
    payload,
  );
}

// ============================================================================
// Subscription Notifications
// ============================================================================

export async function notifySubscriptionStarted(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUBSCRIPTION_STARTED, userId, payload);
}

export async function notifySubscriptionCancelled(
  userIds: string[],
  payload: SubscriptionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUBSCRIPTION_CANCELLED,
    userIds,
    payload,
  );
}

export async function notifySubscriptionRenewed(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUBSCRIPTION_RENEWED, userId, payload);
}

// ============================================================================
// Consultant-Specific Notifications
// ============================================================================

export async function notifyNewBookingRequest(
  consultantUserId: string,
  payload: BookingRequestPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
    consultantUserId,
    payload,
  );
}

export async function notifyVerificationStatusChanged(
  consultantUserId: string,
  payload: VerificationPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.VERIFICATION_STATUS_CHANGED,
    consultantUserId,
    payload,
  );
}

// Moderation (#693) — fire-and-forget; callers run these in the best-effort
// phase, never inside the moderation transaction.
export async function notifyModerationWarning(
  targetUserId: string,
  payload: ModerationWarningPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.MODERATION_WARNING,
    targetUserId,
    payload,
  );
}

export async function notifyAccountSuspended(
  targetUserId: string,
  payload: AccountSuspendedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.ACCOUNT_SUSPENDED,
    targetUserId,
    payload,
  );
}

export async function notifyAccountBanned(
  targetUserId: string,
  payload: AccountBannedPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.ACCOUNT_BANNED, targetUserId, payload);
}

export async function notifyPayoutProcessed(
  consultantUserId: string,
  payload: PayoutPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYOUT_PROCESSED,
    consultantUserId,
    payload,
  );
}

/**
 * A7: notify a consultant that their EXPERT membership at an organization
 * was soft-deleted. Fire-and-forget — a Novu outage must not block the
 * member-DELETE API response. Caller is expected to wrap in try/catch.
 */
export async function notifyOrgExpertRemoved(
  consultantUserId: string,
  payload: OrgExpertRemovedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.ORG_EXPERT_REMOVED,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Admin / System Notifications
// ============================================================================

export async function notifyGeneralAnnouncement(payload: AnnouncementPayload) {
  return triggerBroadcastWorkflow(NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT, payload);
}

export async function notifyNewConsultantApplication(
  adminUserIds: string[],
  payload: ConsultantApplicationPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.NEW_CONSULTANT_APPLICATION,
    adminUserIds,
    payload,
  );
}

// ============================================================================
// Dispute Notifications
// ============================================================================

export async function notifyDisputeCreated(
  userIds: string[],
  payload: DisputePayload,
) {
  return triggerForMultiple(NOVU_WORKFLOWS.DISPUTE_CREATED, userIds, payload);
}

export async function notifyDisputeResolved(
  userIds: string[],
  payload: DisputePayload,
) {
  return triggerForMultiple(NOVU_WORKFLOWS.DISPUTE_RESOLVED, userIds, payload);
}

// ============================================================================
// Recording Notifications
// ============================================================================

export async function notifyRecordingAvailable(
  userIds: string[],
  payload: RecordingPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.RECORDING_AVAILABLE,
    userIds,
    payload,
  );
}

export async function notifyRecordingFailed(
  subscriberId: string,
  payload: RecordingFailedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.RECORDING_FAILED,
    subscriberId,
    payload,
  );
}

// STR-3 — warn a consultant their STREAM_ONLY recording(s) expire soon.
export async function notifyRecordingExpiring(
  consultantUserId: string,
  payload: RecordingExpiringPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.RECORDING_EXPIRING,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Document Review Notifications
// ============================================================================

/** A document (or revision/response) landed on an appointment. */
export async function notifyDocumentUploaded(
  subscriberId: string,
  payload: DocumentUploadedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.DOCUMENT_UPLOADED,
    subscriberId,
    payload,
  );
}

/** A consultant set a review decision on a submitted document. */
export async function notifyDocumentReviewed(
  subscriberId: string,
  payload: DocumentReviewedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.DOCUMENT_REVIEWED,
    subscriberId,
    payload,
  );
}

// ============================================================================
// Referral Notifications
// ============================================================================

export async function notifyReferralBonusEarned(
  referrerUserId: string,
  payload: ReferralBonusPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFERRAL_BONUS_EARNED,
    referrerUserId,
    payload,
  );
}

export async function notifyRefereeWelcomeBonus(
  refereeUserId: string,
  payload: RefereeWelcomeBonusPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFEREE_WELCOME_BONUS,
    refereeUserId,
    payload,
  );
}

export async function notifyReferralCreditsApplied(
  userId: string,
  payload: ReferralCreditsAppliedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFERRAL_CREDITS_APPLIED,
    userId,
    payload,
  );
}

// ============================================================================
// Collaborator Notifications
// ============================================================================

export async function notifyCollaboratorInvited(
  consultantUserId: string,
  payload: CollaboratorInvitedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_INVITED,
    consultantUserId,
    payload,
  );
}

export async function notifyCollaboratorAccepted(
  ownerUserId: string,
  payload: CollaboratorAcceptedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_ACCEPTED,
    ownerUserId,
    payload,
  );
}

export async function notifyCollaboratorRemoved(
  consultantUserId: string,
  payload: CollaboratorRemovedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_REMOVED,
    consultantUserId,
    payload,
  );
}

// Maintenance notifications (broadcast to all users)

export async function notifyMaintenanceScheduled(payload: MaintenancePayload) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_SCHEDULED,
    payload,
  );
}

export async function notifyMaintenanceStarted(payload: MaintenancePayload) {
  return triggerBroadcastWorkflow(NOVU_WORKFLOWS.MAINTENANCE_STARTED, payload);
}

export async function notifyMaintenanceEnded(payload: MaintenancePayload) {
  return triggerBroadcastWorkflow(NOVU_WORKFLOWS.MAINTENANCE_ENDED, payload);
}
