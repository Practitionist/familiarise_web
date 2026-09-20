/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 * Pattern follows lib/email/deliver.ts (graceful degradation).
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
import { toWire } from "./templates";
import type { NovuWorkflowId } from "./templates/types";
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
  type RecordingExpiringInput,
  type RecordingExpiringPayload,
  type RecordingFailedPayload,
  type RecordingPayload,
  type RefereeWelcomeBonusInput,
  type RefereeWelcomeBonusPayload,
  type ReferralBonusInput,
  type ReferralBonusPayload,
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
  formatNotificationAmountBare,
  formatNotificationDateTime,
  formatNotificationMoney,
  groupRecipientsByTimezone,
  resolveRecipientTimezones,
} from "./humanize";

// ============================================================================
// Core trigger function
// ============================================================================

/**
 * #1654 — every trigger is stage + attempt (lib/novu/outbox.ts): the
 * NotificationOutbox row is written first, then one inline attempt runs under
 * the client's timeout, and the drain finishes whatever that left PENDING.
 * With `tx` the row is staged in the caller's transaction and only staged:
 * the result carries `staged` for `attemptTrigger` after the commit.
 */
export interface TriggerOptions {
  // #691 — "membership" too, so the org roster reads through the same tx
  // (PG_POOL_MAX=1 deadlocks a global-client read inside an open transaction).
  // #1697 item 5 — "user" too: the recipient-timezone read must ride the
  // caller's transaction for the same single-connection reason.
  // Quiet-hours reads ride it too (via the `user` → `notificationPreferences`
  // include in resolveQuietHoursNotBefore, so no extra delegate is needed).
  tx?: Pick<Tx, "notificationOutbox" | "membership" | "user">;
  entityRef?: string;
  /**
   * Urgent workflows (payment failure) bypass quiet-hours deferral entirely:
   * no `notBefore` is stamped, so every path — inline, post-commit, drain —
   * sends immediately. Defaults true (routine product notices defer).
   */
  deferrable?: boolean;
}

/**
 * Q3 fix — quiet-hours deferral. Loads each recipient's quiet-hours config
 * (riding the caller's tx when one is open, per the PG_POOL_MAX=1 note above)
 * and returns the latest window-end, so a batch waits until every recipient
 * is out of quiet hours. BROADCAST has no recipients and is never deferred.
 * Never throws: on any failure returns undefined (send ASAP).
 */
async function resolveQuietHoursNotBefore(
  recipients: string[],
  opts: TriggerOptions | undefined,
): Promise<Date | undefined> {
  if (recipients.length === 0) return undefined;
  try {
    const db = opts?.tx ?? prisma;
    const rows = await db.user.findMany({
      where: { id: { in: recipients } },
      select: {
        timezone: true,
        notificationPreferences: {
          select: {
            quietHoursEnabled: true,
            quietHoursStart: true,
            quietHoursEnd: true,
            quietHoursTimezone: true,
          },
        },
      },
    });
    const now = new Date();
    let latest: Date | undefined;
    for (const row of rows) {
      const pref = row.notificationPreferences;
      if (!pref?.quietHoursEnabled) continue;
      const notBefore = computeQuietHoursNotBefore(
        {
          quietHoursEnabled: true,
          quietHoursStart: pref.quietHoursStart,
          quietHoursEnd: pref.quietHoursEnd,
          quietHoursTimezone: pref.quietHoursTimezone,
          fallbackTimezone: row.timezone,
        },
        now,
      );
      if (notBefore && (!latest || notBefore > latest)) latest = notBefore;
    }
    return latest;
  } catch {
    return undefined;
  }
}

// Unconfigured Novu in a deployed env means notifications silently vanish —
// a console.warn nobody reads is not enough. Local dev stays console-only.
// #1654 — the row is still staged, so the relay delivers once configured.
function reportNotConfigured(workflowId: string): void {
  console.warn(`[Novu] Not configured. Staged only: ${workflowId}`);
  if (process.env.NODE_ENV === "production") {
    Sentry.captureMessage(`[Novu] Not configured — staged ${workflowId}`, {
      level: "warning",
      tags: { subsystem: "novu" },
    });
  }
}

