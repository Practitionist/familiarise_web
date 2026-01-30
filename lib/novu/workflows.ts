/**
 * Novu Workflow Definitions
 * All workflow IDs must match their counterparts in the Novu dashboard.
 * Each workflow includes typed payload interfaces.
 */

// ============================================================================
// Workflow ID Constants
// ============================================================================

export const NOVU_WORKFLOWS = {
  // Appointment lifecycle
  APPOINTMENT_BOOKED: "appointment-booked",
  APPOINTMENT_CANCELLED: "appointment-cancelled",
  APPOINTMENT_RESCHEDULED: "appointment-rescheduled",
  APPOINTMENT_REMINDER: "appointment-reminder",
  APPOINTMENT_COMPLETED: "appointment-completed",

  // Payment events
  PAYMENT_SUCCESS: "payment-success",
  PAYMENT_FAILED: "payment-failed",
  REFUND_PROCESSED: "refund-processed",
  REFUND_REQUESTED: "refund-requested",

  // Support
  SUPPORT_TICKET_CREATED: "support-ticket-created",
  SUPPORT_TICKET_UPDATE: "support-ticket-update",
  SUPPORT_TICKET_RESPONSE: "support-ticket-response",

  // Feedback & Reviews
  FEEDBACK_RECEIVED: "feedback-received",
  NEW_REVIEW_RECEIVED: "new-review-received",

  // Trials
  TRIAL_SESSION_REQUESTED: "trial-session-requested",
  TRIAL_SESSION_SCHEDULED: "trial-session-scheduled",
  TRIAL_SESSION_COMPLETED: "trial-session-completed",
  TRIAL_SESSION_CANCELLED: "trial-session-cancelled",

  // Subscriptions
  SUBSCRIPTION_STARTED: "subscription-started",
  SUBSCRIPTION_CANCELLED: "subscription-cancelled",
  SUBSCRIPTION_RENEWED: "subscription-renewed",

  // Consultant-specific
  NEW_BOOKING_REQUEST: "new-booking-request",
  VERIFICATION_STATUS_CHANGED: "verification-status-changed",
  PAYOUT_PROCESSED: "payout-processed",

  // Admin / System
  GENERAL_ANNOUNCEMENT: "general-announcement",
  NEW_CONSULTANT_APPLICATION: "new-consultant-application",

  // Waitlist
  WAITLIST_SPOT_AVAILABLE: "waitlist-spot-available",

  // Disputes
  DISPUTE_CREATED: "dispute-created",
  DISPUTE_RESOLVED: "dispute-resolved",

  // Recordings
  RECORDING_AVAILABLE: "recording-available",
} as const;

export type NovuWorkflowId =
  (typeof NOVU_WORKFLOWS)[keyof typeof NOVU_WORKFLOWS];

// ============================================================================
// Payload Type Definitions
// ============================================================================

export interface AppointmentPayload {
  appointmentId?: string;
  appointmentType: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dateTime?: string;
  dashboardUrl: string;
}

export interface AppointmentCancelledPayload extends AppointmentPayload {
  reason?: string;
  cancelledBy: "consultant" | "consultee" | "system";
}

export interface AppointmentRescheduledPayload extends AppointmentPayload {
  oldDateTime?: string;
  newDateTime?: string;
}

export interface PaymentSuccessPayload {
  amount: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  planTitle: string;
  receiptUrl?: string;
  dashboardUrl: string;
}

export interface PaymentFailedPayload {
  amount: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  planTitle?: string;
  failureReason: string;
  retryUrl?: string;
}

export interface RefundPayload {
  amount: number;
  currency: string;
  reason?: string;
  appointmentType?: string;
  consultantName?: string;
  dashboardUrl: string;
}

export interface SupportTicketPayload {
  ticketId: string;
  ticketTitle: string;
  status?: string;
  message?: string;
  respondedBy?: string;
  dashboardUrl: string;
}

export interface FeedbackPayload {
  feedbackId: string;
  userName: string;
  category?: string;
  message: string;
  dashboardUrl: string;
}

export interface ReviewPayload {
  reviewerName: string;
  rating: number;
  comment?: string;
  planTitle?: string;
  dashboardUrl: string;
}

export interface TrialSessionPayload {
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dateTime?: string;
  status: string;
  dashboardUrl: string;
}

export interface SubscriptionPayload {
  subscriptionId?: string;
  planTitle: string;
  consultantName: string;
  consulteeName?: string;
  dashboardUrl: string;
}

export interface BookingRequestPayload {
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  requestedDateTime?: string;
  dashboardUrl: string;
}

export interface VerificationPayload {
  status: string;
  reason?: string;
  dashboardUrl: string;
}

export interface PayoutPayload {
  amount: number;
  currency: string;
  payoutId?: string;
  dashboardUrl: string;
}

export interface AnnouncementPayload {
  title: string;
  content: string;
  linkUrl?: string;
  linkText?: string;
}

export interface WaitlistPayload {
  consultantName: string;
  planTitle: string;
  dashboardUrl: string;
}

export interface DisputePayload {
  disputeId?: string;
  amount: number;
  currency: string;
  reason?: string;
  status?: string;
  consultantName?: string;
  consulteeName?: string;
  dashboardUrl: string;
}

export interface RecordingPayload {
  appointmentType: string;
  consultantName: string;
  consulteeName?: string;
  recordingUrl: string;
  dashboardUrl: string;
}

export interface ConsultantApplicationPayload {
  applicantName: string;
  applicantEmail: string;
  dashboardUrl: string;
}
