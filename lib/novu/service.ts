/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 */
import * as Sentry from "@sentry/nextjs";
import type { Tx } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { isNovuConfigured } from "./client";
import {
  attemptTrigger,
  stageTrigger,
  stageTriggerBatch,
  type NovuPayload,
  type StagedTrigger,
  type StageTriggerArgs,
  type TriggerResult,
} from "./outbox";
import { bellRecipientZones, resolveRecipientBellPolicy } from "./policy";
import type { NovuWorkflowId } from "./templates/types";
import { shownMoves } from "@/lib/booking/session-moves";
import {
  REQUIRED_NOTICE_FIELD,
  type RequiredNoticeKind,
  type RequiredOverride,
} from "@/lib/notifications/required-notices";
import {
  NOVU_WORKFLOWS,
  type AccountBannedPayload,
  type AccountSecurityNoticePayload,
  type AccountSuspendedInput,
  type AccountSuspendedPayload,
  type AppointmentCancelledInput,
  type AppointmentCancelledPayload,
  type AppointmentPartiallyScheduledInput,
  type AppointmentPartiallyScheduledPayload,
  type AppointmentPayload,
  type AppointmentPayloadInput,
  type AppointmentRescheduledInput,
  type AppointmentRescheduledPayload,
  type BookingRequestInput,
  type BookingRequestPayload,
  type ComplianceAlertPayload,
  type ConsultantApplicationPayload,
  type DisputeInput,
  type DisputePayload,
  type DocumentReviewedPayload,
  type DocumentUploadedPayload,
  type FeedbackPayload,
  type ModerationWarningPayload,
  type OrgExpertRemovedPayload,
  type PaymentFailedInput,
  type PaymentFailedPayload,
  type PaymentLinkInput,
  type PaymentLinkPayload,
  type PaymentSuccessInput,
  type PaymentSuccessPayload,
  type PayoutInput,
  type PayoutPayload,
  type RecordingFailedPayload,
  type RecordingRemovedPayload,
  type RecordingPayload,
  type RefereeWelcomeBonusInput,
  type RefereeWelcomeBonusPayload,
  type ReferralBonusEarnedInput,
  type ReferralBonusEarnedPayload,
  type ReferralCreditsAppliedInput,
  type ReferralCreditsAppliedPayload,
  type RefundInput,
  type RefundPayload,
  type ReviewPayload,
  type RescheduleOutcomeFields,
  type SubscriptionPayload,
  type SupportTicketPayload,
  type TrialInput,
  type TrialPayload,
  type VerificationPayload,
} from "./workflows";
import {
  appointmentTypeLabel,
  cancellationReasonLabel,
  cancelledByLabel,
  DEFAULT_NOTIFICATION_TIMEZONE,
  disputeReasonLabel,
  disputeStatusLabel,
  failureReasonLabel,
  formatNotificationAmountBare,
  formatNotificationDateTime,
  formatNotificationMoney,
  groupRecipientsByTimezone,
  refundReasonLabel,
  resolveRecipientTimezones,
} from "./humanize";

// ============================================================================
// Core trigger orchestration
// ============================================================================

export interface TriggerOptions {
  tx?: Pick<Tx, "notificationOutbox" | "membership" | "user">;
  entityRef?: string;
  dedupeKey?: string;
  /** Stage the outbox row and return without attempting inline delivery. */
  deferAttempt?: boolean;
  /** These recipients get this send whatever their switches say; the rest stay gated. */
  required?: RequiredOverride;
}

export { resolveRecipientBellPolicy } from "./policy";

function reportNotConfigured(workflowId: string): void {
  console.warn(`[Novu] Not configured. Staged only: ${workflowId}`);
  if (process.env.NODE_ENV === "production") {
    Sentry.captureMessage(`[Novu] Not configured — staged ${workflowId}`, {
      level: "warning",
      tags: { subsystem: "novu" },
    });
  }
}