/** Stage, then attempt unless the caller's transaction owns the commit. */
async function stageAndAttempt(
  args: Omit<StageTriggerArgs, "tx" | "entityRef">,
  opts: TriggerOptions | undefined,
): Promise<TriggerResult> {
  // Q3: stamp quiet-hours deferral before staging. An explicit notBefore from
  // the caller wins; otherwise defer to the latest recipient window-end
  // (one row carries one floor, so a group notice waits until every
  // recipient is out of quiet hours rather than waking some of them).
  // Non-deferrable (urgent) workflows skip the computation entirely.
  const notBefore =
    args.notBefore ??
    (opts?.deferrable === false || args.kind === "BROADCAST"
      ? undefined
      : await resolveQuietHoursNotBefore(args.recipients, opts));
  const staged = await stageTrigger({
    ...args,
    ...(notBefore && { notBefore }),
    ...opts,
  });
  if (!isNovuConfigured()) {
    reportNotConfigured(args.workflowId);
    return { success: false, error: "Novu not configured" };
  }
  if (!staged) {
    // Staging failed outside a transaction. A quiet-hours floor lives only in
    // the row, so a deferred notice has nowhere to wait: fail closed rather
    // than wake the recipient early (stageTrigger already reported to Sentry).
    if (notBefore && notBefore.getTime() > Date.now()) {
      return {
        success: false,
        error: "Stage failed; quiet-hours notice not sent",
      };
    }
    // Otherwise send-first, as before #1654, so a database hiccup does not
    // also drop the bell.
    return sendUnstaged(args);
  }
  if (opts?.tx) return { success: true, staged };
  // attemptTrigger holds future-notBefore rows for the drain (single
  // enforcement point — covers inline and post-commit attempts alike).
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
      await novu.triggerBroadcast({
        name: wire.workflowId,
        payload: wire.payload,
        transactionId,
      });
    } else {
      await novu.trigger({
        workflowId: wire.workflowId,
        to: args.kind === "SINGLE" ? args.recipients[0] : args.recipients,
        payload: wire.payload,
        transactionId,
      });
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

/**
 * Helper to trigger the same workflow for multiple users (e.g. both parties).
 * Uses a single API call with array `to` field (max 100 per call).
 */
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

/**
 * Trigger a broadcast workflow to all existing subscribers.
 * Uses Novu's triggerBroadcast API — no need to fetch user IDs.
 */
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

// ============================================================================
// Customer-ready payloads (#536)
// ============================================================================

/**
 * Trigger once per distinct recipient timezone.
 *
 * `triggerForMultiple` sends ONE payload to a list of subscribers, so a
 * rendered date inside it can only be correct for whichever recipient happens
 * to share the zone it was rendered in. Every other recipient reads a time that
 * is not theirs. Splitting on the zone is cheaper than it looks: both parties
 * to a booking are usually in the same zone, so this is one trigger in the
 * common case and two in the cross-border one.
 *
 * The zones are loaded in a single query; see `resolveRecipientTimezones` for
 * why that read is bounded and never throws. The zone only shapes the rendered
 * payload; nothing here defers the send, so the row's `notBefore` stays null.
 */
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

/** Single-recipient sibling of {@link triggerForMultipleZoned}. */
export async function triggerWorkflowZoned(
  workflowId: NovuWorkflowId,
  subscriberId: string,
  build: (timezone: string) => NovuPayload,
  dedupeKey?: string,
  opts?: TriggerOptions,
): Promise<TriggerResult> {
  const zones = await resolveRecipientTimezones([subscriberId]);
  const timezone = zones.get(subscriberId) ?? DEFAULT_NOTIFICATION_TIMEZONE;
  return triggerWorkflow(
    workflowId,
    subscriberId,
    build(timezone),
    dedupeKey,
    opts,
  );
}

/** Raw enum in, sentence label plus the original out. */
function appointmentWire(
  input: AppointmentPayloadInput,
  timezone: string,
): AppointmentPayload {
  // The raw instant is lifted out BEFORE the spread: the templates gate on
  // `{{#if payload.dateTime}}`, which any non-empty string satisfies, so a
  // value the formatter rejects must not ride through under the display key.
  // Omitted rather than blanked for the same reason.
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

/**
 * #1085 — what fills `newDateTime` when the outcome has no destination time.
 *
 * The `appointment-rescheduled` template renders "from X to Y" unconditionally,
 * and three of the five outcomes have no Y, which is how the inbox came to show
 * "rescheduled the CONSULTATION for Basic Consultation from&nbsp;&nbsp;to". A
 * phrase completes the sentence in every case. The MOVED and PROPOSED entries
 * are reachable only if a stored instant fails to parse, which would otherwise
 * reintroduce the blank.
 */
const RESCHEDULE_AWAITING_TIME: Record<
  RescheduleOutcomeFields["outcome"],
  string
> = {
  MOVED: "a new time your consultant will confirm",
  PROPOSED: "a new time your consultant will confirm",
  RELEASED: "a new time your consultant will confirm",
  DECLINED: "the time it was already booked for",
  WITHDRAWN: "the time it was already booked for",
};

function rescheduledWire(
  input: AppointmentRescheduledInput,
  timezone: string,
): AppointmentRescheduledPayload {
  // Both raw instants leave the input before it reaches `appointmentWire`, so
  // neither can survive that spread unformatted.
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

// ============================================================================
// Appointment Notifications
// ============================================================================

export async function notifyAppointmentBooked(
  userIds: string[],
  payload: AppointmentPayloadInput,
  opts?: TriggerOptions,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_BOOKED,
    userIds,
    (timezone) => appointmentWire(payload, timezone),
    undefined,
    opts,
  );
}

/**
 * #1206 — sent to the CONSULTEE only. The consultant already knows: they were
 * shown "only N of M fit" and confirmed it. This is the half of that exchange
 * the consultee never saw.
 */
export async function notifyAppointmentPartiallyScheduled(
  userIds: string[],
  payload: AppointmentPartiallyScheduledInput,
  opts?: TriggerOptions,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_PARTIALLY_SCHEDULED,
    userIds,
    (timezone) => partiallyScheduledWire(payload, timezone),
    undefined,
    opts,
  );
}

export async function notifyAppointmentCancelled(
  userIds: string[],
  payload: AppointmentCancelledInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
    userIds,
    (timezone) => cancelledWire(payload, timezone),
  );
}

