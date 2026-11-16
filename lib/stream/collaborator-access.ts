import prisma from "@/lib/prisma";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
  paidParticipant,
} from "@/lib/booking/participants";
import {
  livePlanAppointmentsWhere,
  type PlanRef,
} from "@/lib/collaborators/team";
import { MAX_CALL_DURATION_MS } from "@/lib/meetings/duration-cap";
import { reportSentryError } from "@/lib/observability/report";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
} from "@/lib/stream-client";
import { collabChannelId } from "@/lib/stream-channel-ids";
import { streamLogger } from "@/lib/stream-logger";
import { CALL_MEMBER_ROLE, STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import {
  addUserToEventChannel,
  checkEventChannelExists,
  removeUsersFromEventChannel,
} from "@/lib/stream/event-channel-service";
import { STREAM_PUBLISH_PERMISSIONS } from "@/lib/stream/video-contracts";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The plan's events whose chat the user must leave. Chat rule: only a paid
 * learner seat on the event keeps its chat.
 */
async function eventsWithoutPaidSeat(
  ref: PlanRef,
  userId: string,
): Promise<string[]> {
  const select = { id: true, appointment: { select: { id: true } } } as const;
  const events =
    ref.planType === "webinar"
      ? await prisma.webinar.findMany({
          where: { webinarPlanId: ref.planId },
          select,
        })
      : await prisma.class.findMany({
          where: { classPlanId: ref.planId },
          select,
        });
  const appointmentIds = events.flatMap((e) =>
    e.appointment ? [e.appointment.id] : [],
  );
  const seats =
    appointmentIds.length === 0
      ? []
      : await prisma.appointmentParticipant.findMany({
          where: {
            ...paidParticipant(userId),
            role: "CONSULTEE",
            appointmentId: { in: appointmentIds },
          },
          select: { appointmentId: true },
        });
  const seated = new Set(seats.map((seat) => seat.appointmentId));
  return events
    .filter((e) => !e.appointment || !seated.has(e.appointment.id))
    .map((e) => e.id);
}

/** Leaves the plan's `collab-` channel and every event channel; returns what is still owed. */
async function removeFromPlanChat(
  ref: PlanRef,
  userId: string,
  deadlineMs: number,
): Promise<string[]> {
  if (Date.now() >= deadlineMs) return ["time budget spent before chat"];
  const owed: string[] = [];
  try {
    await getStreamChatClient()
      .channel("messaging", collabChannelId(ref.planType, ref.planId))
      .removeMembers([userId]);
  } catch (error) {
    if (!isExpectedStreamError(error)) {
      owed.push("collaborator channel removal failed");
    }
  }

  let eventIds: string[];
  try {
    eventIds = await eventsWithoutPaidSeat(ref, userId);
  } catch {
    return [...owed, "event lookup failed"];
  }
  let failed = 0;
  // One event at a time: a failing channel is counted and the rest still go.
  for (const [index, eventId] of eventIds.entries()) {
    if (Date.now() >= deadlineMs) {
      failed += eventIds.length - index;
      break;
    }
    try {
      const { failedUserIds } = await removeUsersFromEventChannel(
        ref.planType,
        eventId,
        [userId],
      );
      if (failedUserIds.length > 0) failed++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    owed.push(`${failed} of ${eventIds.length} event channels not left`);
  }
  return owed;
}

type OpenRoom = { streamCallId: string; seated: boolean };

/**
 * The plan's rooms that can still be joined. Room rule: any live row that is
 * not the collaborator's own marks the room `seated`, and keeps them in it.
 */
async function openRooms(ref: PlanRef, userId: string): Promise<OpenRoom[]> {
  const occurrences = await prisma.appointmentOccurrence.findMany({
    where: {
      deletedAt: null,
      endsAt: { gt: new Date(Date.now() - MAX_CALL_DURATION_MS) },
      appointment: livePlanAppointmentsWhere(ref),
      meeting: { is: { endedAt: null } },
    },
    select: {
      appointmentId: true,
      meeting: { select: { streamCallId: true } },
    },
  });
  if (occurrences.length === 0) return [];
  const seats = await prisma.appointmentParticipant.findMany({
    where: {
      ...liveParticipant(userId),
      ...NOT_COLLABORATOR_ROW,
      appointmentId: { in: occurrences.map((o) => o.appointmentId) },
    },
    select: { appointmentId: true },
  });
  const seated = new Set(seats.map((seat) => seat.appointmentId));
  return occurrences.flatMap(({ appointmentId, meeting }) =>
    meeting
      ? [
          {
            streamCallId: meeting.streamCallId,
            seated: seated.has(appointmentId),
          },
        ]
      : [],
  );
}

type VideoCall = ReturnType<
  ReturnType<typeof getStreamVideoClient>["video"]["call"]
>;

/** A seat holder stays in the room as a plain, muted member; anyone else is removed, muted and dropped. */
async function removeFromRoom(
  call: VideoCall,
  userId: string,
  seated: boolean,
): Promise<boolean> {
  const mute = () =>
    call.updateUserPermissions({
      user_id: userId,
      revoke_permissions: [...STREAM_PUBLISH_PERMISSIONS],
    });
  const writes = seated
    ? [
        () =>
          call.updateCallMembers({
            update_members: [{ user_id: userId, role: CALL_MEMBER_ROLE }],
          }),
        mute,
      ]
    : [
        () => call.updateCallMembers({ remove_members: [userId] }),
        mute,
        () => call.kickUser({ user_id: userId }),
      ];
  let done = true;
  for (const write of writes) {
    try {
      await write();
    } catch (error) {
      if (!isExpectedStreamError(error)) done = false;
    }
  }
  return done;
}

/** Takes the user out of every open room of the plan; returns what is still owed. */
async function removeFromOpenRooms(
  ref: PlanRef,
  userId: string,
  deadlineMs: number,
): Promise<string[]> {
  if (Date.now() >= deadlineMs) return ["time budget spent before calls"];
  let rooms: OpenRoom[];
  try {
    rooms = await openRooms(ref, userId);
  } catch {
    return ["call lookup failed"];
  }
  if (rooms.length === 0) return [];
  let failed = 0;
  try {
    const { video } = getStreamVideoClient();
    for (const [index, room] of rooms.entries()) {
      if (Date.now() >= deadlineMs) {
        failed += rooms.length - index;
        break;
      }
      const call = video.call(STREAM_CALL_TYPE, room.streamCallId);
      if (!(await removeFromRoom(call, userId, room.seated))) failed++;
    }
  } catch {
    return ["video client unavailable"];
  }
  return failed > 0 ? [`${failed} of ${rooms.length} calls not left`] : [];
}

/**
 * Ends what a collaboration granted on Stream: the plan's `collab-` channel,
 * every event channel and every open room. A paid learner seat keeps its own
 * event chat and its place in the room. Starts no Stream call after
 * `deadlineMs`. Returns the error to record, or null when nothing is left.
 */
export async function driveCollaboratorRevocation(
  ref: PlanRef,
  userId: string,
  deadlineMs: number,
): Promise<string | null> {
  // Chat and video are separate services, so a stall in one never starves the other.
  const [chat, rooms] = await Promise.all([
    removeFromPlanChat(ref, userId, deadlineMs),
    removeFromOpenRooms(ref, userId, deadlineMs),
  ]);
  const owed = [...chat, ...rooms];
  return owed.length === 0 ? null : owed.join("; ");
}

/** The plan's `collab-` channel with its roster, tagged with the plan's organisation. */
async function ensureCollaboratorChannel(ref: PlanRef): Promise<void> {
  const plan =
    ref.planType === "webinar"
      ? await prisma.webinarPlan.findUnique({
          where: { id: ref.planId },
          select: { organizationId: true },
        })
      : await prisma.classPlan.findUnique({
          where: { id: ref.planId },
          select: { organizationId: true },
        });
  // Lazy: the action module loads request authentication.
  const { createCollaboratorChannel } =
    await import("@/actions/stream/chat/channel.action");
  await createCollaboratorChannel(ref.planType, ref.planId);
  if (!plan?.organizationId) return;
  const customSet: Record<string, unknown> = {
    organization_id: plan.organizationId,
  };
  await getStreamChatClient()
    .channel("messaging", collabChannelId(ref.planType, ref.planId))
    .updatePartial({ set: customSet });
}

function activePlanEvents(ref: PlanRef): Promise<{ id: string }[]> {
  const activeStatuses = ["SCHEDULED", "COMPLETED"] as const;
  return ref.planType === "webinar"
    ? prisma.webinar.findMany({
        where: {
          webinarPlanId: ref.planId,
          deletedAt: null,
          status: { in: [...activeStatuses] },
        },
        select: { id: true },
      })
    : prisma.class.findMany({
        where: {
          classPlanId: ref.planId,
          deletedAt: null,
          status: { in: [...activeStatuses] },
        },
        select: { id: true },
      });
}

/** Adds the user to each event channel that exists; returns how many adds failed. */
async function joinEventChannels(
  ref: PlanRef,
  userId: string,
): Promise<number> {
  const events = await activePlanEvents(ref);
  let failed = 0;
  for (const event of events) {
    try {
      if (await checkEventChannelExists(ref.planType, event.id)) {
        await addUserToEventChannel(ref.planType, event.id, userId);
      }
    } catch {
      // The add reports its own failure; the remaining events still go.
      failed++;
    }
  }
  return failed;
}

/**
 * Gives an accepted collaborator the plan's chat: the `collab-` channel and
 * every existing event channel. Best effort, since the viewer's channel sync
 * and the join route grant the same again; it then re-checks the collaboration
 * and takes the grant back if it has ended. Never throws.
 */
export async function grantCollaboratorAccess(
  ref: PlanRef,
  userId: string,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await ensureCollaboratorChannel(ref);
  } catch (error) {
    if (!isExpectedStreamError(error)) failures.push(error);
  }
  let eventAddsFailed = 0;
  try {
    eventAddsFailed = await joinEventChannels(ref, userId);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    reportSentryError(failures[0], {
      subsystem: "collaborators",
      op: "grantCollaboratorAccess",
      level: "warning",
      extra: { ...ref, failed: failures.length, eventAddsFailed },
    });
  } else if (eventAddsFailed > 0) {
    streamLogger.warn("Collaborator not added to every event channel", {
      ...ref,
      eventAddsFailed,
    });
  }
  try {
    // Lazy: access-revocation imports this module.
    const { fenceCollaboratorGrant } =
      await import("@/lib/stream/access-revocation");
    await fenceCollaboratorGrant(ref, userId);
  } catch (error) {
    streamLogger.warn("Collaborator grant could not be re-checked", {
      ...ref,
      error: messageOf(error),
    });
  }
}
