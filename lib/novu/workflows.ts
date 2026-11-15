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
  EVENT_SEAT_OPENED: "event-seat-opened",
  APPOINTMENT_RESCHEDULED: "appointment-rescheduled",
  APPOINTMENT_REMINDER: "appointment-reminder",
  SESSION_HOST_LIVE: "session-host-live",
  APPOINTMENT_COMPLETED: "appointment-completed",
  CHAT_UNREAD_DIGEST: "chat-unread-digest",

  // Payment events
  PAYMENT_LINK: "payment-link",
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
  REVIEW_EXCLUDED_FROM_RATING: "review-excluded-from-rating",

  // Trials
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
  PAYOUT_CLAWBACK: "payout-clawback",

  // Admin / System
  GENERAL_ANNOUNCEMENT: "general-announcement",
  NEW_CONSULTANT_APPLICATION: "new-consultant-application",

  // Moderation & Account Security
  ACCOUNT_SECURITY_NOTICE: "account-security-notice",
  MODERATION_WARNING: "moderation-warning",
  CONTENT_REMOVED_NOTICE: "content-removed-notice",
  ACCOUNT_SUSPENDED: "account-suspended",
  ACCOUNT_BANNED: "account-banned",

  // Disputes
  DISPUTE_CREATED: "dispute-created",
  DISPUTE_UPDATED: "dispute-updated",
  DISPUTE_RESOLVED: "dispute-resolved",

  // Recordings
  RECORDING_AVAILABLE: "recording-available",
  RECORDING_FAILED: "recording-failed",
  RECORDING_REMOVED: "recording-removed",

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
  COLLABORATOR_INVITE_EXPIRED: "collaborator-invite-expired",

  // Platform Compliance
  COMPLIANCE_DEADLINE_ALERT: "compliance-deadline-alert",

  // Enterprise (org-scoped events)
  ORG_CREATED: "org-created",
  ORG_INVITE_SENT: "org-invite-sent",
  ORG_INVITE_ACCEPTED: "org-invite-accepted",
  ORG_ROLE_CHANGED: "org-role-changed",
  ORG_MEMBER_REMOVED: "org-member-removed",
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
  ORG_PAYOUT_CLAWBACK: "org-payout-clawback",
  ORG_PROGRAM_EXHAUSTED: "org-program-exhausted",
  ORG_PROGRAM_CAP_NEAR: "org-program-cap-near",
  ORG_PROGRAM_OVERAGE_DUE: "org-program-overage-due",
  ORG_SEAT_ASSIGNED: "org-seat-assigned",
  ORG_SEAT_REVOKED: "org-seat-revoked",
  ORG_CONTRACT_STATUS_CHANGED: "org-contract-status-changed",
  ORG_SSO_PROVIDER_SUBMITTED: "org-sso-provider-submitted",
  ORG_SSO_PROVIDER_DECIDED: "org-sso-provider-decided",
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

/** Rung to every waiter on a sold-out webinar or class when a seat frees; nothing is reserved. */
export type EventSeatOpenedPayload = NotificationScope & {
  planTitle: string;
  eventLabel: "webinar" | "class";
  checkoutUrl: string;
};

/** Rung once per session to its paid seats when the host first joins through the app. */
export type SessionHostLivePayload = NotificationScope & {
  appointmentType: string;
  planTitle: string;
  consultantName: string;
  dashboardUrl: string;
};

/** `summary` names counterparts and sessions only; it never carries message text. */
export type ChatUnreadDigestPayload = NotificationScope & {
  summary: string;
  threadCount: number;
  dashboardUrl: string;
};

export type AppointmentCancelledPayload = AppointmentPayload & {
  reason: string;
  cancelledBy: string;
  cancelledByRole?: "consultant" | "consultee" | "system";
  /** A host removed this one seat; the event itself goes ahead. */
  seatRemoved?: boolean;
};

export type AppointmentCancelledInput = AppointmentPayloadInput & {
  reason?: string;
  cancelledBy: "consultant" | "consultee" | "system";
  seatRemoved?: boolean;
};

