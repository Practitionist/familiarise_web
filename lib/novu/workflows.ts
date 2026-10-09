/**
 * Novu Workflow Definitions & Payload Contracts
 * All workflow IDs match their counterparts in the Novu template manifest.
 */

// ============================================================================
// Workflow ID Constants
// ============================================================================

export const NOVU_WORKFLOWS = {
  // Appointment lifecycle
  APPOINTMENT_BOOKED: "appointment-booked",
  APPOINTMENT_PARTIALLY_SCHEDULED: "appointment-partially-scheduled",
  APPOINTMENT_CANCELLED: "appointment-cancelled",
  CLASS_SESSION_CANCELLED: "class-session-cancelled",
  CLASS_MAKEUP_SCHEDULED: "class-makeup-scheduled",
  CLASS_SESSION_REFUNDED: "class-session-refunded",
  CLASS_EXIT_AVAILABLE: "class-exit-available",
  SESSION_NO_SHOW: "session-no-show",
  SESSION_MISSED_RECORDING: "session-missed-recording",
  WINDOW_OPENED: "window-opened",
  APPOINTMENT_RESCHEDULED: "appointment-rescheduled",
  APPOINTMENT_REMINDER: "appointment-reminder",
  APPOINTMENT_COMPLETED: "appointment-completed",

  // Payment events
  PAYMENT_SUCCESS: "payment-success",
  PAYMENT_FAILED: "payment-failed",
  REFUND_PROCESSED: "refund-processed",
  REFUND_REQUESTED: "refund-requested",
  REFUND_FAILED: "refund-failed",

  // Support
  SUPPORT_TICKET_CREATED: "support-ticket-created",
  SUPPORT_TICKET_RECEIVED: "support-ticket-received",
  SUPPORT_TICKET_ACTIVITY: "support-ticket-activity",
  SUPPORT_TICKET_UPDATE: "support-ticket-update",
  SUPPORT_TICKET_RESPONSE: "support-ticket-response",

  // Feedback & Reviews
  FEEDBACK_RECEIVED: "feedback-received",
  MODERATION_REPORT_OUTCOME: "moderation-report-outcome",
  PLATFORM_FEEDBACK_UPDATE: "platform-feedback-update",
  NEW_REVIEW_RECEIVED: "new-review-received",

  // Trials
  TRIAL_SESSION_REQUESTED: "trial-session-requested",
  TRIAL_SESSION_SCHEDULED: "trial-session-scheduled",
  TRIAL_SESSION_COMPLETED: "trial-session-completed",
  TRIAL_SESSION_CANCELLED: "trial-session-cancelled",
  TRIAL_REFUNDED: "trial-refunded",

  // Subscriptions
  SUBSCRIPTION_STARTED: "subscription-started",
  SUBSCRIPTION_CANCELLED: "subscription-cancelled",
  SUBSCRIPTION_RENEWED: "subscription-renewed",
  SUBSCRIPTION_UNALLOCATED_REFUNDED: "subscription-unallocated-refunded",

  // Consultant-specific
  NEW_BOOKING_REQUEST: "new-booking-request",
  VERIFICATION_STATUS_CHANGED: "verification-status-changed",
  PAYOUT_PROCESSED: "payout-processed",
  PAYOUT_FAILED: "payout-failed",

  // Admin / System
  GENERAL_ANNOUNCEMENT: "general-announcement",
  NEW_CONSULTANT_APPLICATION: "new-consultant-application",

  // Moderation
  MODERATION_WARNING: "moderation-warning",
  ACCOUNT_SUSPENDED: "account-suspended",
  ACCOUNT_BANNED: "account-banned",

  // Disputes
  DISPUTE_CREATED: "dispute-created",
  DISPUTE_RESOLVED: "dispute-resolved",

  // Recordings
  RECORDING_AVAILABLE: "recording-available",
  RECORDING_FAILED: "recording-failed",
  RECORDING_EXPIRING: "recording-expiring",

  // Documents
  DOCUMENT_UPLOADED: "document-uploaded",
  DOCUMENT_REVIEWED: "document-reviewed",

  // Referrals
  REFERRAL_BONUS_EARNED: "referral-bonus-earned",
  REFEREE_WELCOME_BONUS: "referee-welcome-bonus",
  REFERRAL_CREDITS_APPLIED: "referral-credits-applied",

  // Collaborators
  COLLABORATOR_INVITED: "collaborator-invited",
  COLLABORATOR_ACCEPTED: "collaborator-accepted",
  COLLABORATOR_REMOVED: "collaborator-removed",
  COLLABORATOR_WITHDRAWN: "collaborator-withdrawn",
  COLLABORATOR_DECLINED: "collaborator-declined",

  // Maintenance
  MAINTENANCE_SCHEDULED: "maintenance-scheduled",
  MAINTENANCE_STARTED: "maintenance-started",
  MAINTENANCE_ENDED: "maintenance-ended",

  // Enterprise (org-scoped events)
  ORG_INVITE_SENT: "org-invite-sent",
  ORG_INVITE_ACCEPTED: "org-invite-accepted",
  ORG_INVOICE_ISSUED: "org-invoice-issued",
  ORG_INVOICE_PAID: "org-invoice-paid",
  ORG_INVOICE_OVERDUE: "org-invoice-overdue",
  ORG_MEMBER_OVERAGE_TIMED_OUT: "org-member-overage-timed-out",
  ORG_LICENSE_RENEWAL_UPCOMING: "org-license-renewal-upcoming",
  ORG_DATA_EXPORT_READY: "org-data-export-ready",
  ORG_WALLET_TOPUP_CONFIRMED: "org-wallet-topup-confirmed",
  ORG_WALLET_LOW: "org-wallet-low",
  ORG_PAYOUT_COMPLETED: "org-payout-completed",
  ORG_PAYOUT_FAILED: "org-payout-failed",
  ORG_PAYOUT_REVERSED: "org-payout-reversed",
  ORG_PROGRAM_EXHAUSTED: "org-program-exhausted",
  ORG_PROGRAM_CAP_NEAR: "org-program-cap-near",
  ORG_PROGRAM_OVERAGE_DUE: "org-program-overage-due",
  ORG_SSO_PROVIDER_DELETED: "org-sso-provider-deleted",
  ORG_EXPERT_REMOVED: "org-expert-removed",
} as const;

