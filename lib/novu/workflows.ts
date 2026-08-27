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
  // #779 §A — a refund the gateway rejected. In-app to the payer so they
  // know the money isn't coming back via this attempt + can chase support.
  REFUND_FAILED: "refund-failed",

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

  // Moderation (#693) — staff actions against a reported user. Workflow
  // definitions must exist in the Novu dashboard with these slugs.
  MODERATION_WARNING: "moderation-warning",
  ACCOUNT_SUSPENDED: "account-suspended",
  ACCOUNT_BANNED: "account-banned",

  // Disputes
  DISPUTE_CREATED: "dispute-created",
  DISPUTE_RESOLVED: "dispute-resolved",

  // Recordings
  RECORDING_AVAILABLE: "recording-available",
  RECORDING_FAILED: "recording-failed",
  // STR-3 — STREAM_ONLY recordings aren't auto-transferred; warn the host
  // before their Stream S3 URL lapses so they can download/keep it.
  RECORDING_EXPIRING: "recording-expiring",

  // Documents — per-appointment review flow. An upload pings the reviewer,
  // a decision pings the uploader (see notifyDocumentUploaded/Reviewed).
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

  // Maintenance
  MAINTENANCE_SCHEDULED: "maintenance-scheduled",
  MAINTENANCE_STARTED: "maintenance-started",
  MAINTENANCE_ENDED: "maintenance-ended",

  // Enterprise (arch-4) — org-scoped events. Workflow definitions must
  // exist in the Novu dashboard with the matching slug; each is one
  // in-app + optional email step. Delivery-channel routing is Novu's
  // responsibility — the app just triggers with payload.
  ORG_INVITE_SENT: "org-invite-sent",
  ORG_INVITE_ACCEPTED: "org-invite-accepted",
  ORG_INVOICE_ISSUED: "org-invoice-issued",
  ORG_INVOICE_PAID: "org-invoice-paid",
  // #779 §A — dunning. ISSUED→OVERDUE first-notice + the escalating
  // 7-day reminders share one workflow; `reminderStage` drives the copy.
  ORG_INVOICE_OVERDUE: "org-invoice-overdue",
  // #779 §A — a CHARGE_MEMBER overage side-charge hit its 14-day timeout
  // (PENDING→FAILED). In-app to the member only (their obligation lapsed).
  ORG_MEMBER_OVERAGE_TIMED_OUT: "org-member-overage-timed-out",
  ORG_LICENSE_RENEWAL_UPCOMING: "org-license-renewal-upcoming",
  ORG_DATA_EXPORT_READY: "org-data-export-ready",
  ORG_WALLET_TOPUP_CONFIRMED: "org-wallet-topup-confirmed",
  // #777 §C — wallet dipped below its configured minimum. NOTIFY-ONLY floor:
  // tells finance to top up; the auto-charge lands with payment mandates.
  ORG_WALLET_LOW: "org-wallet-low",
  ORG_PAYOUT_COMPLETED: "org-payout-completed",
  ORG_PAYOUT_FAILED: "org-payout-failed",
  ORG_PAYOUT_REVERSED: "org-payout-reversed",
  ORG_PROGRAM_EXHAUSTED: "org-program-exhausted",
  // #768 lockdown #22 — 80% early-warning sibling of ORG_PROGRAM_EXHAUSTED.
  // Fires once per cycle on the <80% → >=80% transition so operators can
  // upsize before bookings actually start getting refused at 100%.
  ORG_PROGRAM_CAP_NEAR: "org-program-cap-near",
  // #775 — a CHARGE_MEMBER over-cap booking created a side-charge the member
  // now owes. In-app to the member only (their personal payment obligation).
  ORG_PROGRAM_OVERAGE_DUE: "org-program-overage-due",
  ORG_SSO_PROVIDER_DELETED: "org-sso-provider-deleted",
  ORG_SSO_CERT_EXPIRING: "org-sso-cert-expiring",
  // A7: notify the consultant that their EXPERT membership at an org was
  // soft-deleted. Triggered from the member DELETE handler.
  ORG_EXPERT_REMOVED: "org-expert-removed",
} as const;

// ============================================================================
// Notification scope
// ============================================================================

/**
 * Which dashboard owns the work a notification is about.
 *
 * ADR 19 splits the dashboards by the org-ness of the underlying session, plan
 * or payment, but the notification layer never learned the split: one Novu
 * subscriber per user, no org field on any payload, and an Inbox with no
 * filter. A consultant who also delivers for an organization got one merged
 * feed in which an org-session booking was byte-identical to a B2C one.
 *
 * Every payload for work that can happen in both contexts carries this. It is
 * REQUIRED rather than optional on purpose — an omission should fail the build
 * at the call site, not silently produce another unattributable notification.
 *
 * `scope` is derivable from `organizationId` and is stored anyway: Novu's Inbox
 * filters tabs on payload equality, and "this field is null" is not expressible
 * that way. Use {@link notificationScope} so the two can never disagree.
 */
