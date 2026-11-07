import type { CollaboratorType, StreamRevocationKind } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
  isStreamConfigured,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { liveParticipant, paidParticipant } from "@/lib/booking/participants";
import { reportSentryError } from "@/lib/observability/report";
import {
  isDmChannelIdEligible,
  isDmContextEligible,
} from "@/lib/stream/dm-eligibility";
import {
  isEventParticipant,
  removeUsersFromEventChannel,
} from "@/lib/stream/event-channel-service";

/** The revocations a mutating action owes Stream; erasure rows are written by the scrub. */
export type AccessRevocationKind = Exclude<
  StreamRevocationKind,
  "ERASURE_REVOKE"
>;

export interface AccessRevocationTarget {
  kind: AccessRevocationKind;
  userId: string;
  planId: string;
  planType?: CollaboratorType | null;
  counterpartUserId?: string | null;
}

/**
 * Queues revocations for the moderation retry sweep. A target that already has
 * an open row is re-armed, so a capped row cannot swallow a new revocation.
 * `nextRetryAt` holds the row back from the sweep while its writer drives it.
 */
export async function enqueueStreamRevocationRetries(
  targets: AccessRevocationTarget[],
  opts: { nextRetryAt?: Date } = {},
): Promise<void> {
  if (targets.length === 0) return;
  const nextRetryAt = opts.nextRetryAt ?? null;
  await prisma.streamRevocationRetry.updateMany({
    where: {
      erasureRequestId: null,
      status: { not: "SUCCEEDED" },
      OR: targets.map((t) => ({
        kind: t.kind,
        planId: t.planId,
        userId: t.userId,
      })),
    },
    data: { status: "PENDING", attempts: 0, nextRetryAt, lastError: null },
  });
  await prisma.streamRevocationRetry.createMany({
    data: targets.map((t) => ({
      kind: t.kind,
      userId: t.userId,
      planId: t.planId,
      planType: t.planType ?? null,
      counterpartUserId: t.counterpartUserId ?? null,
      nextRetryAt,
    })),
    skipDuplicates: true,
  });
}

/** Enqueues and never throws: the action that owed the revocation has already committed. */
async function enqueueOrReport(
  targets: AccessRevocationTarget[],
  op: string,
  opts: { nextRetryAt?: Date } = {},
): Promise<boolean> {
  try {
    await enqueueStreamRevocationRetries(targets, opts);
    return true;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op,
      extra: { targets: targets.length, kind: targets[0]?.kind },
    });
    return false;
  }
}

/** Marks the writer's own intents done once its drive completed them. */
async function settleIntents(
  kind: AccessRevocationKind,
  planId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await prisma.streamRevocationRetry.updateMany({
      where: {
        erasureRequestId: null,
        kind,
        planId,
        userId: { in: userIds },
        status: { in: ["PENDING", "FAILED"] },
      },
      data: { status: "SUCCEEDED", completedAt: new Date() },
    });
  } catch (error) {
    // The rows stay owed; the sweep re-drives them and finds nothing left to remove.
    streamLogger.warn("Could not settle revocation intents", {
      kind,
      planId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class RevocationBudgetSpent extends Error {}

/** Stops waiting on a vendor call once the slice's budget is spent; the call itself may still land. */
function withinBudget<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  work.catch(() => undefined);
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return Promise.reject(new RevocationBudgetSpent());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RevocationBudgetSpent()), remainingMs);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

async function removeFromDm(
  channelId: string,
  userId: string,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  try {
    const removal = getStreamChatClient()
      .channel("messaging", channelId)
      .removeMembers([userId]);
    await (Number.isFinite(deadlineMs)
      ? withinBudget(removal, deadlineMs)
      : removal);
    return true;
  } catch (error) {
    return isExpectedStreamError(error);
  }
}

/** Stream caps chat member updates at 100 users a request; call member updates stay inside the same bound. */
const MEMBER_CHUNK = 100;
/** Rooms read per page while a seat leaves an appointment's calls. */
const CALL_PAGE_SIZE = 50;
/** The request's own slice of a seat revocation; the sweep finishes whatever it leaves. */
const SYNC_SEAT_REVOCATION_BUDGET_MS = 8_000;
/** One sweep attempt's slice; an unfinished row stays owed and resumes on its next attempt. */
const REDRIVE_SEAT_REVOCATION_BUDGET_MS = 20_000;
/** A fresh intent waits this long for the sweep, so the sweep does not race its writer's drive. */
const INTENT_SWEEP_GRACE_MS = 2 * 60_000;

/** A 1:1 booking in one of these no longer admits anyone to its room or DM. */
const TERMINAL_BOOKING_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "CONVERTED",
]);