// ============================================================================
// Notification scope
// ============================================================================

export type NotificationScope = {
  organizationId: string | null;
  scope: "personal" | "org";
  orgName?: string;
};

export function notificationScope(
  organizationId: string | null | undefined,
  orgName?: string | null,
): NotificationScope {
  const orgId = organizationId ?? null;
  return {
    organizationId: orgId,
    scope: orgId ? "org" : "personal",
    ...(orgId && orgName ? { orgName } : {}),
  };
}

// ============================================================================
// Payload Type Definitions
// ============================================================================

export type AppointmentPayload = NotificationScope & {
  appointmentId?: string;
  appointmentType: string;
  appointmentTypeCode?: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dateTime?: string;
  dateTimeIso?: string;
  dashboardUrl: string;
};

export type AppointmentPayloadInput = Omit<
  AppointmentPayload,
  "appointmentTypeCode" | "dateTimeIso"
>;

export type AppointmentPartiallyScheduledPayload = AppointmentPayload & {
  placedSessions: number;
  requiredSessions: number;
  unplacedSessions: number;
};

export type AppointmentPartiallyScheduledInput = AppointmentPayloadInput & {
  placedSessions: number;
  requiredSessions: number;
  unplacedSessions: number;
};

export type AppointmentCancelledPayload = AppointmentPayload & {
  reason: string;
  cancelledBy: string;
  cancelledByRole?: "consultant" | "consultee" | "system";
};

export type AppointmentCancelledInput = AppointmentPayloadInput & {
  reason?: string;
  cancelledBy: "consultant" | "consultee" | "system";
};

export type RescheduleOutcomeFields =
  | {
      outcome: "MOVED" | "PROPOSED";
      oldDateTime: string;
      newDateTime: string;
    }
  | {
      outcome: "RELEASED";
      oldDateTime?: string;
      newDateTime?: never;
    }
  | {
      outcome: "DECLINED" | "WITHDRAWN" | "EXPIRED";
      oldDateTime?: string;
      newDateTime?: never;
    };

export type AppointmentRescheduledInput = AppointmentPayloadInput &
  RescheduleOutcomeFields;

