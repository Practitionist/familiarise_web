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

  // Referrals
  REFERRAL_BONUS_EARNED: "referral-bonus-earned",
  REFEREE_WELCOME_BONUS: "referee-welcome-bonus",
  REFERRAL_CREDITS_APPLIED: "referral-credits-applied",

  // Collaborators
  COLLABORATOR_INVITED: "collaborator-invited",
  COLLABORATOR_ACCEPTED: "collaborator-accepted",
  COLLABORATOR_REMOVED: "collaborator-removed",

  // Maintenance
  MAINTENANCE_SCHEDULED: "maintenance-scheduled",
  MAINTENANCE_STARTED: "maintenance-started",
  MAINTENANCE_ENDED: "maintenance-ended",
} as const;

export type NovuWorkflowId =
  (typeof NOVU_WORKFLOWS)[keyof typeof NOVU_WORKFLOWS];

// ============================================================================
// Payload Type Definitions
// ============================================================================

export type AppointmentPayload = {
  appointmentId?: string;
  appointmentType: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dateTime?: string;
  dashboardUrl: string;
};

export type AppointmentCancelledPayload = AppointmentPayload & {
  reason?: string;
  cancelledBy: "consultant" | "consultee" | "system";
};

export type AppointmentRescheduledPayload = AppointmentPayload & {
  oldDateTime?: string;
  newDateTime?: string;
};

export type PaymentSuccessPayload = {
  amount: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  planTitle: string;
  receiptUrl?: string;
  dashboardUrl: string;
};

export type PaymentFailedPayload = {
  amount: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  planTitle?: string;
  failureReason: string;
  retryUrl?: string;
};

export type RefundPayload = {
  amount: number;
  currency: string;
  reason?: string;
  appointmentType?: string;
  consultantName?: string;
  dashboardUrl: string;
};

export type SupportTicketPayload = {
  ticketId: string;
  ticketTitle: string;
  status?: string;
  message?: string;
  respondedBy?: string;
  dashboardUrl: string;
};

export type FeedbackPayload = {
  feedbackId: string;
  userName: string;
  category?: string;
  message: string;
  dashboardUrl: string;
};

export type ReviewPayload = {
  reviewerName: string;
  rating: number;
  comment?: string;
  planTitle?: string;
  dashboardUrl: string;
};

export type TrialSessionPayload = {
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dateTime?: string;
  status: string;
  dashboardUrl: string;
};

export type SubscriptionPayload = {
  subscriptionId?: string;
  planTitle: string;
  consultantName: string;
  consulteeName?: string;
  dashboardUrl: string;
};

export type BookingRequestPayload = {
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  requestedDateTime?: string;
  dashboardUrl: string;
};

export type VerificationPayload = {
  status: string;
  reason?: string;
  dashboardUrl: string;
};

export type PayoutPayload = {
  amount: number;
  currency: string;
  payoutId?: string;
  dashboardUrl: string;
};

export type AnnouncementPayload = {
  title: string;
  content: string;
  linkUrl?: string;
  linkText?: string;
};

export type WaitlistPayload = {
  consultantName: string;
  planTitle: string;
  dashboardUrl: string;
};

export type DisputePayload = {
  disputeId?: string;
  amount: number;
  currency: string;
  reason?: string;
  status?: string;
  consultantName?: string;
  consulteeName?: string;
  dashboardUrl: string;
};

export type RecordingPayload = {
  appointmentType: string;
  consultantName: string;
  consulteeName?: string;
  recordingUrl: string;
  dashboardUrl: string;
};

export type ConsultantApplicationPayload = {
  applicantName: string;
  applicantEmail: string;
  dashboardUrl: string;
};

export type ReferralBonusPayload = {
  referrerName: string;
  refereeName: string;
  bonusAmount: number;
  currency: string;
  dashboardUrl: string;
};

export type RefereeWelcomeBonusPayload = {
  refereeName: string;
  referrerName: string;
  bonusAmount: number;
  currency: string;
  dashboardUrl: string;
};

export type ReferralCreditsAppliedPayload = {
  creditsUsed: number;
  currency: string;
  remainingCredits: number;
  appointmentType: string;
  dashboardUrl: string;
};

export type CollaboratorInvitedPayload = {
  planTitle: string;
  planType: string;
  role: string;
  revenueSharePercentage: number;
  ownerName: string;
  dashboardUrl: string;
};

export type CollaboratorAcceptedPayload = {
  planTitle: string;
  planType: string;
  collaboratorName: string;
  role: string;
  dashboardUrl: string;
};

export type CollaboratorRemovedPayload = {
  planTitle: string;
  planType: string;
  dashboardUrl: string;
};

export type MaintenancePayload = {
  phase: string;
  reason?: string;
  estimatedEnd?: string;
};