const directPlanSelect = {
  select: {
    organizationId: true,
    consultantProfile: { select: { userId: true } },
  },
} as const;

const eventPlanSelect = {
  select: {
    organizationId: true,
    consultantProfile: { select: { userId: true } },
    collaborators: {
      where: {
        status: "ACCEPTED" as const,
        consultantProfile: { deletedAt: null },
      },
      select: { tier: true, consultantProfile: { select: { userId: true } } },
    },
  },
} as const;

function loadSeatContext(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      deletedAt: true,
      organizationId: true,
      webinar: {
        select: { id: true, status: true, webinarPlan: eventPlanSelect },
      },
      class: { select: { id: true, status: true, classPlan: eventPlanSelect } },
      consultation: {
        select: { status: true, consultationPlan: directPlanSelect },
      },
      subscription: {
        select: { status: true, subscriptionPlan: directPlanSelect },
      },
      trial: {
        select: {
          status: true,
          consultantProfile: { select: { userId: true } },
          subscriptionPlan: { select: { organizationId: true } },
        },
      },
    },
  });
}

type SeatContext = NonNullable<Awaited<ReturnType<typeof loadSeatContext>>>;

function seatEvent(
  ctx: SeatContext,
): { type: "webinar" | "class"; id: string } | null {
  if (ctx.webinar) return { type: "webinar", id: ctx.webinar.id };
  if (ctx.class) return { type: "class", id: ctx.class.id };
  return null;
}

/** The host and presenters a seat holder may share a DM with. */
function seatCounterparts(ctx: SeatContext): string[] {
  return planStaffUserIds(ctx, { presentersOnly: true });
}