export async function notifyAppointmentRescheduled(
  userIds: string[],
  payload: AppointmentRescheduledInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED,
    userIds,
    (timezone) => rescheduledWire(payload, timezone),
  );
}

export async function notifyAppointmentCompleted(
  userIds: string[],
  payload: AppointmentPayloadInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_COMPLETED,
    userIds,
    (timezone) => appointmentWire(payload, timezone),
  );
}

// `dedupeKey` (appointment + window) keeps the 1h reminder from being
// swallowed as a duplicate of the 24h one — their payloads are identical.
export async function notifyAppointmentReminder(
  userIds: string[],
  payload: AppointmentPayloadInput,
  dedupeKey?: string,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_REMINDER,
    userIds,
    (timezone) => appointmentWire(payload, timezone),
    dedupeKey,
  );
}

// ============================================================================
// Payment Notifications
// ============================================================================

export async function notifyPaymentSuccess(
  userId: string,
  payload: PaymentSuccessInput,
) {
  const wire: PaymentSuccessPayload = {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerWorkflow(NOVU_WORKFLOWS.PAYMENT_SUCCESS, userId, wire);
}

export async function notifyPaymentFailed(
  userId: string,
  payload: PaymentFailedInput,
  opts?: TriggerOptions,
) {
  const wire: PaymentFailedPayload = {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYMENT_FAILED,
    userId,
    wire,
    undefined,
    opts,
  );
}

/**
 * Paise become money before the payer reads them. `amount` is symbol-free
 * because `refund-processed` and `refund-requested` print `{{currency}}`
 * themselves; `refund-failed` shares this payload type and so shares its shape,
 * which is the point — one type cannot mean two things depending on which
 * workflow happens to carry it.
 */
function refundWire(payload: RefundInput): RefundPayload {
  return {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    ...(payload.appointmentType
      ? {
          appointmentType: appointmentTypeLabel(payload.appointmentType),
          appointmentTypeCode: payload.appointmentType,
        }
      : {}),
  };
}

export async function notifyRefundProcessed(
  userId: string,
  payload: RefundInput,
  opts?: TriggerOptions,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFUND_PROCESSED,
    userId,
    refundWire(payload),
    undefined,
    opts,
  );
}