async function stageAndAttempt(
  args: Omit<StageTriggerArgs, "tx" | "entityRef">,
  opts: TriggerOptions | undefined,
  requiredKind: RequiredNoticeKind | null = null,
): Promise<TriggerResult> {
  const policy = await resolveRecipientBellPolicy(
    args.workflowId,
    args.recipients,
    { tx: opts?.tx, required: requiredKind !== null },
  );
  if (policy.allowedRecipients.length === 0) return { success: true };
  const effectiveArgs = {
    ...args,
    recipients: policy.allowedRecipients,
    payload: requiredKind
      ? { ...args.payload, [REQUIRED_NOTICE_FIELD]: requiredKind }
      : args.payload,
  };
  const { required: _required, ...stageOpts } = opts ?? {};
  const staged = await stageTrigger({ ...effectiveArgs, ...stageOpts });
  if (!isNovuConfigured()) {
    reportNotConfigured(effectiveArgs.workflowId);
    return { success: false, error: "Novu not configured" };
  }
  // stageTrigger already reported the failure; with no row nothing is sent.
  if (!staged)
    return { success: false, error: "Stage failed; notice not sent" };
  if (opts?.tx || opts?.deferAttempt) return { success: true, staged };
  return attemptTrigger(staged);
}

/** The recipients split into the required group (with its kind) and the gated rest. */
function splitRequired(
  userIds: string[],
  required: RequiredOverride | undefined,
): Array<{ ids: string[]; kind: RequiredNoticeKind | null }> {
  if (!required) return [{ ids: userIds, kind: null }];
  const listed = new Set(required.recipients);
  return [
    { ids: userIds.filter((id) => listed.has(id)), kind: required.kind },
    { ids: userIds.filter((id) => !listed.has(id)), kind: null },
  ].filter((group) => group.ids.length > 0);
}

export async function triggerWorkflow<T extends NovuPayload>(
  workflowId: NovuWorkflowId,
  subscriberId: string,
  payload: T,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  const [group] = splitRequired([subscriberId], opts?.required);
  return stageAndAttempt(
    {
      workflowId,
      kind: "SINGLE",
      recipients: [subscriberId],
      payload,
      dedupeKey,
    },
    opts,
    group?.kind ?? null,
  );
}

export async function triggerForMultiple<T extends NovuPayload>(
  workflowId: NovuWorkflowId,
  userIds: string[],
  payload: T,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult[]> {
  if (userIds.length === 0) return [];
  const BATCH_SIZE = 100;
  const results: TriggerResult[] = [];
  for (const { ids, kind } of splitRequired(userIds, opts?.required)) {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const result = await stageAndAttempt(
        {
          workflowId,
          kind: batch.length === 1 ? "SINGLE" : "MULTI",
          recipients: batch,
          payload,
          dedupeKey,
        },
        opts,
        kind,
      );
      results.push(...batch.map(() => result));
    }
  }
  return results;
}

