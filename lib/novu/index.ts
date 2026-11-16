export { getNovuClient, isNovuConfigured, validateNovuConfig } from "./client";
// #1654 — a caller that staged inside its transaction attempts after commit.
export { attemptTrigger } from "./outbox";
export type { StagedTrigger, TriggerResult } from "./outbox";
export type { PreparedBell, TriggerOptions } from "./service";
export { NOVU_WORKFLOWS, notificationScope } from "./workflows";
export type { NotificationScope } from "./workflows";
export { notificationHref, personalHref, scopedHref } from "./resolve-href";

/**
 * Import `notificationScope` and the href helpers from `./workflows` and
 * `./resolve-href` DIRECTLY at trigger sites, not through this barrel.
 *
 * They are re-exported here for convenience, but tests routinely stub this
 * module — `jest.mock("../../lib/novu", () => ({ notifyX: jest.fn() }))` — to
 * keep notifications off the wire. A barrel mock replaces the whole module, so
 * a pure helper pulled through it resolves to `undefined` and throws at the
 * call site, turning a 200 into a 500 in any suite that mocks the barrel.
 * These helpers are deterministic and want to run for real in tests anyway.
 */
export { computeSubscriberHash, deleteSubscriber } from "./subscriber";
export {
  // Appointments
  notifyAppointmentBooked,
  notifyAppointmentPartiallyScheduled,
  notifyAppointmentCancelled,
  notifyAppointmentRescheduled,
  notifyAppointmentReminder,
  notifyAppointmentCompleted,
  // Payments
  notifyPaymentLink,
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifyRefundProcessed,
  notifyRefundFailed,
  notifyRefundRequested,
  // Support
  notifySupportTicketCreated,
  notifySupportTicketUpdate,
  notifySupportTicketActivity,
  notifySupportTicketResponse,
  // Feedback & Reviews
  notifyFeedbackReceived,
  notifyNewReview,
  // Trials
  prepareTrialScheduledBells,
  stagePreparedBells,
  notifyTrialCompleted,
  notifyTrialCancelled,
  // Subscriptions
  notifySubscriptionStarted,
  notifySubscriptionRenewed,
  // Consultant
  notifyNewBookingRequest,
  notifyUnscheduledSubscriptionNudge,
  notifyVerificationStatusChanged,
  notifyPayoutProcessed,
  notifyPayoutFailed,
  // Account Security & Moderation
  notifyAccountSecurityNotice,
  notifyModerationWarning,
  notifyAccountSuspended,
  notifyAccountBanned,
  // Admin & Compliance
  notifyNewConsultantApplication,
  notifyComplianceAlert,
  // Disputes
  notifyDisputeCreated,
  notifyDisputeResolved,
  // Recordings
  notifyRecordingAvailable,
  notifyRecordingFailed,
  // Documents
  notifyDocumentUploaded,
  notifyDocumentReviewed,
  // Referrals
  notifyReferralBonusEarned,
  notifyRefereeWelcomeBonus,
  notifyReferralCreditsApplied,
} from "./service";
export {
  notifyOrgCreated,
  notifyOrgInviteSent,
  notifyOrgInviteAccepted,
  notifyOrgRoleChanged,
  notifyOrgMemberRemoved,
  notifyOrgInvoiceIssued,
  notifyOrgInvoicePaid,
  notifyOrgInvoiceOverdue,
  notifyMemberOverageTimedOut,
  notifyOrgLicenseRenewalUpcoming,
  notifyOrgDataExportReady,
  notifyOrgWalletTopupConfirmed,
  notifyOrgWalletLow,
  notifyOrgPayoutCompleted,
  notifyOrgPayoutFailed,
  notifyOrgProgramExhausted,
  notifyOrgProgramCapNear,
  notifyOrgProgramOverageDue,
  notifyOrgSeatAssigned,
  notifyOrgSeatRevoked,
  notifyOrgContractStatusChanged,
  notifyOrgSsoProviderSubmitted,
  notifyOrgSsoProviderDecided,
  notifyOrgSsoProviderDeleted,
} from "./org-workflows";