// #779 §A — the gateway rejected a refund (Refund.status = FAILED). Notifies
// the payer; `reason` on the payload carries the gateway failure reason.
export async function notifyRefundFailed(userId: string, payload: RefundInput) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFUND_FAILED,
    userId,
    refundWire(payload),
  );
}

export async function notifyRefundRequested(
  adminUserIds: string[],
  payload: RefundInput,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.REFUND_REQUESTED,
    adminUserIds,
    refundWire(payload),
  );
}

// ============================================================================
// Support Ticket Notifications
// ============================================================================

export async function notifySupportTicketCreated(
  staffUserIds: string[],
  payload: SupportTicketPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUPPORT_TICKET_CREATED,
    staffUserIds,
    payload,
  );
}

export async function notifySupportTicketUpdate(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE, userId, payload);
}

/**
 * #705 — the ops side of a ticket: the customer replied or reopened, fanned
 * out to the assignee or the whole queue. Its own workflow, not the owner's
 * SUPPORT_TICKET_UPDATE, so staff can digest it later without touching the
 * customer's bell.
 */
export async function notifySupportTicketActivity(
  staffUserIds: string[],
  payload: SupportTicketPayload,
  dedupeKey?: string,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
    staffUserIds,
    payload,
    dedupeKey,
  );
}

export async function notifySupportTicketResponse(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUPPORT_TICKET_RESPONSE,
    userId,
    payload,
  );
}

// ============================================================================
// Feedback & Review Notifications
// ============================================================================

export async function notifyFeedbackReceived(
  adminUserIds: string[],
  payload: FeedbackPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.FEEDBACK_RECEIVED,
    adminUserIds,
    payload,
  );
}

export async function notifyNewReview(
  consultantUserId: string,
  payload: ReviewPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.NEW_REVIEW_RECEIVED,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Trial Session Notifications
// ============================================================================

export async function notifyTrialRequested(
  consultantUserId: string,
  payload: TrialInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_REQUESTED,
    consultantUserId,
    (timezone) => trialWire(payload, timezone),
  );
}

export async function notifyTrialScheduled(
  consulteeUserId: string,
  payload: TrialInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_SCHEDULED,
    consulteeUserId,
    (timezone) => trialWire(payload, timezone),
  );
}

export async function notifyTrialCompleted(
  userIds: string[],
  payload: TrialInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_COMPLETED,
    userIds,
    (timezone) => trialWire(payload, timezone),
  );
}

export async function notifyTrialCancelled(
  userIds: string[],
  payload: TrialInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_CANCELLED,
    userIds,
    (timezone) => trialWire(payload, timezone),
  );
}

// ============================================================================
// Subscription Notifications
// ============================================================================

export async function notifySubscriptionStarted(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUBSCRIPTION_STARTED, userId, payload);
}

export async function notifySubscriptionCancelled(
  userIds: string[],
  payload: SubscriptionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUBSCRIPTION_CANCELLED,
    userIds,
    payload,
  );
}

/**
 * #1766 — staged from the completion path when a cycle's last live session
 * completes with entitlement left; `dedupeKey` is `sub:<id>:cycle:<ordinal>`
 * so a second completion pass over the same state reuses the outbox row.
 */
export async function notifySubscriptionRenewed(
  userId: string,
  payload: SubscriptionPayload,
  dedupeKey?: string,
  opts?: TriggerOptions,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUBSCRIPTION_RENEWED,
    userId,
    payload,
    dedupeKey,
    opts,
  );
}

// ============================================================================
// Consultant-Specific Notifications
// ============================================================================

export async function notifyNewBookingRequest(
  consultantUserId: string,
  payload: BookingRequestInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
    consultantUserId,
    (timezone) => bookingRequestWire(payload, timezone),
  );
}

/**
 * #1703 — a paid subscription still without session times, nudged at day 3,
 * 7 and 14. Rides the new-booking-request event with `nudgeDay`; the
 * dedupe key makes each stage exactly-once through the outbox.
 */
export async function notifyUnscheduledSubscriptionNudge(
  consultantUserId: string,
  payload: BookingRequestInput & { nudgeDay: number },
  dedupeKey: string,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
    consultantUserId,
    (timezone) => bookingRequestWire(payload, timezone),
    dedupeKey,
  );
}