/** The plan owner and its accepted collaborators; `presentersOnly` keeps the DM-eligible tier. */
function planStaffUserIds(
  ctx: SeatContext,
  opts: { presentersOnly: boolean },
): string[] {
  const eventPlan = ctx.webinar?.webinarPlan ?? ctx.class?.classPlan;
  const ids = eventPlan
    ? [
        eventPlan.consultantProfile?.userId,
        ...eventPlan.collaborators
          .filter((c) => !opts.presentersOnly || c.tier === "PRESENTER")
          .map((c) => c.consultantProfile.userId),
      ]
    : [
        ctx.consultation?.consultationPlan.consultantProfile.userId ??
          ctx.subscription?.subscriptionPlan.consultantProfile.userId ??
          ctx.trial?.consultantProfile.userId,
      ];
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

function seatOrganizationId(ctx: SeatContext): string | null {
  return bookingOrgId({
    consultationPlan: ctx.consultation?.consultationPlan,
    subscriptionPlan:
      ctx.subscription?.subscriptionPlan ?? ctx.trial?.subscriptionPlan,
    webinarPlan: ctx.webinar?.webinarPlan,
    classPlan: ctx.class?.classPlan,
    appointment: ctx,
  });
}

function bookingStatusOf(ctx: SeatContext): string | null {
  return (
    ctx.webinar?.status ??
    ctx.class?.status ??
    ctx.consultation?.status ??
    ctx.subscription?.status ??
    ctx.trial?.status ??
    null
  );
}

/** The users the join gate still admits: a paid seat for a group room, a live one for a 1:1. */
async function admittedSeatHolders(
  appointmentId: string,
  ctx: SeatContext,
  userIds: string[],
): Promise<Set<string>> {
  const status = bookingStatusOf(ctx);
  if (ctx.deletedAt || (status && TERMINAL_BOOKING_STATUSES.has(status))) {
    return new Set();
  }
  const isGroupEvent = Boolean(ctx.webinar || ctx.class);
  const seats = await prisma.appointmentParticipant.findMany({
    where: {
      appointmentId,
      ...(isGroupEvent ? paidParticipant() : liveParticipant()),
      role: "CONSULTEE",
      userId: { in: userIds },
    },
    select: { userId: true },
  });
  return new Set(seats.map((s) => s.userId));
}

class PendingRevocations {
  readonly byUser = new Map<string, string>();
  add(userIds: Iterable<string>, reason: string): void {
    for (const userId of userIds) {
      if (!this.byUser.has(userId)) this.byUser.set(userId, reason);
    }
  }
}

async function removeFromSeatDms(
  ctx: SeatContext,
  userIds: string[],
  deadlineMs: number,
  pending: PendingRevocations,
): Promise<void> {
  const counterparts = seatCounterparts(ctx);
  const organizationId = seatOrganizationId(ctx);
  for (const userId of userIds) {
    for (const counterpart of counterparts) {
      if (counterpart === userId) continue;
      if (Date.now() >= deadlineMs) {
        pending.add([userId], "time budget spent before DM removal");
        continue;
      }
      try {
        if (await isDmContextEligible(counterpart, userId, organizationId)) {
          continue;
        }
      } catch {
        pending.add([userId], "DM eligibility check failed");
        continue;
      }
      const channelId = getDmChannelId(counterpart, userId, organizationId);
      if (!(await removeFromDm(channelId, userId, deadlineMs))) {
        pending.add([userId], "DM removal failed");
      }
    }
  }
}

type VideoCall = ReturnType<
  ReturnType<typeof getStreamVideoClient>["video"]["call"]
>;

/** An ended call is sealed at Stream: `call_member` holds no `join-ended-call`. */
async function callHasEnded(
  call: VideoCall,
  deadlineMs: number,
): Promise<boolean> {
  try {
    const { call: state } = await withinBudget(call.get(), deadlineMs);
    return Boolean(state.ended_at);
  } catch {
    return false;
  }
}

/** Returns the users of the chunk who may still join the call. */
async function removeChunkFromCall(
  streamCallId: string,
  chunk: string[],
  deadlineMs: number,
): Promise<string[]> {
  const call = getStreamVideoClient().video.call(
    STREAM_CALL_TYPE,
    toCallId(streamCallId),
  );
  try {
    await withinBudget(
      call.updateCallMembers({ remove_members: chunk }),
      deadlineMs,
    );
    return [];
  } catch (error) {
    if (error instanceof RevocationBudgetSpent) return chunk;
    if (isExpectedStreamError(error)) return [];
    return (await callHasEnded(call, deadlineMs)) ? [] : chunk;
  }
}

/**
 * Drops the users from every room the appointment provisioned. A Postgres end
 * stamp does not seal a room at Stream, so only Stream's own end excuses one.
 */
async function removeFromAppointmentCalls(
  appointmentId: string,
  userIds: string[],
  deadlineMs: number,
  pending: PendingRevocations,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    let page: { id: string; streamCallId: string }[];
    try {
      page = await prisma.meeting.findMany({
        where: { occurrence: { appointmentId } },
        select: { id: true, streamCallId: true },
        orderBy: { id: "asc" },
        take: CALL_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    } catch {
      pending.add(userIds, "call lookup failed");
      return;
    }
    // Sequential on purpose: a revocation's Stream writes stay one at a time.
    for (const meeting of page) {
      if (Date.now() >= deadlineMs) {
        pending.add(userIds, "time budget spent before call removal");
        return;
      }
      for (let i = 0; i < userIds.length; i += MEMBER_CHUNK) {
        const chunk = userIds.slice(i, i + MEMBER_CHUNK);
        const kept = await removeChunkFromCall(
          meeting.streamCallId,
          chunk,
          deadlineMs,
        );
        pending.add(kept, "call removal failed");
      }
    }
    const last = page.at(-1);
    if (page.length < CALL_PAGE_SIZE || !last) return;
    cursor = last.id;
  }
}

/**
 * Removes the users the join gate no longer admits from the appointment's event
 * channel, DMs and rooms, chat first. Returns who is still owed, with why.
 */
async function driveSeatRevocation(
  appointmentId: string,
  userIds: string[],
  deadlineMs: number,
): Promise<Map<string, string>> {
  const pending = new PendingRevocations();
  if (!isStreamConfigured()) return pending.byUser;
  let ctx: SeatContext | null;
  let revoked: string[];
  try {
    ctx = await loadSeatContext(appointmentId);
    // A deleted appointment took its Meeting rows with it; nothing addressable is left.
    if (!ctx) return pending.byUser;
    const admitted = await admittedSeatHolders(appointmentId, ctx, userIds);
    revoked = userIds.filter((id) => !admitted.has(id));
  } catch {
    pending.add(userIds, "seat lookup failed");
    return pending.byUser;
  }
  if (revoked.length === 0) return pending.byUser;

  const event = seatEvent(ctx);
  if (event) {
    try {
      const { failedUserIds } = await withinBudget(
        removeUsersFromEventChannel(event.type, event.id, revoked),
        deadlineMs,
      );
      pending.add(failedUserIds, "event channel removal failed");
    } catch {
      pending.add(revoked, "event channel removal interrupted");
    }
  }
  await removeFromSeatDms(ctx, revoked, deadlineMs, pending);
  await removeFromAppointmentCalls(appointmentId, revoked, deadlineMs, pending);
  return pending.byUser;
}

const intentNotBefore = () => new Date(Date.now() + INTENT_SWEEP_GRACE_MS);

/**
 * Ends the Stream access an ended seat or booking no longer justifies: the
 * event channel, the host and presenter DMs, and every room the appointment
 * provisioned. The obligation is persisted before any lookup or vendor call and
 * driven inside the request's budget; `retry-moderation-enforcement` owns the
 * rest. Never throws.
 */
export async function revokeEndedSeatAccess(
  appointmentId: string,
  userIds: string[],
): Promise<void> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return;
  await persistSeatRevocation(appointmentId, ids);
  let pending: Map<string, string>;
  try {
    pending = await driveSeatRevocation(
      appointmentId,
      ids,
      Date.now() + SYNC_SEAT_REVOCATION_BUDGET_MS,
    );
  } catch (error) {
    // The intents stay owed; the sweep re-drives them.
    streamLogger.warn("Seat revocation interrupted", {
      appointmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await settleIntents(
    "SEAT_ACCESS_REVOKE",
    appointmentId,
    ids.filter((id) => !pending.has(id)),
  );
}

/**
 * Persists the seat revocation an action owes without driving it, so a caller
 * with slow work left after its commit owns the obligation first. Never throws.
 */
export async function persistSeatRevocation(
  appointmentId: string,
  userIds: string[],
): Promise<void> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return;
  await enqueueOrReport(
    ids.map((userId) => ({
      kind: "SEAT_ACCESS_REVOKE" as const,
      userId,
      planId: appointmentId,
    })),
    "seat.persistRevocation",
    { nextRetryAt: intentNotBefore() },
  );
}

/**
 * Re-checks users a room was just granted to, and takes the room back from any
 * seat holder whose entitlement ended meanwhile. A revoker that ran between the
 * grant's check and its write saw no membership to remove.
 */
export async function fenceSeatGrants(
  appointmentId: string,
  userIds: string[],
): Promise<string[]> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return [];
  try {
    const ctx = await loadSeatContext(appointmentId);
    if (!ctx) return [];
    const [seatHolders, admitted] = await Promise.all([
      prisma.appointmentParticipant.findMany({
        where: { appointmentId, role: "CONSULTEE", userId: { in: ids } },
        select: { userId: true },
      }),
      admittedSeatHolders(appointmentId, ctx, ids),
    ]);
    // Client seats only: the host and accepted crew reach the room through their own roles.
    const staff = new Set(planStaffUserIds(ctx, { presentersOnly: false }));
    const lost = Array.from(
      new Set(
        seatHolders
          .map((s) => s.userId)
          .filter((id) => !admitted.has(id) && !staff.has(id)),
      ),
    );
    if (lost.length > 0) await revokeEndedSeatAccess(appointmentId, lost);
    return lost;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "seat.fenceGrant",
      extra: { appointmentId, users: ids.length },
    });
    return [];
  }
}

