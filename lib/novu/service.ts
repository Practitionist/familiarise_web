/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 */
import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { isNovuConfigured } from "./client";
import {
  attemptTrigger,
  INLINE_BELL_ATTEMPT_LIMIT,
  stageTrigger,
  type NovuPayload,
  type StageTriggerArgs,
  type TriggerResult,
  type StagedTrigger,
} from "./outbox";
import { stageBells, type StageBellTx } from "./stage-bell";
import type { NovuWorkflowId } from "./templates/types";
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
  type CollaboratorAcceptedPayload,
  type CollaboratorDeclinedPayload,
  type CollaboratorInviteExpiredPayload,
  type CollaboratorInvitedPayload,
  type CollaboratorRemovedPayload,
  type CollaboratorWithdrawnPayload,
  type ComplianceAlertPayload,
  type ConsultantApplicationPayload,
  type DisputeInput,
  type DisputePayload,
  type DocumentReviewedPayload,
  type DocumentUploadedPayload,
  type FeedbackPayload,
  type MaintenanceInput,
  type MaintenancePayload,
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
  /** Urgent workflows (payment/payout failure) bypass quiet-hours deferral. */
  deferrable?: boolean;
  /** Stage the outbox row and return without attempting inline delivery. */
  deferAttempt?: boolean;
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

/** The relay owns the remaining rows; the request fast path starts at most five calls. */
async function attemptPreparedRows(
  rows: StagedTrigger[],
): Promise<TriggerResult[]> {
  if (rows.length === 0) return [];
  if (!isNovuConfigured()) {
    reportNotConfigured(rows[0].workflowId);
    return rows.map((staged) => ({
      success: false,
      error: "Novu not configured",
      staged,
    }));
  }
  const attempted = await Promise.all(
    rows
      .slice(0, INLINE_BELL_ATTEMPT_LIMIT)
      .map((row) => attemptTrigger(row, { suppressSentry: true })),
  );
  const failures = attempted.filter((result) => !result.success);
  if (failures.length > 0) {
    Sentry.captureException(new Error("Inline notification fan-out failed"), {
      tags: { subsystem: "novu", op: "inline-attempt" },
      extra: { failedRecipients: failures.length },
    });
  }
  return [
    ...attempted,
    ...rows
      .slice(INLINE_BELL_ATTEMPT_LIMIT)
      .map((staged) => ({ success: true, staged })),
  ];
}

async function stageAndAttempt(
  args: Omit<StageTriggerArgs, "tx" | "entityRef">,
  opts: TriggerOptions | undefined,
): Promise<TriggerResult[]> {
  const prepare = async (db: StageBellTx): Promise<StagedTrigger[]> => {
    if (args.kind === "BROADCAST") {
      const row = await stageTrigger({
        ...args,
        entityRef: opts?.entityRef,
        tx: db,
      });
      if (!row) throw new Error("Unable to stage broadcast notification");
      return [row];
    }
    return stageBells(db, {
      ...args,
      entityRef: opts?.entityRef,
      deferrable: opts?.deferrable,
    });
  };
  let rows: StagedTrigger[];
  try {
    rows = opts?.tx
      ? await prepare(opts.tx)
      : await prisma.$transaction(prepare, { timeout: 15_000 });
  } catch (error) {
    if (opts?.tx) throw error;
    console.error(`[Novu] ${args.workflowId} staging unavailable`, error);
    if (!opts?.deferAttempt)
      Sentry.captureException(new Error("Notification staging failed"), {
        tags: { subsystem: "novu", op: "stage" },
      });
    return [
      { success: false, error: error instanceof Error ? error : String(error) },
    ];
  }
  if (opts?.tx || opts?.deferAttempt)
    return rows.map((staged) => ({ success: true, staged }));
  return attemptPreparedRows(rows);
}