export type RescheduleOutcomeFields =
  | {
      outcome: "MOVED" | "PROPOSED";
      oldDateTime: string;
      newDateTime: string;
      /** A host move: attendees may leave with a full refund until then (ISO). */
      leaveBy?: string;
      /** The attendee already holds another session at the new time. */
      clash?: boolean;
    }
  | {
      outcome: "RELEASED";
      oldDateTime?: string;
      newDateTime?: never;
      leaveBy?: never;
      clash?: never;
    }
  | {
      outcome: "DECLINED" | "WITHDRAWN" | "EXPIRED";
      oldDateTime?: string;
      newDateTime?: never;
      leaveBy?: never;
      clash?: never;
    };

export type AppointmentRescheduledInput = AppointmentPayloadInput &
  RescheduleOutcomeFields & {
    /** PROPOSED: when the proposal lapses unanswered (ISO). */
    respondBy?: string;
    /** A series move: every moved session, old start and new (ISO). */
    moves?: ReadonlyArray<{ from: string; to: string }>;
  };

export type AppointmentRescheduledPayload = AppointmentPayload & {
  outcome: RescheduleOutcomeFields["outcome"];
  oldDateTime?: string;
  oldDateTimeIso?: string;
  newDateTime: string;
  newDateTimeIso?: string;
  leaveBy?: string;
  leaveByIso?: string;
  clash?: boolean;
  respondBy?: string;
  respondByIso?: string;
  /** "old → new" per moved session, at most ten, then "and N more". */
  movesText?: string;
  movedCount?: number;
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

export type PaymentLinkPayload = Partial<NotificationScope> & {
  paymentId?: string;
  appointmentId?: string;
  amount: string;
  amountFormatted: string;
  amountPaise: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  appointmentTypeCode?: string;
  planTitle?: string;
  paymentUrl: string;
  expiresAt?: string;
  expiresAtIso?: string;
  reminder?: boolean;
};

export type PaymentLinkInput = Omit<
  PaymentLinkPayload,
  | "amount"
  | "amountFormatted"
  | "amountPaise"
  | "appointmentTypeCode"
  | "expiresAt"
  | "expiresAtIso"
> & {
  amount: number;
  expiresAt?: string | Date;
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
  slaWindow?: string;
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
  /** The learner's completed-trial bell: the expert to continue with; `dashboardUrl` is then the plan. */
  continueWith?: string;
};

export type TrialInput = Omit<TrialPayload, "dateTimeIso" | "statusCode">;

export type SubscriptionPayload = {
  subscriptionId?: string;
  planTitle: string;
  consultantName: string;
  consulteeName?: string;
  dashboardUrl: string;
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
  /** The unscheduled-plan nudge: when the buyer is refunded in full. */
  refundAt?: string;
  refundAtIso?: string;
  /** The request-expiring alert: when the unanswered request lapses. */
  expiresAt?: string;
  expiresAtIso?: string;
  /** The daily plan-week reminder: one sentence covering every plan due. */
  weekSummary?: string;
};

export type BookingRequestInput = Omit<
  BookingRequestPayload,
  | "appointmentTypeCode"
  | "requestedDateTimeIso"
  | "refundAtIso"
  | "expiresAtIso"
>;

export type VerificationPayload = {
  status: string;
  reason?: string;
  dashboardUrl: string;
};

export type ModerationWarningPayload = {
  reason?: string;
  supportUrl?: string;
};

export type AccountSuspendedPayload = {
  reason?: string;
  suspendedUntil: string;
  suspendedUntilIso?: string;
  appointmentsCancelled?: number;
  supportUrl?: string;
};

export type AccountSuspendedInput = Omit<
  AccountSuspendedPayload,
  "suspendedUntilIso"
>;

export type AccountBannedPayload = {
  reason?: string;
  appointmentsCancelled?: number;
  supportUrl?: string;
};

export type PayoutPayload = {
  amount: string;
  amountPaise: number;
  currency: string;
  payoutId?: string;
  kind?: "FAILED" | "REVERSED";
  reason?: string;
  dashboardUrl: string;
};

export type PayoutInput = Omit<PayoutPayload, "amount" | "amountPaise"> & {
  amount: number;
};

/** A clawback journal's effect on what the payee owes back. */
export type ClawbackNoticeEvent =
  "RAISED" | "OFFSET_RESERVED" | "OFFSET_RELEASED" | "VOIDED";

export type PayoutClawbackPayload = {
  eventKind: ClawbackNoticeEvent;
  amount: string;
  payoutId: string;
  dashboardUrl: string;
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
  dashboardUrl: string;
};

export type RecordingRemovedPayload = NotificationScope & {
  recordingTitle: string;
  consultantName: string;
  dashboardUrl: string;
};

export type RecordingFailedPayload = {
  streamCallId: string;
  dashboardUrl: string;
};

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

/** Every collaborator lifecycle bell carries the same fields. */
export type CollaboratorNoticePayload = {
  planTitle: string;
  planType: string;
  collaboratorName: string;
  ownerName: string;
  role: string;
  revenueSharePercentage: number;
  dashboardUrl: string;
};

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
  amount?: string;
  totalPaise: number;
  currency: string;
  daysLate: number;
  reminderStage: number;
  payUrl: string;
};