type RefundDrive = { error: string | null };

/** Turns a refund into per-seat intents, then drives them; the refund intent is done once they persist. */
async function driveRefundRevocation(
  paymentId: string,
  deadlineMs: number,
): Promise<RefundDrive> {
  const refunded = await prisma.appointmentParticipant.findMany({
    where: { paymentId, status: "REFUNDED" },
    select: {
      userId: true,
      appointmentId: true,
      appointment: {
        select: {
          webinar: { select: { status: true } },
          class: { select: { status: true } },
          consultation: { select: { status: true } },
          subscription: { select: { status: true } },
          trial: { select: { status: true } },
        },
      },
    },
  });
  // A cancelled booking's cancel route persisted and drove its own seat intents.
  const seats = refunded.filter((s) => {
    const a = s.appointment;
    const status =
      a.webinar?.status ??
      a.class?.status ??
      a.consultation?.status ??
      a.subscription?.status ??
      a.trial?.status;
    return status !== "CANCELLED";
  });
  if (seats.length === 0) return { error: null };
  const persisted = await enqueueOrReport(
    seats.map((s) => ({
      kind: "SEAT_ACCESS_REVOKE" as const,
      userId: s.userId,
      planId: s.appointmentId,
    })),
    "refund.persistSeatRevocation",
    { nextRetryAt: intentNotBefore() },
  );
  for (const seat of seats) {
    const pending = await driveSeatRevocation(
      seat.appointmentId,
      [seat.userId],
      deadlineMs,
    );
    if (!pending.has(seat.userId)) {
      await settleIntents("SEAT_ACCESS_REVOKE", seat.appointmentId, [
        seat.userId,
      ]);
    }
  }
  return { error: persisted ? null : "Seat revocations not persisted" };
}

