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
  type ConsultantApplicationPayload,
} from "./workflows";

// ============================================================================
// Core trigger function
// ============================================================================

interface TriggerResult {
  success: boolean;
  error?: unknown;
}

async function triggerWorkflow(
  workflowId: string,
  subscriberId: string,
  payload: Record<string, unknown>,
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
    return { success: false, error };
  }
}

/**
 * Helper to trigger the same workflow for multiple users (e.g. both parties).
 */
async function triggerForMultiple(
  workflowId: string,
  userIds: string[],
  payload: Record<string, unknown>,
): Promise<TriggerResult[]> {
  const results = await Promise.allSettled(
    userIds.map((id) => triggerWorkflow(workflowId, id, payload)),
  );
  return results.map((r) =>
    r.status === "fulfilled" ? r.value : { success: false, error: r.reason },
  );
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
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyAppointmentCancelled(
  userIds: string[],
  payload: AppointmentCancelledPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyAppointmentRescheduled(
  userIds: string[],
  payload: AppointmentRescheduledPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyAppointmentCompleted(
  userIds: string[],
  payload: AppointmentPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.APPOINTMENT_COMPLETED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

// ============================================================================
// Payment Notifications
// ============================================================================

export async function notifyPaymentSuccess(
  userId: string,
  payload: PaymentSuccessPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYMENT_SUCCESS,
    userId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyPaymentFailed(
  userId: string,
  payload: PaymentFailedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYMENT_FAILED,
    userId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyRefundProcessed(
  userId: string,
  payload: RefundPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFUND_PROCESSED,
    userId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyRefundRequested(
  adminUserIds: string[],
  payload: RefundPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.REFUND_REQUESTED,
    adminUserIds,
    payload as unknown as Record<string, unknown>,
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
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifySupportTicketUpdate(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    userId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifySupportTicketResponse(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUPPORT_TICKET_RESPONSE,
    userId,
    payload as unknown as Record<string, unknown>,
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
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyNewReview(
  consultantUserId: string,
  payload: ReviewPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.NEW_REVIEW_RECEIVED,
    consultantUserId,
    payload as unknown as Record<string, unknown>,
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
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyTrialSessionScheduled(
  consulteeUserId: string,
  payload: TrialSessionPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.TRIAL_SESSION_SCHEDULED,
    consulteeUserId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyTrialSessionCompleted(
  userIds: string[],
  payload: TrialSessionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.TRIAL_SESSION_COMPLETED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyTrialSessionCancelled(
  userIds: string[],
  payload: TrialSessionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.TRIAL_SESSION_CANCELLED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

// ============================================================================
// Subscription Notifications
// ============================================================================

export async function notifySubscriptionStarted(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUBSCRIPTION_STARTED,
    userId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifySubscriptionCancelled(
  userIds: string[],
  payload: SubscriptionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUBSCRIPTION_CANCELLED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifySubscriptionRenewed(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUBSCRIPTION_RENEWED,
    userId,
    payload as unknown as Record<string, unknown>,
  );
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
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyVerificationStatusChanged(
  consultantUserId: string,
  payload: VerificationPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.VERIFICATION_STATUS_CHANGED,
    consultantUserId,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyPayoutProcessed(
  consultantUserId: string,
  payload: PayoutPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYOUT_PROCESSED,
    consultantUserId,
    payload as unknown as Record<string, unknown>,
  );
}

// ============================================================================
// Admin / System Notifications
// ============================================================================

export async function notifyGeneralAnnouncement(
  userIds: string[],
  payload: AnnouncementPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyNewConsultantApplication(
  adminUserIds: string[],
  payload: ConsultantApplicationPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.NEW_CONSULTANT_APPLICATION,
    adminUserIds,
    payload as unknown as Record<string, unknown>,
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
    payload as unknown as Record<string, unknown>,
  );
}

// ============================================================================
// Dispute Notifications
// ============================================================================

export async function notifyDisputeCreated(
  userIds: string[],
  payload: DisputePayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.DISPUTE_CREATED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
}

export async function notifyDisputeResolved(
  userIds: string[],
  payload: DisputePayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.DISPUTE_RESOLVED,
    userIds,
    payload as unknown as Record<string, unknown>,
  );
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
    payload as unknown as Record<string, unknown>,
  );
}
