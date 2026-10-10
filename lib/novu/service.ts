/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 */
import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "@/lib/prisma";
import { computeQuietHoursNotBefore } from "./quiet-hours";
import { getNovuClient, isNovuConfigured } from "./client";
import {
  attemptTrigger,
  deriveTransactionId,
  reportTriggerFailure,
  stageTrigger,
  type NovuPayload,
  type StageTriggerArgs,
  type TriggerResult,
} from "./outbox";
import { EMAIL_CATEGORY_COLUMN } from "@/lib/email/preferences";
import { templateFor, toWire } from "./templates";
import type { NovuWorkflowId, PreferenceCategory } from "./templates/types";
import {
  NOVU_WORKFLOWS,
  type AccountBannedPayload,
  type AccountSuspendedInput,
  type AccountSuspendedPayload,
  type AnnouncementPayload,
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
  type CollaboratorInvitedPayload,
  type CollaboratorRemovedPayload,
  type CollaboratorWithdrawnPayload,
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
  type PaymentSuccessInput,
  type PaymentSuccessPayload,
  type PayoutInput,
  type PayoutPayload,
  type RecordingFailedPayload,
  type RecordingPayload,
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
  /** Urgent workflows (payment/payout failure) bypass quiet-hours deferral. */
  deferrable?: boolean;
  /** Stage the outbox row and return without attempting inline delivery. */
  deferAttempt?: boolean;
}

const BELL_PREFERENCE_SELECT = {
  allNotifications: true,
  inAppEnabled: true,
  appointmentReminders: true,
  paymentNotifications: true,
  subscriptionAlerts: true,
  trialNotifications: true,
  supportUpdates: true,
  feedbackAlerts: true,
  orgBillingAlerts: true,
  orgMembershipAlerts: true,
  orgProgramAlerts: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  quietHoursTimezone: true,
} as const;

type BellUserRow = {
  id?: string;
  timezone?: string | null;
  orgWorkspaceProfile?: {
    notificationRoutingMode?:
      "BELL_AND_EMAIL" | "BELL_ONLY" | "EMAIL_ONLY" | "NEITHER" | null;
  } | null;
  notificationPreferences?: Partial<
    Record<keyof typeof BELL_PREFERENCE_SELECT, boolean | string | null>
  > | null;
};

function isBellAllowedForRecipient(
  row: BellUserRow | undefined,
  category: PreferenceCategory | null,
): boolean {
  if (!row) return true;
  const routingMode = row.orgWorkspaceProfile?.notificationRoutingMode;
  if (routingMode === "EMAIL_ONLY" || routingMode === "NEITHER") {
    return false;
  }
  const pref = row.notificationPreferences;
  if (!pref) return true;
  if (pref.allNotifications === false) return false;
  if (pref.inAppEnabled === false) return false;
  if (category !== null && pref[EMAIL_CATEGORY_COLUMN[category]] === false) {
    return false;
  }
  return true;
}

async function resolveRecipientBellPolicy(
  workflowId: NovuWorkflowId,
  recipients: string[],
  opts: TriggerOptions | undefined,
): Promise<{ allowedRecipients: string[]; notBefore: Date | undefined }> {
  if (recipients.length === 0) {
    return { allowedRecipients: recipients, notBefore: undefined };
  }
  try {
    const db = opts?.tx ?? prisma;
    const rows = (await db.user.findMany({
      where: { id: { in: recipients } },
      select: {
        id: true,
        timezone: true,
        orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
        notificationPreferences: { select: BELL_PREFERENCE_SELECT },
      },
    })) as BellUserRow[];

    const category = templateFor(workflowId)?.category ?? null;
    const byId = new Map<string, BellUserRow>();
    for (const row of rows) {
      if (typeof row.id === "string") byId.set(row.id, row);
    }

    const allowedRecipients = recipients.filter((id) =>
      isBellAllowedForRecipient(byId.get(id), category),
    );
    if (allowedRecipients.length === 0 || opts?.deferrable === false) {
      return { allowedRecipients, notBefore: undefined };
    }

    const allowedSet = new Set(allowedRecipients);
    const now = new Date();
    let latest: Date | undefined;
    for (const row of rows) {
      if (typeof row.id === "string" && !allowedSet.has(row.id)) continue;
      const pref = row.notificationPreferences;
      if (!pref?.quietHoursEnabled) continue;
      const notBefore = computeQuietHoursNotBefore(
        {
          quietHoursEnabled: true,
          quietHoursStart:
            typeof pref.quietHoursStart === "string"
              ? pref.quietHoursStart
              : null,
          quietHoursEnd:
            typeof pref.quietHoursEnd === "string" ? pref.quietHoursEnd : null,
          quietHoursTimezone:
            typeof pref.quietHoursTimezone === "string"
              ? pref.quietHoursTimezone
              : null,
          fallbackTimezone: row.timezone ?? null,
        },
        now,
      );
      if (notBefore && (!latest || notBefore > latest)) latest = notBefore;
    }
    return { allowedRecipients, notBefore: latest };
  } catch {
    return { allowedRecipients: recipients, notBefore: undefined };
  }
}

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
): Promise<TriggerResult> {
  const policy =
    args.kind === "BROADCAST"
      ? { allowedRecipients: args.recipients, notBefore: undefined }
      : await resolveRecipientBellPolicy(
          args.workflowId,
          args.recipients,
          opts,
        );
  if (args.kind !== "BROADCAST" && policy.allowedRecipients.length === 0) {
    return { success: true };
  }
  const effectiveArgs = { ...args, recipients: policy.allowedRecipients };
  const notBefore = effectiveArgs.notBefore ?? policy.notBefore;
  const staged = await stageTrigger({
    ...effectiveArgs,
    ...(notBefore && { notBefore }),
    ...opts,
  });
  if (!isNovuConfigured()) {
    reportNotConfigured(effectiveArgs.workflowId);
    return { success: false, error: "Novu not configured" };
  }
  if (!staged) {
    if (notBefore && notBefore.getTime() > Date.now()) {
      return {
        success: false,
        error: "Stage failed; quiet-hours notice not sent",
      };
    }
    return sendUnstaged(effectiveArgs);
  }
  if (opts?.tx || opts?.deferAttempt) return { success: true, staged };
  return attemptTrigger(staged);
}