/**
 * After a refund ends a seat, removes the access the join gate no longer
 * grants. The refund intent is persisted before seat discovery. Never throws:
 * the refund has already committed.
 */
export async function revokeRefundedSeatAccess(
  paymentId: string,
): Promise<void> {
  let payerUserId: string | null = null;
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { userId: true },
    });
    payerUserId = payment?.userId ?? null;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "refund.loadPayer",
      extra: { paymentId },
    });
  }
  if (payerUserId) {
    await enqueueOrReport(
      [
        {
          kind: "REFUND_ACCESS_REVOKE",
          userId: payerUserId,
          planId: paymentId,
        },
      ],
      "refund.persistRevocation",
      { nextRetryAt: intentNotBefore() },
    );
  }
  try {
    const { error } = await driveRefundRevocation(
      paymentId,
      Date.now() + SYNC_SEAT_REVOCATION_BUDGET_MS,
    );
    if (!error && payerUserId) {
      await settleIntents("REFUND_ACCESS_REVOKE", paymentId, [payerUserId]);
    }
  } catch (error) {
    // The refund intent stays owed; the sweep re-drives it.
    streamLogger.warn("Refund seat revocation interrupted", {
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Queues a collaborator revocation that `revokeCollaboratorAccess` reported as incomplete. */
export async function enqueueCollaboratorRevocationRetry(
  planType: "webinar" | "class",
  planId: string,
  userId: string,
): Promise<void> {
  await enqueueOrReport(
    [
      {
        kind: "COLLAB_REVOKE",
        userId,
        planId,
        planType: planType === "webinar" ? "WEBINAR" : "CLASS",
      },
    ],
    "collaborator.revokeAccess",
  );
}

/** Queues an org-member revocation that did not fully land. */
export async function enqueueOrgMemberRevocationRetry(
  orgId: string,
  userId: string,
): Promise<void> {
  await enqueueOrReport(
    [{ kind: "ORG_REVOKE", userId, planId: orgId }],
    "org.member-removal",
  );
}

export interface AccessRevocationRow {
  kind: AccessRevocationKind;
  userId: string;
  planId: string;
  planType: CollaboratorType | null;
  counterpartUserId: string | null;
  createdAt: Date;
}

/**
 * Re-drives one queued revocation. Returns the error to record, or null when
 * the access is gone or Postgres has since re-granted it.
 */
export async function redriveAccessRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  switch (row.kind) {
    case "COLLAB_REVOKE":
      return redriveCollaboratorRevocation(row);
    case "EVENT_CHANNEL_REMOVE":
      return redriveEventChannelRemoval(row);
    case "DM_REMOVE":
      return redriveDmRemoval(row);
    case "ORG_REVOKE":
      return redriveOrgRevocation(row);
    case "SEAT_ACCESS_REVOKE":
      return redriveSeatRevocation(row);
    case "REFUND_ACCESS_REVOKE":
      return (
        await driveRefundRevocation(
          row.planId,
          Date.now() + REDRIVE_SEAT_REVOCATION_BUDGET_MS,
        )
      ).error;
  }
}

async function redriveSeatRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  const pending = await driveSeatRevocation(
    row.planId,
    [row.userId],
    Date.now() + REDRIVE_SEAT_REVOCATION_BUDGET_MS,
  );
  return pending.get(row.userId) ?? null;
}

async function redriveCollaboratorRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  if (!row.planType) return "COLLAB_REVOKE row has no plan type";
  const planType = row.planType === "WEBINAR" ? "webinar" : "class";
  const regranted = await prisma.collaborator.findFirst({
    where: {
      status: "ACCEPTED",
      consultantProfile: { userId: row.userId, deletedAt: null },
      ...(planType === "webinar"
        ? { webinarPlanId: row.planId }
        : { classPlanId: row.planId }),
    },
    select: { id: true },
  });
  if (regranted) return null;
  const { revokeCollaboratorAccess } =
    await import("@/lib/collaborators/service");
  const { success } = await revokeCollaboratorAccess(
    planType,
    row.planId,
    row.userId,
  );
  return success ? null : "Collaborator Stream access not fully revoked";
}

