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
import { chunk, STREAM_QUERY_CHANNELS_LIMIT } from "@/lib/stream/batch";
import { CALL_MEMBER_ROLE, STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import {
  addUserToEventChannel,
  checkEventChannelExists,
  getChannelId,
  getChannelType,
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

/** Of these events, the ones whose chat still has the user as a member, in one Stream query. */
async function eventChatsStillJoined(
  planType: PlanRef["planType"],
  eventIds: string[],
  userId: string,
): Promise<string[]> {
  const channelType = getChannelType(planType);
  const eventByChannel = new Map(
    eventIds.map((eventId) => [getChannelId(planType, eventId), eventId]),
  );
  const channels = await getStreamChatClient().queryChannels(
    {
      cid: {
        $in: Array.from(eventByChannel.keys(), (id) => `${channelType}:${id}`),
      },
      members: { $in: [userId] },
    },
    [{ last_message_at: -1 }],
    { limit: STREAM_QUERY_CHANNELS_LIMIT, state: false, watch: false },
  );
  return channels.flatMap((channel) => {
    const eventId = channel.id ? eventByChannel.get(channel.id) : undefined;
    return eventId ? [eventId] : [];
  });
}

/**
 * Leaves the plan's `collab-` channel and every event chat the user is still a
 * member of; returns what is still owed. Stream is asked once per page of
 * events which chats still hold the user, so a drive spends its removals only
 * on those.
 */
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
  let unchecked = 0;
  let notLeft = 0;
  // A page or a channel that fails is counted and the rest still go.
  for (const page of chunk(eventIds, STREAM_QUERY_CHANNELS_LIMIT)) {
    if (Date.now() >= deadlineMs) {
      unchecked += page.length;
      continue;
    }
    let joined: string[];
    try {
      joined = await eventChatsStillJoined(ref.planType, page, userId);
    } catch {
      unchecked += page.length;
      continue;
    }
    for (const eventId of joined) {
      if (Date.now() >= deadlineMs) {
        notLeft++;
        continue;
      }
      try {
        const { failedUserIds } = await removeUsersFromEventChannel(
          ref.planType,
          eventId,
          [userId],
        );
        if (failedUserIds.length > 0) notLeft++;
      } catch {
        notLeft++;
      }
    }
  }
  if (unchecked > 0) {
    owed.push(`${unchecked} of ${eventIds.length} event channels not checked`);
  }
  if (notLeft > 0) {
    owed.push(`${notLeft} of ${eventIds.length} event channels not left`);
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

/** `unfinished`: a write was not started because the deadline had passed. */
type RoomOutcome = "left" | "failed" | "unfinished";

/**
 * A seat holder stays in the room as a plain, muted member; anyone else is
 * removed, muted and dropped. Starts no write after `deadlineMs`; a write
 * already sent that failed makes the room `failed`.
 */
async function removeFromRoom(
  call: VideoCall,
  userId: string,
  seated: boolean,
  deadlineMs: number,
): Promise<RoomOutcome> {
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
  let outcome: RoomOutcome = "left";
  for (const write of writes) {
    if (Date.now() >= deadlineMs) {
      return outcome === "failed" ? outcome : "unfinished";
    }
    try {
      await write();
    } catch (error) {
      if (!isExpectedStreamError(error)) outcome = "failed";
    }
  }
  return outcome;
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
  const count = { left: 0, failed: 0, unfinished: 0 };
  try {
    const { video } = getStreamVideoClient();
    for (const room of rooms) {
      const call = video.call(STREAM_CALL_TYPE, room.streamCallId);
      count[await removeFromRoom(call, userId, room.seated, deadlineMs)]++;
    }
  } catch {
    return ["video client unavailable"];
  }
  const owed: string[] = [];
  if (count.failed > 0) {
    owed.push(`${count.failed} of ${rooms.length} calls not left`);
  }
  if (count.unfinished > 0) {
    owed.push(
      `${count.unfinished} of ${rooms.length} calls not finished within the time budget`,
    );
  }
  return owed;
}

/**
 * Ends what a collaboration granted on Stream: the plan's `collab-` channel,
 * every event channel the user is still in and every open room. A paid learner seat keeps its own
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

type FailedEventAdds = { eventIds: string[]; errors: unknown[] };

/** How many failed events one report names. */
const FAILED_EVENT_SAMPLE = 5;

/**
 * Adds the user to each event channel that exists, without reporting: every
 * event gets its attempt and the caller reports the failed ones once.
 */
async function joinEventChannels(
  ref: PlanRef,
  userId: string,
): Promise<FailedEventAdds> {
  const events = await activePlanEvents(ref);
  const failed: FailedEventAdds = { eventIds: [], errors: [] };
  for (const event of events) {
    try {
      if (!(await checkEventChannelExists(ref.planType, event.id))) continue;
      const joined = await addUserToEventChannel(
        ref.planType,
        event.id,
        userId,
        { quiet: true },
      );
      if (joined.reason === "member_not_added") {
        throw new Error("Collaborator not added to the event channel");
      }
    } catch (error) {
      failed.eventIds.push(event.id);
      failed.errors.push(error);
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
  let failedEventIds: string[] = [];
  try {
    const failedAdds = await joinEventChannels(ref, userId);
    failedEventIds = failedAdds.eventIds;
    failures.push(...failedAdds.errors);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    // One report for the whole grant, however many writes failed.
    reportSentryError(failures[0], {
      subsystem: "collaborators",
      op: "grantCollaboratorAccess",
      level: "warning",
      extra: {
        ...ref,
        failed: failures.length,
        eventAddsFailed: failedEventIds.length,
        eventIds: failedEventIds.slice(0, FAILED_EVENT_SAMPLE),
      },
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