export type AppointmentRescheduledPayload = AppointmentPayload & {
  outcome: RescheduleOutcomeFields["outcome"];
  oldDateTime?: string;
  oldDateTimeIso?: string;
  newDateTime: string;
  newDateTimeIso?: string;
};

export type PaymentSuccessPayload = NotificationScope & {
  amount: string;
  amountFormatted: string;
  amountPaise: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  appointmentTypeCode?: string;
  planTitle: string;
  receiptUrl?: string;
  dashboardUrl: string;
};

export type PaymentSuccessInput = Omit<
  PaymentSuccessPayload,
  "amount" | "amountFormatted" | "amountPaise" | "appointmentTypeCode"
> & {
  amount: number;
};

export type PaymentFailedPayload = {
  amount: string;
  amountFormatted: string;
  amountPaise: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  appointmentTypeCode?: string;
  planTitle?: string;
  failureReason: string;
  retryUrl?: string;
};

export type PaymentFailedInput = Omit<
  PaymentFailedPayload,
  "amount" | "amountFormatted" | "amountPaise" | "appointmentTypeCode"
> & {
  amount: number;
};

export type RefundPayload = NotificationScope & {
  amount: string;
  amountFormatted: string;
  amountPaise: number;
  currency: string;
  reason?: string;
  appointmentType?: string;
  appointmentTypeCode?: string;
  consultantName?: string;
  dashboardUrl: string;
};

export type RefundInput = Omit<
  RefundPayload,
  "amount" | "amountFormatted" | "amountPaise" | "appointmentTypeCode"
> & {
  amount: number;
};

export type SupportTicketPayload = NotificationScope & {
  ticketId: string;
  reference?: string;
  ticketTitle: string;
  status?: string;
  statusCode?: string;
  message?: string;
  respondedBy?: string;
  userName?: string;
  activity?: "replied" | "reopened";
  slaWindow?: string;
  dashboardUrl: string;
};

export type SupportTicketReceivedPayload = NotificationScope & {
  ticketId: string;
  reference?: string;
  ticketTitle: string;
  slaWindow: string;
  dashboardUrl: string;
};

export type ModerationReportOutcomePayload = {
  reportId: string;
  reference: string;
  outcome: string;
  reason?: string;
  dashboardUrl: string;
};