export async function triggerWorkflow<T extends NovuPayload>(
  workflowId: NovuWorkflowId,
  subscriberId: string,
  payload: T,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  return (
    (
      await stageAndAttempt(
        {
          workflowId,
          kind: "SINGLE",
          recipients: [subscriberId],
          payload,
          dedupeKey,
        },
        opts,
      )
    )[0] ?? { success: true }
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
  if (userIds.length === 1)
    return [
      await triggerWorkflow(workflowId, userIds[0], payload, dedupeKey, opts),
    ];

  const recipients = [...new Set(userIds)];
  const BATCH_SIZE = 100;
  const results: TriggerResult[] = [];
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const prepared = await stageAndAttempt(
      { workflowId, kind: "MULTI", recipients: batch, payload, dedupeKey },
      { ...opts, deferAttempt: true },
    );
    results.push(...prepared);
  }
  if (opts?.tx || opts?.deferAttempt) return results;
  reportPreparationFailures(results);
  const staged = results.flatMap((result) =>
    result.staged ? [result.staged] : [],
  );
  return [
    ...results.filter((result) => !result.staged),
    ...(await attemptPreparedRows(staged)),
  ];
}

function reportPreparationFailures(results: TriggerResult[]): void {
  const failures = results.filter(
    (result) => !result.success && !result.staged,
  );
  if (failures.length > 0)
    Sentry.captureException(new Error("Notification staging failed"), {
      tags: { subsystem: "novu", op: "stage" },
      extra: { failedBatches: failures.length },
    });
}

async function triggerBroadcastWorkflow<T extends NovuPayload>(
  workflowId: NovuWorkflowId,
  payload: T,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  return (
    (
      await stageAndAttempt(
        { workflowId, kind: "BROADCAST", recipients: [], payload },
        opts,
      )
    )[0] ?? { success: true }
  );
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
        { ...opts, deferAttempt: true },
      )),
    );
  }
  if (opts?.tx || opts?.deferAttempt) return results;
  reportPreparationFailures(results);
  const staged = results.flatMap((result) =>
    result.staged ? [result.staged] : [],
  );
  return [
    ...results.filter((result) => !result.staged),
    ...(await attemptPreparedRows(staged)),
  ];
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
  defaultOpts?: TriggerOptions,
): { dedupeKey: string | undefined; opts: TriggerOptions | undefined } {
  const dedupeKey =
    typeof dedupeKeyOrOpts === "string" ? dedupeKeyOrOpts : undefined;
  const callerOpts =
    typeof dedupeKeyOrOpts === "string" ? opts : dedupeKeyOrOpts;
  const mergedOpts =
    defaultOpts && callerOpts
      ? { ...defaultOpts, ...callerOpts }
      : (callerOpts ?? defaultOpts);
  return { dedupeKey, opts: mergedOpts };
}

function defineSingleNotifier<TInput>(
  workflowId: NovuWorkflowId,
  mapPayload: (input: TInput) => NovuPayload = (p) => p as NovuPayload,
  defaultOpts?: TriggerOptions,
) {
  return (
    subscriberId: string,
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts, defaultOpts);
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
  defaultOpts?: TriggerOptions,
) {
  return (
    userIds: string[],
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult[]> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts, defaultOpts);
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
  defaultOpts?: TriggerOptions,
) {
  return (
    subscriberId: string,
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts, defaultOpts);
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
  defaultOpts?: TriggerOptions,
) {
  return (
    userIds: string[],
    payload: TInput,
    dedupeKeyOrOpts?: string | TriggerOptions,
    opts?: TriggerOptions,
  ): Promise<TriggerResult[]> => {
    const r = resolveTriggerArgs(dedupeKeyOrOpts, opts, defaultOpts);
    return triggerForMultipleZoned(
      workflowId,
      userIds,
      (tz) => mapPayload(payload, tz),
      r.dedupeKey,
      r.opts,
    );
  };
}