async function redriveEventChannelRemoval(
  row: AccessRevocationRow,
): Promise<string | null> {
  if (!row.planType) return "EVENT_CHANNEL_REMOVE row has no event type";
  const type = row.planType === "WEBINAR" ? "webinar" : "class";
  if (await isEventParticipant(type, row.planId, row.userId)) return null;
  const { failedUserIds } = await removeUsersFromEventChannel(
    type,
    row.planId,
    [row.userId],
  );
  return failedUserIds.length === 0 ? null : "Event channel removal failed";
}

async function redriveDmRemoval(
  row: AccessRevocationRow,
): Promise<string | null> {
  if (!row.counterpartUserId) return "DM_REMOVE row has no counterpart";
  if (
    await isDmChannelIdEligible(row.counterpartUserId, row.userId, row.planId)
  ) {
    return null;
  }
  return (await removeFromDm(row.planId, row.userId))
    ? null
    : "DM removal failed";
}

async function redriveOrgRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  const rejoined = await prisma.membership.findFirst({
    where: {
      userId: row.userId,
      organizationId: row.planId,
      status: { in: ["ACTIVE", "PENDING"] },
    },
    select: { id: true },
  });
  if (rejoined) return null;
  const { revokeMemberStreamAccess } =
    await import("@/lib/stream/org-access-revocation");
  const outcome = await revokeMemberStreamAccess({
    userId: row.userId,
    orgId: row.planId,
    revokeTokensIssuedBefore: row.createdAt,
  });
  return outcome.complete ? null : outcome.failures.join("; ");
}
