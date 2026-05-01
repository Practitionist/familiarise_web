/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 * Pattern follows lib/email.ts (graceful degradation).
 */
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
  type PayoutPayload,
  type AnnouncementPayload,
  type WaitlistPayload,
  type DisputePayload,
  type RecordingPayload,
  type RecordingFailedPayload,
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

async function triggerWorkflow<T extends NovuPayload>(
  workflowId: string,
  subscriberId: string,
  payload: T,
): Promise<TriggerResult> {
  if (!isNovuConfigured()) {
    console.warn(`[Novu] Not configured. Skipped workflow: ${workflowId}`);
    return { success: false, error: "Novu not configured" };
  }

  try {
    const novu = getNovuClient();
    await novu.trigger({
      workflowId,
      to: subscriberId,
      payload,
    });
    console.log(`[Novu] Triggered ${workflowId} for ${subscriberId}`);
    return { success: true };
  } catch (error) {
    console.error(`[Novu] Failed to trigger ${workflowId}:`, error);
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
): Promise<TriggerResult[]> {
  if (!isNovuConfigured()) {
    console.warn(`[Novu] Not configured. Skipped workflow: ${workflowId}`);
    return userIds.map(() => ({
      success: false,
      error: "Novu not configured" as const,
    }));
  }

  if (userIds.length === 0) return [];
  if (userIds.length === 1)
    return [await triggerWorkflow(workflowId, userIds[0], payload)];

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
    console.warn(`[Novu] Not configured. Skipped broadcast: ${workflowId}`);
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

export async function notifyAppointmentReminder(
  userIds: string[],
  payload: AppointmentPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_REMINDER,
    userIds,
    payload,
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
// Waitlist Notifications
// ============================================================================

export async function notifyWaitlistSpotAvailable(
  userId: string,
  payload: WaitlistPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.WAITLIST_SPOT_AVAILABLE,
    userId,
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