export async function notifyVerificationStatusChanged(
  consultantUserId: string,
  payload: VerificationPayload,
  opts?: TriggerOptions,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.VERIFICATION_STATUS_CHANGED,
    consultantUserId,
    payload,
    undefined,
    opts,
  );
}

// Moderation (#693) — fire-and-forget; callers run these in the best-effort
// phase, never inside the moderation transaction.
export async function notifyModerationWarning(
  targetUserId: string,
  payload: ModerationWarningPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.MODERATION_WARNING,
    targetUserId,
    payload,
  );
}

export async function notifyAccountSuspended(
  targetUserId: string,
  payload: AccountSuspendedInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.ACCOUNT_SUSPENDED,
    targetUserId,
    (timezone): AccountSuspendedPayload => {
      // An indefinite suspension has no `banExpires`, and the moderation
      // caller sends "" for it — the sentence reads "until {{suspendedUntil}}",
      // so the blank needs words, and the ISO twin is only sent for a real date.
      const { suspendedUntil: raw, ...rest } = payload;
      const suspendedUntil = formatNotificationDateTime(raw, timezone);
      return {
        ...rest,
        suspendedUntil: suspendedUntil ?? "further notice",
        ...(suspendedUntil ? { suspendedUntilIso: raw } : {}),
      };
    },
  );
}

export async function notifyAccountBanned(
  targetUserId: string,
  payload: AccountBannedPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.ACCOUNT_BANNED, targetUserId, payload);
}

export async function notifyPayoutProcessed(
  consultantUserId: string,
  payload: PayoutInput,
) {
  const wire: PayoutPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYOUT_PROCESSED,
    consultantUserId,
    wire,
  );
}

/**
 * The consultant, when a payout FAILS or is CANCELLED (earnings released
 * back to READY). Urgent money news — never deferred by quiet hours.
 */
export async function notifyPayoutFailed(
  consultantUserId: string,
  payload: PayoutInput,
) {
  const wire: PayoutPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYOUT_FAILED,
    consultantUserId,
    wire,
    undefined,
    { deferrable: false },
  );
}

/**
 * A7: notify a consultant that their EXPERT membership at an organization
 * was soft-deleted. Fire-and-forget — a Novu outage must not block the
 * member-DELETE API response. Caller is expected to wrap in try/catch.
 */
export async function notifyOrgExpertRemoved(
  consultantUserId: string,
  payload: OrgExpertRemovedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.ORG_EXPERT_REMOVED,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Admin / System Notifications
// ============================================================================

export async function notifyGeneralAnnouncement(payload: AnnouncementPayload) {
  return triggerBroadcastWorkflow(NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT, payload);
}

export async function notifyNewConsultantApplication(
  adminUserIds: string[],
  payload: ConsultantApplicationPayload,
  opts?: TriggerOptions,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.NEW_CONSULTANT_APPLICATION,
    adminUserIds,
    payload,
    undefined,
    opts,
  );
}

// ============================================================================
// Dispute Notifications
// ============================================================================

function disputeWire(payload: DisputeInput): DisputePayload {
  return {
    ...payload,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
  };
}

export async function notifyDisputeCreated(
  userIds: string[],
  payload: DisputeInput,
  opts?: TriggerOptions,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.DISPUTE_CREATED,
    userIds,
    disputeWire(payload),
    undefined,
    opts,
  );
}

export async function notifyDisputeResolved(
  userIds: string[],
  payload: DisputeInput,
  opts?: TriggerOptions,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.DISPUTE_RESOLVED,
    userIds,
    disputeWire(payload),
    undefined,
    opts,
  );
}

// ============================================================================
// Recording Notifications
// ============================================================================

export async function notifyRecordingAvailable(
  userIds: string[],
  payload: Omit<RecordingPayload, "appointmentTypeCode">,
) {
  const wire: RecordingPayload = {
    ...payload,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerForMultiple(NOVU_WORKFLOWS.RECORDING_AVAILABLE, userIds, wire);
}

export async function notifyRecordingFailed(
  subscriberId: string,
  payload: RecordingFailedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.RECORDING_FAILED,
    subscriberId,
    payload,
  );
}

