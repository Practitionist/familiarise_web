export { getNovuClient, isNovuConfigured, validateNovuConfig } from "./client";
// #1654 — a caller that staged inside its transaction attempts after commit.
export { attemptTrigger } from "./outbox";
export type { StagedTrigger, TriggerResult } from "./outbox";
export type { TriggerOptions } from "./service";
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
export {
  syncSubscriber,
  deleteSubscriber,
  updateSubscriberPreferences,
} from "./subscriber";
export {
  // Appointments
  notifyAppointmentBooked,
  notifyAppointmentPartiallyScheduled,
  notifyAppointmentCancelled,
  notifyAppointmentRescheduled,
  notifyAppointmentReminder,
  notifyAppointmentCompleted,
  // Payments
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
  notifyTrialRequested,
  notifyTrialScheduled,
  notifyTrialCompleted,
  notifyTrialCancelled,
  // Subscriptions
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
  // Consultant
  notifyNewBookingRequest,
  notifyVerificationStatusChanged,
  notifyPayoutProcessed,
  notifyPayoutFailed,
  // Moderation (#693)
  notifyModerationWarning,
  notifyAccountSuspended,
  notifyAccountBanned,
  // Admin
  notifyGeneralAnnouncement,
  notifyNewConsultantApplication,
  // Disputes
  notifyDisputeCreated,
  notifyDisputeResolved,
  // Recordings
  notifyRecordingAvailable,
  // Documents
  notifyDocumentUploaded,
  notifyDocumentReviewed,
  // Referrals
  notifyReferralBonusEarned,
  notifyRefereeWelcomeBonus,
  notifyReferralCreditsApplied,
  // Collaborators
  notifyCollaboratorInvited,
  notifyCollaboratorAccepted,
  notifyCollaboratorRemoved,
} from "./service";