function defineBroadcastNotifier<TInput>(
  workflowId: NovuWorkflowId,
  mapPayload: (input: TInput) => NovuPayload = (p) => p as NovuPayload,
) {
  return (payload: TInput, opts?: TriggerOptions): Promise<TriggerResult> =>
    triggerBroadcastWorkflow(workflowId, mapPayload(payload), opts);
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
    clash,
    ...base
  } = input;
  const oldDateTime = formatNotificationDateTime(rawOld, timezone);
  const hasDestination =
    input.outcome === "MOVED" || input.outcome === "PROPOSED";
  const newDateTimeIso = hasDestination ? rawNew : undefined;
  const newDateTime = formatNotificationDateTime(newDateTimeIso, timezone);
  const leaveBy = formatNotificationDateTime(rawLeaveBy, timezone);
  return {
    ...appointmentWire(base, timezone),
    outcome: input.outcome,
    ...(oldDateTime ? { oldDateTime, oldDateTimeIso: rawOld } : {}),
    newDateTime: newDateTime ?? RESCHEDULE_AWAITING_TIME[input.outcome],
    ...(newDateTime ? { newDateTimeIso } : {}),
    ...(leaveBy ? { leaveBy, leaveByIso: rawLeaveBy } : {}),
    ...(clash ? { clash } : {}),
  };
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
  const { requestedDateTime: rawRequested, ...rest } = input;
  const requestedDateTime = formatNotificationDateTime(rawRequested, timezone);
  return {
    ...rest,
    appointmentType: appointmentTypeLabel(input.appointmentType),
    appointmentTypeCode: input.appointmentType,
    ...(requestedDateTime
      ? { requestedDateTime, requestedDateTimeIso: rawRequested }
      : {}),
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

function maintenanceWire(payload: MaintenanceInput): MaintenancePayload {
  const { estimatedEnd: raw, ...rest } = payload;
  const estimatedEnd = formatNotificationDateTime(
    raw,
    DEFAULT_NOTIFICATION_TIMEZONE,
  );
  return {
    ...rest,
    ...(estimatedEnd ? { estimatedEnd, estimatedEndIso: raw } : {}),
    statusUrl: payload.statusUrl ?? `${getAppUrl()}/maintenance`,
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
export const notifyTrialRequested = defineZonedSingleNotifier(
  W.TRIAL_SESSION_REQUESTED,
  trialWire,
);
export const notifyTrialScheduled = defineZonedSingleNotifier(
  W.TRIAL_SESSION_SCHEDULED,
  trialWire,
);
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
  { deferrable: false },
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

// Collaborators
export const notifyCollaboratorInvited =
  defineSingleNotifier<CollaboratorInvitedPayload>(W.COLLABORATOR_INVITED);
export const notifyCollaboratorAccepted =
  defineSingleNotifier<CollaboratorAcceptedPayload>(W.COLLABORATOR_ACCEPTED);
export const notifyCollaboratorDeclined =
  defineSingleNotifier<CollaboratorDeclinedPayload>(W.COLLABORATOR_DECLINED);
export const notifyCollaboratorRemoved =
  defineSingleNotifier<CollaboratorRemovedPayload>(W.COLLABORATOR_REMOVED);
export const notifyCollaboratorWithdrawn =
  defineSingleNotifier<CollaboratorWithdrawnPayload>(W.COLLABORATOR_WITHDRAWN);

export function notifyCollaboratorInviteExpired(
  userIds: string | string[],
  payload: CollaboratorInviteExpiredPayload,
  dedupeKeyOrOpts?: string | TriggerOptions,
  opts?: TriggerOptions,
): Promise<TriggerResult[]> {
  const r = resolveTriggerArgs(dedupeKeyOrOpts, opts);
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  return triggerForMultiple(
    W.COLLABORATOR_INVITE_EXPIRED,
    ids,
    payload,
    r.dedupeKey,
    r.opts,
  );
}

// Maintenance & Compliance
export const notifyMaintenanceScheduled = defineBroadcastNotifier(
  W.MAINTENANCE_SCHEDULED,
  maintenanceWire,
);
export const notifyMaintenanceStarted = defineBroadcastNotifier(
  W.MAINTENANCE_STARTED,
  maintenanceWire,
);
export const notifyMaintenanceEnded = defineBroadcastNotifier(
  W.MAINTENANCE_ENDED,
  maintenanceWire,
);

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