export type PlatformFeedbackUpdatePayload = {
  feedbackId: string;
  status: string;
  message?: string;
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

export type TrialPayload = {
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dateTime?: string;
  dateTimeIso?: string;
  status: string;
  statusCode?: string;
  dashboardUrl: string;
};

export type TrialInput = Omit<TrialPayload, "dateTimeIso" | "statusCode">;

export type SubscriptionPayload = {
  subscriptionId?: string;
  planTitle: string;
  consultantName: string;
  consulteeName?: string;
  dashboardUrl: string;
  cycleOrdinal?: number;
  remainingSessions?: number;
  nextBatch?: number;
};

export type BookingRequestPayload = NotificationScope & {
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  appointmentTypeCode?: string;
  requestedDateTime?: string;
  requestedDateTimeIso?: string;
  dashboardUrl: string;
  nudgeHours?: number;
};

export type BookingRequestInput = Omit<
  BookingRequestPayload,
  "appointmentTypeCode" | "requestedDateTimeIso"
>;

export type VerificationPayload = {
  status: string;
  reason?: string;
  dashboardUrl: string;
};

export type ModerationWarningPayload = {
  reason?: string;
};

export type AccountSuspendedPayload = {
  reason?: string;
  suspendedUntil: string;
  suspendedUntilIso?: string;
  appointmentsCancelled?: number;
};

export type AccountSuspendedInput = Omit<
  AccountSuspendedPayload,
  "suspendedUntilIso"
>;

export type AccountBannedPayload = {
  reason?: string;
  appointmentsCancelled?: number;
};

export type PayoutPayload = {
  amount: string;
  amountPaise: number;
  currency: string;
  payoutId?: string;
  dashboardUrl: string;
};

export type PayoutInput = Omit<PayoutPayload, "amount" | "amountPaise"> & {
  amount: number;
};

export type AnnouncementPayload = {
  title: string;
  content: string;
  linkUrl?: string;
  linkText?: string;
};

export type DisputePayload = {
  disputeId?: string;
  amount: string;
  amountPaise: number;
  currency: string;
  reason?: string;
  status?: string;
  consultantName?: string;
  consulteeName?: string;
  dashboardUrl: string;
};

export type DisputeInput = Omit<DisputePayload, "amount" | "amountPaise"> & {
  amount: number;
};

export type RecordingPayload = NotificationScope & {
  appointmentType: string;
  appointmentTypeCode?: string;
  consultantName: string;
  consulteeName?: string;
  recordingUrl: string;
  dashboardUrl: string;
};

export type RecordingFailedPayload = {
  streamCallId: string;
  errorMessage?: string;
  dashboardUrl: string;
};

export type RecordingExpiringPayload = {
  recordingCount: number;
  expiresAt: string;
  expiresAtIso?: string;
  dashboardUrl: string;
};

export type RecordingExpiringInput = Omit<
  RecordingExpiringPayload,
  "expiresAtIso"
>;

export type DocumentUploadedPayload = NotificationScope & {
  appointmentId: string;
  documentId: string;
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  fileName: string;
  isThreaded: boolean;
  versionNo: number;
  consultantName: string;
  consulteeName: string;
  dashboardUrl: string;
};

export type DocumentReviewedPayload = NotificationScope & {
  appointmentId: string;
  documentId: string;
  reviewStatus:
    "PENDING" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_REVISION";
  reviewNotes?: string;
  originalName: string;
  consultantName: string;
  dashboardUrl: string;
};

export type ConsultantApplicationPayload = {
  applicantName: string;
  applicantEmail: string;
  dashboardUrl: string;
};

export type ReferralCreditsAppliedPayload = {
  creditsUsed: string;
  creditsUsedPaise: number;
  currency: string;
  remainingCredits: string;
  remainingCreditsPaise: number;
  appointmentType: string;
  appointmentTypeCode?: string;
  dashboardUrl: string;
};

export type ReferralCreditsAppliedInput = Omit<
  ReferralCreditsAppliedPayload,
  | "creditsUsed"
  | "creditsUsedPaise"
  | "remainingCredits"
  | "remainingCreditsPaise"
  | "appointmentTypeCode"
> & { creditsUsed: number; remainingCredits: number };

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

export type CollaboratorDeclinedPayload = CollaboratorAcceptedPayload;

export type CollaboratorRemovedPayload = {
  planTitle: string;
  planType: string;
  dashboardUrl: string;
};

export type CollaboratorWithdrawnPayload = CollaboratorRemovedPayload & {
  collaboratorName: string;
};

export type MaintenancePayload = {
  phase: string;
  reason?: string;
  estimatedEnd?: string;
  estimatedEndIso?: string;
};

export type MaintenanceInput = Omit<MaintenancePayload, "estimatedEndIso">;

// ============================================================================
// Enterprise Payload Types
// ============================================================================

export type OrgNotificationScope = Partial<NotificationScope>;

export type OrgInviteSentPayload = OrgNotificationScope & {
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
  expiresAtIso?: string;
};

export type OrgInviteSentInput = Omit<OrgInviteSentPayload, "expiresAtIso">;

export type OrgInviteAcceptedPayload = OrgNotificationScope & {
  accepteeName: string;
  accepteeEmail: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
};

export type OrgInvoiceIssuedPayload = OrgNotificationScope & {
  invoiceNumber: string;
  orgName: string;
  total: string;
  totalPaise: number;
  currency: string;
  dueDate: string;
  dueDateIso?: string;
  dashboardUrl: string;
  pdfUrl?: string;
};

export type OrgInvoiceIssuedInput = Omit<
  OrgInvoiceIssuedPayload,
  "total" | "dueDateIso"
>;

export type OrgInvoicePaidPayload = OrgNotificationScope & {
  invoiceNumber: string;
  orgName: string;
  total: string;
  totalPaise: number;
  currency: string;
  paidAt: string;
  paidAtIso?: string;
  dashboardUrl: string;
};

export type OrgInvoicePaidInput = Omit<
  OrgInvoicePaidPayload,
  "total" | "paidAtIso"
>;

export type OrgInvoiceOverduePayload = OrgNotificationScope & {
  invoiceNumber: string;
  orgName: string;
  total: string;
  totalPaise: number;
  currency: string;
  daysLate: number;
  reminderStage: number;
  payUrl: string;
};

export type OrgInvoiceOverdueInput = Omit<OrgInvoiceOverduePayload, "total">;

export type OrgMemberOverageTimedOutPayload = OrgNotificationScope & {
  orgName: string;
  programName: string;
  amount: string;
  amountPaise: number;
  currency: string;
  payUrl: string;
};

export type OrgMemberOverageTimedOutInput = Omit<
  OrgMemberOverageTimedOutPayload,
  "amount"
>;

export type OrgLicenseRenewalUpcomingPayload = OrgNotificationScope & {
  orgName: string;
  cycle: string;
  cycleCode?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  renewalDate: string;
  renewalDateIso?: string;
  daysUntilRenewal: number;
  expectedTotal: string;
  expectedTotalPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type OrgLicenseRenewalUpcomingInput = Omit<
  OrgLicenseRenewalUpcomingPayload,
  "cycle" | "cycleCode" | "renewalDateIso" | "expectedTotal"
> & { cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL" };

export type OrgDataExportReadyPayload = OrgNotificationScope & {
  orgName: string;
  exportId: string;
  fileSizeBytes: number;
  expiresAt: string;
  expiresAtIso?: string;
  downloadUrl: string;
  dashboardUrl: string;
};

export type OrgDataExportReadyInput = Omit<
  OrgDataExportReadyPayload,
  "expiresAtIso"
>;

export type OrgWalletTopupConfirmedPayload = OrgNotificationScope & {
  orgName: string;
  amount: string;
  amountPaise: number;
  currency: string;
  newBalance: string;
  newBalancePaise: number;
  dashboardUrl: string;
};

export type OrgWalletTopupConfirmedInput = Omit<
  OrgWalletTopupConfirmedPayload,
  "amount" | "newBalance"
>;

export type OrgWalletLowPayload = OrgNotificationScope & {
  orgName: string;
  balance: string;
  balancePaise: number;
  minimum: string;
  minimumPaise: number;
  currency: string;
  topUpUrl: string;
};

export type OrgWalletLowInput = Omit<
  OrgWalletLowPayload,
  "balance" | "minimum"
>;

export type OrgPayoutCompletedPayload = OrgNotificationScope & {
  orgName: string;
  payoutId: string;
  amount: string;
  amountPaise: number;
  netPayoutPaise?: number;
  tdsAmountPaise?: number;
  withheld?: string;
  currency: string;
  dashboardUrl: string;
};

export type OrgPayoutCompletedInput = Omit<OrgPayoutCompletedPayload, "amount">;

export type OrgProgramExhaustedPayload = OrgNotificationScope & {
  orgName: string;
  programName: string;
  assigneeName: string;
  dashboardUrl: string;
};

export type OrgProgramCapNearPayload = OrgNotificationScope & {
  orgName: string;
  programName: string;
  assigneeName: string;
  engagementsUsed: number;
  cap: number;
  usedPct: number;
  dashboardUrl: string;
};

export type OrgProgramOverageDuePayload = OrgNotificationScope & {
  orgName: string;
  programName: string;
  amount: string;
  amountPaise: number;
  payUrl: string;
};

export type OrgProgramOverageDueInput = Omit<
  OrgProgramOverageDuePayload,
  "amount"
>;

export type OrgSsoProviderDeletedPayload = OrgNotificationScope & {
  orgName: string;
  providerId: string;
  deletedByName: string;
  dashboardUrl: string;
};

export type OrgPayoutFailedPayload = OrgNotificationScope & {
  orgName: string;
  payoutId: string;
  amount: string;
  amountPaise: number;
  netPayoutPaise?: number;
  tdsAmountPaise?: number;
  withheld?: string;
  currency: string;
  reason: string;
  kind: "FAILED" | "REVERSED";
  dashboardUrl: string;
};

export type OrgPayoutFailedInput = Omit<OrgPayoutFailedPayload, "amount">;

export type OrgExpertRemovedPayload = OrgNotificationScope & {
  orgName: string;
  orgSlug: string;
  removedByName: string;
  reason: string | null;
  dashboardUrl: string;
};