export async function triggerForMultipleZoned(
  workflowId: NovuWorkflowId,
  userIds: string[],
  build: (timezone: string) => NovuPayload,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult[]> {
  if (userIds.length === 0) return [];
  const zones = await resolveRecipientTimezones(userIds, opts?.tx);
  const results: TriggerResult[] = [];
  for (const [timezone, recipients] of groupRecipientsByTimezone(
    userIds,
    zones,
  )) {
    results.push(
      ...(await triggerForMultiple(
        workflowId,
        recipients,
        build(timezone),
        dedupeKey,
        opts,
      )),
    );
  }
  return results;
}

export async function triggerWorkflowZoned(
  workflowId: NovuWorkflowId,
  subscriberId: string,
  build: (timezone: string) => NovuPayload,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  const zones = await resolveRecipientTimezones([subscriberId], opts?.tx);
  const timezone = zones.get(subscriberId) ?? DEFAULT_NOTIFICATION_TIMEZONE;
  return triggerWorkflow(
    workflowId,
    subscriberId,
    build(timezone),
    dedupeKey,
    opts,
  );
}

// ============================================================================
// Declarative notifier factories & wire mappers
// ============================================================================

function resolveTriggerArgs(
  dedupeKeyOrOpts?: string | TriggerOptions,
  opts?: TriggerOptions,
): { dedupeKey: string | undefined; opts: TriggerOptions | undefined } {
  if (typeof dedupeKeyOrOpts === "string") {
    return { dedupeKey: dedupeKeyOrOpts, opts };
  }
  // An omitted key keeps the fourth argument, so `(…, undefined, { tx })` stays on tx.
  return { dedupeKey: undefined, opts: dedupeKeyOrOpts ?? opts };
}

function defineSingleNotifier<TInput>(
  workflowId: NovuWorkflowId,
  mapPayload: (input: TInput) => NovuPayload = (p) => p as NovuPayload,
) {
  return (
    subscriberId: string,
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
    return triggerWorkflow(
      workflowId,
      subscriberId,
      mapPayload(payload),
      r.dedupeKey,
      r.opts,
    );
  };
}

function defineMultiNotifier<TInput>(
  workflowId: NovuWorkflowId,
  mapPayload: (input: TInput) => NovuPayload = (p) => p as NovuPayload,
) {
  return (
    userIds: string[],
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult[]> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
    return triggerForMultiple(
      workflowId,
      userIds,
      mapPayload(payload),
      r.dedupeKey,
      r.opts,
    );
  };
}

function defineZonedSingleNotifier<TInput>(
  workflowId: NovuWorkflowId,
  mapPayload: (input: TInput, timezone: string) => NovuPayload,
) {
  return (
    subscriberId: string,
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
    return triggerWorkflowZoned(
      workflowId,
      subscriberId,
      (tz) => mapPayload(payload, tz),
      r.dedupeKey,
      r.opts,
    );
  };
}

function defineZonedMultiNotifier<TInput>(
  workflowId: NovuWorkflowId,
  mapPayload: (input: TInput, timezone: string) => NovuPayload,
) {
  return (
    userIds: string[],
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult[]> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
    return triggerForMultipleZoned(
      workflowId,
      userIds,
      (tz) => mapPayload(payload, tz),
      r.dedupeKey,
      r.opts,
    );
  };
}

function appointmentWire(
  input: AppointmentPayloadInput,
  timezone: string,
): AppointmentPayload {
  const { dateTime: rawDateTime, ...rest } = input;
  const dateTime = formatNotificationDateTime(rawDateTime, timezone);
  return {
    ...rest,
    appointmentType: appointmentTypeLabel(input.appointmentType),
    appointmentTypeCode: input.appointmentType,
    ...(dateTime ? { dateTime, dateTimeIso: rawDateTime } : {}),
  };
}

function partiallyScheduledWire(
  input: AppointmentPartiallyScheduledInput,
  timezone: string,
): AppointmentPartiallyScheduledPayload {
  return {
    ...appointmentWire(input, timezone),
    placedSessions: input.placedSessions,
    requiredSessions: input.requiredSessions,
    unplacedSessions: input.unplacedSessions,
  };
}

function cancelledWire(
  input: AppointmentCancelledInput,
  timezone: string,
): AppointmentCancelledPayload {
  return {
    ...appointmentWire(input, timezone),
    reason: cancellationReasonLabel(input.reason),
    cancelledBy: cancelledByLabel(input.cancelledBy, input),
    cancelledByRole: input.cancelledBy,
  };
}

const RESCHEDULE_AWAITING_TIME: Record<
  RescheduleOutcomeFields["outcome"],
  string
> = {
  MOVED: "a new time your consultant will confirm",
  PROPOSED: "a new time your consultant will confirm",
  RELEASED: "a new time your consultant will confirm",
  DECLINED: "the time it was already booked for",
  WITHDRAWN: "the time it was already booked for",
  EXPIRED: "the time it was already booked for",
};

function rescheduledWire(
  input: AppointmentRescheduledInput,
  timezone: string,
): AppointmentRescheduledPayload {
  const {
    oldDateTime: rawOld,
    newDateTime: rawNew,
    leaveBy: rawLeaveBy,
    respondBy: rawRespondBy,
    moves,
    clash,
    ...base
  } = input;
  const oldDateTime = formatNotificationDateTime(rawOld, timezone);
  const hasDestination =
    input.outcome === "MOVED" || input.outcome === "PROPOSED";
  const newDateTimeIso = hasDestination ? rawNew : undefined;
  const newDateTime = formatNotificationDateTime(newDateTimeIso, timezone);
  const leaveBy = formatNotificationDateTime(rawLeaveBy, timezone);
  const respondBy =
    input.outcome === "PROPOSED"
      ? formatNotificationDateTime(rawRespondBy, timezone)
      : undefined;
  const movesText =
    input.outcome === "MOVED" && moves && moves.length > 1
      ? sessionMovesText(moves, timezone)
      : undefined;
  return {
    ...appointmentWire(base, timezone),
    outcome: input.outcome,
    ...(oldDateTime ? { oldDateTime, oldDateTimeIso: rawOld } : {}),
    newDateTime: newDateTime ?? RESCHEDULE_AWAITING_TIME[input.outcome],
    ...(newDateTime ? { newDateTimeIso } : {}),
    ...(leaveBy ? { leaveBy, leaveByIso: rawLeaveBy } : {}),
    ...(respondBy ? { respondBy, respondByIso: rawRespondBy } : {}),
    ...(movesText ? { movesText, movedCount: moves?.length } : {}),
    ...(clash ? { clash } : {}),
  };
}

/** "old → new" per moved session in `timezone`, at most ten, then "and N more". */
export function sessionMovesText(
  moves: ReadonlyArray<{ from: string; to: string }>,
  timezone: string,
): string {
  const { shown, more } = shownMoves(moves);
  const rows = shown.map(
    ({ from, to }) =>
      `${formatNotificationDateTime(from, timezone) ?? from} → ${formatNotificationDateTime(to, timezone) ?? to}`,
  );
  return more > 0 ? `${rows.join("; ")}; and ${more} more` : rows.join("; ");
}

function trialWire(input: TrialInput, timezone: string): TrialPayload {
  const { dateTime: rawDateTime, ...rest } = input;
  const dateTime = formatNotificationDateTime(rawDateTime, timezone);
  return {
    ...rest,
    status: input.status.toLowerCase().replace(/_/g, " "),
    statusCode: input.status,
    ...(dateTime ? { dateTime, dateTimeIso: rawDateTime } : {}),
  };
}

function bookingRequestWire(
  input: BookingRequestInput,
  timezone: string,
): BookingRequestPayload {
  const {
    requestedDateTime: rawRequested,
    refundAt: rawRefundAt,
    expiresAt: rawExpiresAt,
    ...rest
  } = input;
  const requestedDateTime = formatNotificationDateTime(rawRequested, timezone);
  const refundAt = formatNotificationDateTime(rawRefundAt, timezone);
  const expiresAt = formatNotificationDateTime(rawExpiresAt, timezone);
  return {
    ...rest,
    appointmentType: appointmentTypeLabel(input.appointmentType),
    appointmentTypeCode: input.appointmentType,
    ...(requestedDateTime
      ? { requestedDateTime, requestedDateTimeIso: rawRequested }
      : {}),
    ...(refundAt ? { refundAt, refundAtIso: rawRefundAt } : {}),
    ...(expiresAt ? { expiresAt, expiresAtIso: rawExpiresAt } : {}),
  };
}

function paymentSuccessWire(
  payload: PaymentSuccessInput,
): PaymentSuccessPayload {
  return {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
}

function paymentFailedWire(payload: PaymentFailedInput): PaymentFailedPayload {
  return {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
    failureReason: failureReasonLabel(payload.failureReason),
  };
}

function paymentLinkWire(
  payload: PaymentLinkInput,
  timezone: string,
): PaymentLinkPayload {
  const { expiresAt: rawExpiresAt, ...rest } = payload;
  const rawIso =
    rawExpiresAt instanceof Date ? rawExpiresAt.toISOString() : rawExpiresAt;
  const expiresAt = formatNotificationDateTime(rawIso, timezone);
  return {
    ...rest,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
    ...(expiresAt ? { expiresAt, expiresAtIso: rawIso } : {}),
  };
}

function refundWire(payload: RefundInput): RefundPayload {
  const { reason: rawReason, ...rest } = payload;
  const reason = refundReasonLabel(rawReason);
  return {
    ...rest,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    ...(reason ? { reason } : {}),
    ...(payload.appointmentType
      ? {
          appointmentType: appointmentTypeLabel(payload.appointmentType),
          appointmentTypeCode: payload.appointmentType,
        }
      : {}),
  };
}

function accountSuspendedWire(
  payload: AccountSuspendedInput,
  timezone: string,
): AccountSuspendedPayload {
  const { suspendedUntil: raw, ...rest } = payload;
  const suspendedUntil = formatNotificationDateTime(raw, timezone);
  return {
    ...rest,
    suspendedUntil: suspendedUntil ?? "further notice",
    ...(suspendedUntil ? { suspendedUntilIso: raw } : {}),
    supportUrl: payload.supportUrl ?? `${getAppUrl()}/contactus`,
  };
}

function payoutWire(payload: PayoutInput): PayoutPayload {
  return {
    ...payload,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
  };
}

function disputeWire(payload: DisputeInput): DisputePayload {
  const { reason: rawReason, status: rawStatus, ...rest } = payload;
  const reason = disputeReasonLabel(rawReason);
  const status = disputeStatusLabel(rawStatus);
  return {
    ...rest,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    ...(reason ? { reason } : {}),
    ...(status ? { status } : {}),
  };
}

function referralCreditsAppliedWire(
  payload: ReferralCreditsAppliedInput,
): ReferralCreditsAppliedPayload {
  return {
    ...payload,
    creditsUsed: formatNotificationMoney(payload.creditsUsed, payload.currency),
    creditsUsedPaise: payload.creditsUsed,
    remainingCredits: formatNotificationMoney(
      payload.remainingCredits,
      payload.currency,
    ),
    remainingCreditsPaise: payload.remainingCredits,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
}

// ============================================================================
// Notification Senders
// ============================================================================

const W = NOVU_WORKFLOWS;

// Appointments
export const notifyAppointmentBooked = defineZonedMultiNotifier(
  W.APPOINTMENT_BOOKED,
  appointmentWire,
);
export const notifyAppointmentPartiallyScheduled = defineZonedMultiNotifier(
  W.APPOINTMENT_PARTIALLY_SCHEDULED,
  partiallyScheduledWire,
);
export const notifyAppointmentCancelled = defineZonedMultiNotifier(
  W.APPOINTMENT_CANCELLED,
  cancelledWire,
);
export const notifyAppointmentRescheduled = defineZonedMultiNotifier(
  W.APPOINTMENT_RESCHEDULED,
  rescheduledWire,
);
export const notifyAppointmentCompleted = defineZonedMultiNotifier(
  W.APPOINTMENT_COMPLETED,
  appointmentWire,
);
export const notifyAppointmentReminder = defineZonedMultiNotifier(
  W.APPOINTMENT_REMINDER,
  appointmentWire,
);

// Payments & Refunds
export const notifyPaymentLink = defineZonedSingleNotifier(
  W.PAYMENT_LINK,
  paymentLinkWire,
);
export const notifyPaymentSuccess = defineSingleNotifier(
  W.PAYMENT_SUCCESS,
  paymentSuccessWire,
);
export const notifyPaymentFailed = defineSingleNotifier(
  W.PAYMENT_FAILED,
  paymentFailedWire,
);
export const notifyRefundProcessed = defineSingleNotifier(
  W.REFUND_PROCESSED,
  refundWire,
);
export const notifyRefundFailed = defineSingleNotifier(
  W.REFUND_FAILED,
  refundWire,
);
export const notifyRefundRequested = defineMultiNotifier(
  W.REFUND_REQUESTED,
  refundWire,
);

// Support Tickets
export const notifySupportTicketCreated =
  defineMultiNotifier<SupportTicketPayload>(W.SUPPORT_TICKET_CREATED);
export const notifySupportTicketUpdate =
  defineSingleNotifier<SupportTicketPayload>(W.SUPPORT_TICKET_UPDATE);
export const notifySupportTicketActivity =
  defineMultiNotifier<SupportTicketPayload>(W.SUPPORT_TICKET_ACTIVITY);
export const notifySupportTicketResponse =
  defineSingleNotifier<SupportTicketPayload>(W.SUPPORT_TICKET_RESPONSE);

// Feedback & Reviews
export const notifyFeedbackReceived = defineMultiNotifier<FeedbackPayload>(
  W.FEEDBACK_RECEIVED,
);
export const notifyNewReview = defineSingleNotifier<ReviewPayload>(
  W.NEW_REVIEW_RECEIVED,
);

// Trials
/** A bell resolved before its transaction: recipient, zone and payload fixed, not yet staged. */
export type PreparedBell = Omit<StageTriggerArgs, "tx">;

/**
 * The trial-scheduled bells resolved before the caller's transaction: one
 * recipient read for the bell policy and zones, and no write.
 */
export async function prepareTrialScheduledBells(
  bells: ReadonlyArray<{ subscriberId: string; input: TrialInput }>,
): Promise<PreparedBell[]> {
  const workflowId = W.TRIAL_SESSION_SCHEDULED;
  const zones = await bellRecipientZones(
    workflowId,
    bells.map((bell) => bell.subscriberId),
  );
  return bells.flatMap(({ subscriberId, input }) => {
    const timezone = zones.get(subscriberId);
    if (timezone === undefined) return [];
    return [
      {
        workflowId,
        kind: "SINGLE" as const,
        recipients: [subscriberId],
        payload: trialWire(input, timezone),
      },
    ];
  });
}

/**
 * Stages prepared bells inside `tx` in one insert. With Novu unconfigured the
 * rows stay for the relay and none is returned to flush.
 */
export async function stagePreparedBells(
  tx: Pick<Tx, "notificationOutbox">,
  bells: PreparedBell[],
): Promise<StagedTrigger[]> {
  const staged = await stageTriggerBatch(tx, bells);
  if (bells.length > 0 && !isNovuConfigured()) {
    for (const workflowId of new Set(bells.map((bell) => bell.workflowId))) {
      reportNotConfigured(workflowId);
    }
    return [];
  }
  return staged;
}

export const notifyTrialCompleted = defineZonedMultiNotifier(
  W.TRIAL_SESSION_COMPLETED,
  trialWire,
);
export const notifyTrialCancelled = defineZonedMultiNotifier(
  W.TRIAL_SESSION_CANCELLED,
  trialWire,
);

// Subscriptions
export const notifySubscriptionStarted =
  defineSingleNotifier<SubscriptionPayload>(W.SUBSCRIPTION_STARTED);
export const notifySubscriptionRenewed =
  defineSingleNotifier<SubscriptionPayload>(W.SUBSCRIPTION_RENEWED);

// Consultant-Specific
export const notifyNewBookingRequest = defineZonedSingleNotifier(
  W.NEW_BOOKING_REQUEST,
  bookingRequestWire,
);
export const notifyUnscheduledSubscriptionNudge = defineZonedSingleNotifier<
  BookingRequestInput & { nudgeHours: number }
>(W.NEW_BOOKING_REQUEST, bookingRequestWire);
export const notifyRequestExpiringSoon = defineZonedSingleNotifier<
  BookingRequestInput & { expiresAt: string }
>(W.NEW_BOOKING_REQUEST, bookingRequestWire);
export const notifyUnplacedWeekNudge = defineZonedSingleNotifier<
  BookingRequestInput & { weekSummary: string }
>(W.NEW_BOOKING_REQUEST, bookingRequestWire);
export const notifyVerificationStatusChanged =
  defineSingleNotifier<VerificationPayload>(W.VERIFICATION_STATUS_CHANGED);
export const notifyModerationWarning =
  defineSingleNotifier<ModerationWarningPayload>(W.MODERATION_WARNING, (p) => ({
    ...p,
    supportUrl: p.supportUrl ?? `${getAppUrl()}/dashboard/go/auto/support`,
  }));
export const notifyAccountSuspended = defineZonedSingleNotifier(
  W.ACCOUNT_SUSPENDED,
  accountSuspendedWire,
);
export const notifyAccountBanned = defineSingleNotifier<AccountBannedPayload>(
  W.ACCOUNT_BANNED,
  (p) => ({
    ...p,
    supportUrl: p.supportUrl ?? `${getAppUrl()}/contactus`,
  }),
);
export const notifyPayoutProcessed = defineSingleNotifier(
  W.PAYOUT_PROCESSED,
  payoutWire,
);
export const notifyPayoutFailed = defineSingleNotifier(
  W.PAYOUT_FAILED,
  payoutWire,
);
export const notifyOrgExpertRemoved =
  defineSingleNotifier<OrgExpertRemovedPayload>(W.ORG_EXPERT_REMOVED, (p) => ({
    organizationId: p.organizationId ?? null,
    scope: "org",
    ...p,
  }));

// Admin / System
export const notifyNewConsultantApplication =
  defineMultiNotifier<ConsultantApplicationPayload>(
    W.NEW_CONSULTANT_APPLICATION,
  );

// Disputes
export const notifyDisputeCreated = defineMultiNotifier(
  W.DISPUTE_CREATED,
  disputeWire,
);
export const notifyDisputeResolved = defineMultiNotifier(
  W.DISPUTE_RESOLVED,
  disputeWire,
);

// Recordings
export const notifyRecordingAvailable = defineMultiNotifier<
  Omit<RecordingPayload, "appointmentTypeCode">
>(W.RECORDING_AVAILABLE, (p) => ({
  ...p,
  appointmentType: appointmentTypeLabel(p.appointmentType),
  appointmentTypeCode: p.appointmentType,
}));
export const notifyRecordingFailed =
  defineSingleNotifier<RecordingFailedPayload>(W.RECORDING_FAILED);
export const notifyRecordingRemoved =
  defineMultiNotifier<RecordingRemovedPayload>(W.RECORDING_REMOVED);

// Document Review
export const notifyDocumentUploaded =
  defineSingleNotifier<DocumentUploadedPayload>(W.DOCUMENT_UPLOADED);
export const notifyDocumentReviewed =
  defineSingleNotifier<DocumentReviewedPayload>(W.DOCUMENT_REVIEWED);

// Referrals
export const notifyReferralCreditsApplied = defineSingleNotifier(
  W.REFERRAL_CREDITS_APPLIED,
  referralCreditsAppliedWire,
);

export const notifyReferralBonusEarned =
  defineSingleNotifier<ReferralBonusEarnedInput>(
    W.REFERRAL_BONUS_EARNED,
    (p): ReferralBonusEarnedPayload => ({
      refereeName: p.refereeName,
      bonusAmount: formatNotificationMoney(
        p.bonusAmountPaise,
        p.currency ?? "INR",
      ),
      bonusAmountPaise: p.bonusAmountPaise,
      ...(p.currency ? { currency: p.currency } : {}),
      dashboardUrl: p.dashboardUrl,
    }),
  );

export const notifyRefereeWelcomeBonus =
  defineSingleNotifier<RefereeWelcomeBonusInput>(
    W.REFEREE_WELCOME_BONUS,
    (p): RefereeWelcomeBonusPayload => ({
      referrerName: p.referrerName,
      bonusAmount: formatNotificationMoney(
        p.bonusAmountPaise,
        p.currency ?? "INR",
      ),
      bonusAmountPaise: p.bonusAmountPaise,
      ...(p.currency ? { currency: p.currency } : {}),
      dashboardUrl: p.dashboardUrl,
    }),
  );

export function notifyAccountSecurityNotice(
  userIds: string | string[],
  payload: AccountSecurityNoticePayload,
  dedupeKeyOrOpts?: string | TriggerOptions,
  opts?: TriggerOptions,
): Promise<TriggerResult[]> {
  const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  return triggerForMultiple(
    W.ACCOUNT_SECURITY_NOTICE,
    ids,
    payload,
    r.dedupeKey,
    r.opts,
  );
}

// Compliance

export function notifyComplianceAlert(
  userIds: string | string[],
  payload: ComplianceAlertPayload,
  dedupeKeyOrOpts?: string | TriggerOptions,
  opts?: TriggerOptions,
): Promise<TriggerResult[]> {
  const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const formattedDue = payload.dueDate
    ? formatNotificationDateTime(payload.dueDate, DEFAULT_NOTIFICATION_TIMEZONE)
    : undefined;
  return triggerForMultiple(
    W.COMPLIANCE_DEADLINE_ALERT,
    ids,
    {
      ...payload,
      ...(formattedDue
        ? { dueDate: formattedDue, dueDateIso: payload.dueDate }
        : {}),
    },
    r.dedupeKey,
    r.opts,
  );
}