// STR-3 — warn a consultant their STREAM_ONLY recording(s) expire soon.
export async function notifyRecordingExpiring(
  consultantUserId: string,
  payload: RecordingExpiringInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.RECORDING_EXPIRING,
    consultantUserId,
    (timezone): RecordingExpiringPayload => {
      const { expiresAt: raw, ...rest } = payload;
      const expiresAt = formatNotificationDateTime(raw, timezone);
      return {
        ...rest,
        expiresAt: expiresAt ?? "the date shown in your dashboard",
        ...(expiresAt ? { expiresAtIso: raw } : {}),
      };
    },
  );
}

// ============================================================================
// Document Review Notifications
// ============================================================================

/** A document (or revision/response) landed on an appointment. */
export async function notifyDocumentUploaded(
  subscriberId: string,
  payload: DocumentUploadedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.DOCUMENT_UPLOADED,
    subscriberId,
    payload,
  );
}

/** A consultant set a review decision on a submitted document. */
export async function notifyDocumentReviewed(
  subscriberId: string,
  payload: DocumentReviewedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.DOCUMENT_REVIEWED,
    subscriberId,
    payload,
  );
}

// ============================================================================
// Referral Notifications
// ============================================================================

export async function notifyReferralBonusEarned(
  referrerUserId: string,
  payload: ReferralBonusInput,
) {
  const wire: ReferralBonusPayload = {
    ...payload,
    bonusAmount: formatNotificationMoney(payload.bonusAmount, payload.currency),
    bonusAmountPaise: payload.bonusAmount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFERRAL_BONUS_EARNED,
    referrerUserId,
    wire,
  );
}

export async function notifyRefereeWelcomeBonus(
  refereeUserId: string,
  payload: RefereeWelcomeBonusInput,
) {
  const wire: RefereeWelcomeBonusPayload = {
    ...payload,
    bonusAmount: formatNotificationMoney(payload.bonusAmount, payload.currency),
    bonusAmountPaise: payload.bonusAmount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFEREE_WELCOME_BONUS,
    refereeUserId,
    wire,
  );
}

export async function notifyReferralCreditsApplied(
  userId: string,
  payload: ReferralCreditsAppliedInput,
) {
  const wire: ReferralCreditsAppliedPayload = {
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
  return triggerWorkflow(NOVU_WORKFLOWS.REFERRAL_CREDITS_APPLIED, userId, wire);
}

// ============================================================================
// Collaborator Notifications
// ============================================================================

export async function notifyCollaboratorInvited(
  consultantUserId: string,
  payload: CollaboratorInvitedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_INVITED,
    consultantUserId,
    payload,
  );
}

export async function notifyCollaboratorAccepted(
  ownerUserId: string,
  payload: CollaboratorAcceptedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_ACCEPTED,
    ownerUserId,
    payload,
  );
}

/** #1580 C-P1-5 — the host learns that the invitee declined. */
export async function notifyCollaboratorDeclined(
  ownerUserId: string,
  payload: CollaboratorDeclinedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_DECLINED,
    ownerUserId,
    payload,
  );
}

export async function notifyCollaboratorRemoved(
  consultantUserId: string,
  payload: CollaboratorRemovedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_REMOVED,
    consultantUserId,
    payload,
  );
}

/** #1580 C-P1-7 — the host learns that a collaborator withdrew their own row. */
export async function notifyCollaboratorWithdrawn(
  ownerUserId: string,
  payload: CollaboratorWithdrawnPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_WITHDRAWN,
    ownerUserId,
    payload,
  );
}

// Maintenance notifications (broadcast to all users)

/**
 * A broadcast has no recipient list to load zones from, so the ETA renders in
 * the platform default zone — which the rendered string names, so nobody has to
 * guess which zone they are reading (#536).
 */
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

export async function notifyMaintenanceScheduled(payload: MaintenanceInput) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_SCHEDULED,
    maintenanceWire(payload),
  );
}

export async function notifyMaintenanceStarted(payload: MaintenanceInput) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_STARTED,
    maintenanceWire(payload),
  );
}

export async function notifyMaintenanceEnded(payload: MaintenanceInput) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_ENDED,
    maintenanceWire(payload),
  );
}