async function sendUnstaged(
  args: Omit<StageTriggerArgs, "tx" | "entityRef">,
): Promise<TriggerResult> {
  const transactionId = deriveTransactionId(
    args.workflowId,
    args.kind === "BROADCAST" ? [] : args.recipients,
    args.payload,
    args.dedupeKey,
  );
  try {
    const novu = getNovuClient();
    const wire = toWire(args.workflowId, args.payload);
    if (args.kind === "BROADCAST") {
      await novu.triggerBroadcast(
        { name: wire.workflowId, payload: wire.payload, transactionId },
        transactionId,
      );
    } else {
      await novu.trigger(
        {
          workflowId: wire.workflowId,
          to: args.kind === "SINGLE" ? args.recipients[0] : args.recipients,
          payload: wire.payload,
          transactionId,
        },
        transactionId,
      );
    }
    return { success: true };
  } catch (error) {
    if (
      reportTriggerFailure(error, args.workflowId, args.recipients.length)
        .accepted
    ) {
      return { success: true };
    }
    return {
      success: false,
      error: error instanceof Error ? error : String(error),
    };
  }
}

export async function triggerWorkflow<T extends NovuPayload>(
  workflowId: NovuWorkflowId,
  subscriberId: string,
  payload: T,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  return stageAndAttempt(
    {
      workflowId,
      kind: "SINGLE",
      recipients: [subscriberId],
      payload,
      dedupeKey,
    },
    opts,
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

  const BATCH_SIZE = 100;
  const results: TriggerResult[] = [];
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    const result = await stageAndAttempt(
      { workflowId, kind: "MULTI", recipients: batch, payload, dedupeKey },
      opts,
    );
    results.push(...batch.map(() => result));
  }
  return results;
}

async function triggerBroadcastWorkflow<T extends NovuPayload>(
  workflowId: NovuWorkflowId,
  payload: T,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  return stageAndAttempt(
    { workflowId, kind: "BROADCAST", recipients: [], payload },
    opts,
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
  const { oldDateTime: rawOld, newDateTime: rawNew, ...base } = input;
  const oldDateTime = formatNotificationDateTime(rawOld, timezone);
  const hasDestination =
    input.outcome === "MOVED" || input.outcome === "PROPOSED";
  const newDateTimeIso = hasDestination ? rawNew : undefined;
  const newDateTime = formatNotificationDateTime(newDateTimeIso, timezone);
  return {
    ...appointmentWire(base, timezone),
    outcome: input.outcome,
    ...(oldDateTime ? { oldDateTime, oldDateTimeIso: rawOld } : {}),
    newDateTime: newDateTime ?? RESCHEDULE_AWAITING_TIME[input.outcome],
    ...(newDateTime ? { newDateTimeIso } : {}),
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
export const notifySubscriptionCancelled =
  defineMultiNotifier<SubscriptionPayload>(W.SUBSCRIPTION_CANCELLED);
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
export const notifyVerificationStatusChanged =
  defineSingleNotifier<VerificationPayload>(W.VERIFICATION_STATUS_CHANGED);
export const notifyModerationWarning =
  defineSingleNotifier<ModerationWarningPayload>(W.MODERATION_WARNING);
export const notifyAccountSuspended = defineZonedSingleNotifier(
  W.ACCOUNT_SUSPENDED,
  accountSuspendedWire,
);
export const notifyAccountBanned = defineSingleNotifier<AccountBannedPayload>(
  W.ACCOUNT_BANNED,
);
export const notifyPayoutProcessed = defineSingleNotifier(
  W.PAYOUT_PROCESSED,
  payoutWire,
);
export const notifyPayoutFailed = defineSingleNotifier(
  W.PAYOUT_FAILED,
  ({ payoutId: _id, ...rest }: PayoutInput) => payoutWire(rest),
  { deferrable: false },
);
export const notifyOrgExpertRemoved =
  defineSingleNotifier<OrgExpertRemovedPayload>(W.ORG_EXPERT_REMOVED, (p) => ({
    organizationId: p.organizationId ?? null,
    scope: "org",
    ...p,
  }));

// Admin / System
export const notifyGeneralAnnouncement =
  defineBroadcastNotifier<AnnouncementPayload>(W.GENERAL_ANNOUNCEMENT);
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

// Maintenance
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