export type NotificationScope = {
  /** Null for B2C work. Copied from the triggering record's own column. */
  organizationId: string | null;
  scope: "personal" | "org";
  /** Display name of the owning org. Absent for personal work. */
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

/**
 * Which of the three reschedule outcomes happened, and therefore which sentence
 * the `appointment-rescheduled` template must render.
 *
 * A reschedule does not always have a destination. "Any time works" is the
 * common case — the slots go back to the consultant's queue and no new time
 * exists yet — so a template that always says "moved from X to Y" has nothing
 * to put in either blank. The discriminator makes that a template branch rather
 * than two empty interpolations, the same way `OrgInvoiceOverduePayload`
 * (`reminderStage`) and `OrgPayoutFailedPayload` (`kind`) drive their copy.
 *
 * The arms are unions rather than optional fields on purpose: MOVED and
 * PROPOSED cannot be constructed without both times, so the blank-blank payload
 * that produced "from&nbsp;&nbsp;to" is now a compile error.
 */
export type RescheduleOutcomeFields =
  | {
      /** MOVED: auto-confirmed, the booking now holds `newDateTime`.
       *  PROPOSED: `newDateTime` was asked for and awaits the other party. */
      outcome: "MOVED" | "PROPOSED";
      oldDateTime: string;
      newDateTime: string;
    }
  | {
      /** Slots released with no replacement time — awaiting a new one. */
      outcome: "RELEASED";
      oldDateTime?: string;
      newDateTime?: never;
    }
  | {
      /** PR 2e — the proposal was declined or withdrawn; the booking stays
       *  at its original times (or is in the consultant's queue if slots
       *  were released). No destination time exists. */
      outcome: "DECLINED" | "WITHDRAWN";
      oldDateTime?: string;
      newDateTime?: never;
    };

// `dateTime` from AppointmentPayload is deliberately unused here: a reschedule
// is about the pair of times, not a single one.
export type AppointmentRescheduledPayload = AppointmentPayload &
  RescheduleOutcomeFields;

export type PaymentSuccessPayload = NotificationScope & {
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

export type RefundPayload = NotificationScope & {
  amount: number;
  currency: string;
  reason?: string;
  appointmentType?: string;
  consultantName?: string;
  dashboardUrl: string;
};

export type SupportTicketPayload = NotificationScope & {
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

export type BookingRequestPayload = NotificationScope & {
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

// Moderation (#693)
export type ModerationWarningPayload = {
  reason?: string;
};

export type AccountSuspendedPayload = {
  reason?: string;
  /** ISO timestamp the suspension lapses (lazy expiry at sign-in). */
  suspendedUntil: string;
  appointmentsCancelled?: number;
};

export type AccountBannedPayload = {
  reason?: string;
  appointmentsCancelled?: number;
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

export type RecordingPayload = NotificationScope & {
  appointmentType: string;
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

// STR-3 — one notification per consultant summarising how many of their
// STREAM_ONLY recordings expire soon. `expiresAt` is the soonest expiry in the
// batch so the copy can lead with the nearest deadline.
export type RecordingExpiringPayload = {
  recordingCount: number;
  expiresAt: string;
  dashboardUrl: string;
};

/**
 * Fired when a document lands on an appointment (consultee submission,
 * consultee revision, or consultant response). Recipient is the other
 * party — the reviewer for consultee uploads, the uploader for responses.
 */
export type DocumentUploadedPayload = NotificationScope & {
  appointmentId: string;
  documentId: string;
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  /** Original filename as uploaded. */
  fileName: string;
  /** True when threaded onto an existing review (revision or response). */
  isThreaded: boolean;
  /** 1-based sequence within the review thread. */
  versionNo: number;
  consultantName: string;
  consulteeName: string;
  dashboardUrl: string;
};

/**
 * Fired when a consultant changes a document's review status. Recipient is
 * the consultee who submitted it. `reviewStatus` is the NEW status; templates
 * branch on it (approved / rejected / needs-revision / in-review).
 */
export type DocumentReviewedPayload = NotificationScope & {
  appointmentId: string;
  documentId: string;
  reviewStatus: "PENDING" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_REVISION";
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

// ============================================================================
// Enterprise (arch-4) Payload Types
// ============================================================================

export type OrgInviteSentPayload = {
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
};

export type OrgInviteAcceptedPayload = {
  accepteeName: string;
  accepteeEmail: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
};

export type OrgInvoiceIssuedPayload = {
  invoiceNumber: string;
  orgName: string;
  totalPaise: number;
  currency: string;
  dueDate: string;
  dashboardUrl: string;
  /** #438 — deep link to the invoice PDF route (302s to a signed URL). */
  pdfUrl?: string;
};

export type OrgInvoicePaidPayload = {
  invoiceNumber: string;
  orgName: string;
  totalPaise: number;
  currency: string;
  paidAt: string;
  dashboardUrl: string;
};

// #779 §A — dunning notice. `reminderStage` is 0 for the first OVERDUE
// notice and 1..3 for the escalating 7-day reminders so the template can
// ramp the urgency copy. `daysLate` is days since dueDate; `payUrl` deep-
// links to the invoice pay surface.
export type OrgInvoiceOverduePayload = {
  invoiceNumber: string;
  orgName: string;
  totalPaise: number;
  currency: string;
  daysLate: number;
  reminderStage: number;
  payUrl: string;
};

// #779 §A — a member-owed overage side-charge timed out (PENDING→FAILED)
// after 14 days unpaid. `payUrl` still points at the settle surface (the
// member can retry via FAILED→PENDING resume-checkout).
export type OrgMemberOverageTimedOutPayload = {
  orgName: string;
  programName: string;
  amountPaise: number;
  currency: string;
  payUrl: string;
};

export type OrgLicenseRenewalUpcomingPayload = {
  orgName: string;
  cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  renewalDate: string;
  daysUntilRenewal: number;
  expectedTotalPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type OrgDataExportReadyPayload = {
  orgName: string;
  exportId: string;
  fileSizeBytes: number;
  expiresAt: string;
  downloadUrl: string;
  dashboardUrl: string;
};

export type OrgWalletTopupConfirmedPayload = {
  orgName: string;
  amountPaise: number;
  currency: string;
  newBalancePaise: number;
  dashboardUrl: string;
};

// #777 §C — wallet low-balance alert. `balancePaise` is the live balance that
// tripped the floor; `minimumPaise` is the configured threshold. NOTIFY-ONLY —
// no money moves until mandates land. `topUpUrl` deep-links to the wallet tab.
export type OrgWalletLowPayload = {
  orgName: string;
  balancePaise: number;
  minimumPaise: number;
  currency: string;
  topUpUrl: string;
};

export type OrgPayoutCompletedPayload = {
  orgName: string;
  payoutId: string;
  amountPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type OrgProgramExhaustedPayload = {
  orgName: string;
  programName: string;
  assigneeName: string;
  dashboardUrl: string;
};

// #768 lockdown #22 — early-warning payload. `usedPct` is the post-booking
// utilization ratio (0-100) that crossed the 80% line; `engagementsUsed` /
// `cap` let the template render "41 of 50 sessions used".
export type OrgProgramCapNearPayload = {
  orgName: string;
  programName: string;
  assigneeName: string;
  engagementsUsed: number;
  cap: number;
  usedPct: number;
  dashboardUrl: string;
};

// #775 — CHARGE_MEMBER overage side-charge owed by the member. `amountPaise`
// is the marginal (incl. surcharge); `payUrl` deep-links to the pay surface.
export type OrgProgramOverageDuePayload = {
  orgName: string;
  programName: string;
  amountPaise: number;
  payUrl: string;
};

export type OrgSsoProviderDeletedPayload = {
  orgName: string;
  providerId: string;
  deletedByName: string;
  dashboardUrl: string;
};

export type OrgSsoCertExpiringPayload = {
  orgName: string;
  providerId: string;
  daysRemaining: number;
  severity: "WARN" | "CRITICAL" | "EXPIRED";
  notAfter: string;
  dashboardUrl: string;
};

// A1+A8: discriminated payload for the failed/reversed payout webhook
// fan-out. `kind` distinguishes a gateway rejection (FAILED) from a bank
// reversal (REVERSED) so the Novu template can render the right copy.
export type OrgPayoutFailedPayload = {
  orgName: string;
  payoutId: string;
  amountPaise: number;
  currency: string;
  reason: string;
  kind: "FAILED" | "REVERSED";
  dashboardUrl: string;
};

// A7: payload for the EXPERT-removed-from-org notification. `removedByName`
// is the operator who triggered the soft-delete (or "system" for cron-
// driven removals such as contract expiry). `reason` is optional free-text.
export type OrgExpertRemovedPayload = {
  orgName: string;
  orgSlug: string;
  removedByName: string;
  reason: string | null;
  dashboardUrl: string;
};