export type OrgInvoiceOverdueInput = Omit<
  OrgInvoiceOverduePayload,
  "total" | "amount"
>;

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

export type AccountSecurityNoticeKind =
  | "WELCOME"
  | "PASSWORD_CHANGED"
  | "ACCOUNT_LINKED"
  | "TWO_FACTOR_ENABLED"
  | "TWO_FACTOR_DISABLED"
  | "PASSKEY_ADDED"
  | "PASSKEY_REMOVED"
  | "SECURITY_UPDATE"
  | "ACCOUNT_REINSTATED";

export type AccountSecurityNoticePayload = {
  kind: AccountSecurityNoticeKind;
  provider?: string;
  reason?: string;
  message?: string;
  dashboardUrl: string;
};

export type ComplianceAlertPayload = OrgNotificationScope & {
  title?: string;
  obligationType?: string;
  dueDate?: string;
  dueDateIso?: string;
  daysRemaining?: number;
  orgName?: string;
  dashboardUrl: string;
};

export type ReferralBonusEarnedPayload = {
  refereeName: string;
  bonusAmount: string;
  bonusAmountPaise: number;
  currency?: string;
  dashboardUrl: string;
};

export type ReferralBonusEarnedInput = {
  refereeName: string;
  bonusAmountPaise: number;
  currency?: string;
  dashboardUrl: string;
};

export type RefereeWelcomeBonusPayload = {
  referrerName: string;
  bonusAmount: string;
  bonusAmountPaise: number;
  currency?: string;
  dashboardUrl: string;
};

export type RefereeWelcomeBonusInput = {
  referrerName: string;
  bonusAmountPaise: number;
  currency?: string;
  dashboardUrl: string;
};

export type OrgCreatedPayload = OrgNotificationScope & {
  orgName: string;
  orgSlug?: string;
  dashboardUrl: string;
};

export type OrgRoleChangedPayload = OrgNotificationScope & {
  orgName: string;
  previousRole?: string;
  newRole: string;
  changedByName?: string;
  dashboardUrl: string;
};

export type OrgMemberRemovedPayload = OrgNotificationScope & {
  orgName: string;
  removedByName?: string;
  reason?: string | null;
  dashboardUrl: string;
};

export type OrgSsoProviderSubmittedPayload = OrgNotificationScope & {
  orgName: string;
  providerId: string;
  issuer?: string;
  domains?: string | string[];
  dashboardUrl: string;
};

export type OrgSsoProviderDecidedPayload = OrgNotificationScope & {
  orgName: string;
  providerId: string;
  decision: "APPROVED" | "REVOKED" | "REJECTED";
  reason?: string;
  dashboardUrl: string;
};

export type OrgSeatAssignedPayload = OrgNotificationScope & {
  orgName: string;
  programName: string;
  dashboardUrl: string;
};

export type OrgSeatRevokedPayload = OrgNotificationScope & {
  orgName: string;
  programName: string;
  reason?: string | null;
  dashboardUrl: string;
};

export type OrgContractStatusChangedPayload = OrgNotificationScope & {
  orgName: string;
  status: string;
  effectiveDate?: string;
  effectiveDateIso?: string;
  dashboardUrl: string;
};
