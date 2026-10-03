"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import { ConsentRequiredError } from "@/lib/compliance/dpdp";
import { resolveMaxCallDurationSeconds } from "@/lib/meetings/duration-cap";
import { buildCallSettingsOverride } from "@/lib/meetings/room-ready";
import { resolvePlanOwnerIds } from "@/lib/booking/plan-owners";
import { isPresenterRole } from "@/lib/collaborators/roles";
import { getMaintenanceState } from "@/lib/maintenance";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { Meeting } from "@prisma/client";
import type { AppointmentsType } from "@prisma/client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { liveParticipant } from "@/lib/booking/participants";

interface MeetingSlot {
  id: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  isTentative?: boolean;
  appointmentId?: string | null;
}

const slotIdSchema = z.string().min(1, "Slot ID is required");
const streamCallIdSchema = z.string().min(1, "Stream Call ID is required");

/** Stamped when the host closes a room before the scheduled slot ends. */
const ENDED_EARLY_REASON = "ended_early";

const occurrenceSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  isTentative: true,
  appointmentId: true,
  completionStatus: true,
  consultantProfileId: true,
} as const;

export type OccurrenceRow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  appointmentId: string;
  completionStatus: string;
  consultantProfileId: string | null;
};

const ownerProfileSelect = {
  select: { id: true, userId: true, user: { select: { name: true } } },
} as const;
const collaboratorsSelect = {
  where: { status: "ACCEPTED" as const },
  select: { role: true, consultantProfile: ownerProfileSelect },
} as const;

const appointmentAccessSelect = (userId: string) =>
  ({
    appointmentType: true,
    organizationId: true,
    participants: {
      where: liveParticipant(userId),
      select: { id: true },
      take: 1,
    },
    consultation: {
      select: {
        consultationPlan: {
          select: { title: true, consultantProfile: ownerProfileSelect },
        },
      },
    },
    subscription: {
      select: {
        subscriptionPlan: {
          select: { title: true, consultantProfile: ownerProfileSelect },
        },
      },
    },
    webinar: {
      select: {
        webinarPlan: {
          select: {
            title: true,
            consultantProfile: ownerProfileSelect,
            collaborators: collaboratorsSelect,
          },
        },
      },
    },
    class: {
      select: {
        classPlan: {
          select: {
            title: true,
            consultantProfile: ownerProfileSelect,
            collaborators: collaboratorsSelect,
          },
        },
      },
    },
    trial: {
      select: {
        subscriptionPlan: {
          select: { title: true, consultantProfile: ownerProfileSelect },
        },
      },
    },
  }) satisfies Prisma.AppointmentSelect;

/** Loads an occurrence and its appointment only when the caller is entitled to the session. */
async function readSlotForCaller(slotId: string) {
  const session = await getSession(true);
  const userId = session?.user?.id;
  if (!userId || session.user.banned === true) return null;

  const row = await prisma.appointmentOccurrence.findUnique({
    where: { id: slotId },
    select: {
      ...occurrenceSelect,
      appointment: { select: appointmentAccessSelect(userId) },
    },
  });
  if (!row?.appointment) return null;

  const { appointment, ...slot } = row;
  const consultantProfileId = session.user.consultantProfileId;
  const entitled =
    appointment.participants.length > 0 ||
    (!!consultantProfileId &&
      resolvePlanOwnerIds(appointment).includes(consultantProfileId)) ||
    isPrivileged(session.user.role);

  if (!entitled) {
    streamLogger.warn("Rejected meeting resolution for unrelated caller", {
      slotId,
      userId,
    });
    return null;
  }

  return { slot, appointment, userId };
}

class MeetingRefusal extends Error {}

async function requireEntitledCaller(slotId: string): Promise<void> {
  if (!(await readSlotForCaller(slotId))) {
    throw new MeetingRefusal("You are not a participant in this session.");
  }
}

const slotSchema = z.object({
  id: z.string().min(1),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  isTentative: z.boolean().optional(),
  appointmentId: z.string().nullable().optional(),
});

const CALL_MEMBER_ROLE = "call_member";

export type SessionCallMember = { user_id: string; role: string };

export type SessionCallProfile = {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  offeringTitle: string | null;
  members: SessionCallMember[];
  hostUserIds: string[];
  hostControlUserIds: string[];
  guestUserIds: string[];
  hostName: string | null;
  guestName: string | null;
};

/** Resolves session bounds, offering title, and Stream call members for an occurrence. */
async function resolveSessionCallProfile(
  anchorSlotId: string,
): Promise<SessionCallProfile | null> {
  const validatedSlotId = slotIdSchema.parse(anchorSlotId);

  try {
    const authorized = await readSlotForCaller(validatedSlotId);
    if (!authorized) return null;
    const { slot: anchor, appointment } = authorized;
    if (!anchor.appointmentId) return null;

    const isGroupEvent =
      appointment.appointmentType === "WEBINAR" ||
      appointment.appointmentType === "CLASS";
    if (isDeadOccurrence(anchor)) return null;
    const run = { startsAt: anchor.startsAt, endsAt: anchor.endsAt };

    const profileToUser = new Map<string, string>();
    const userToName = new Map<string, string>();
    const remember = (
      profile?: {
        id: string;
        userId: string;
        user?: { name?: string | null } | null;
      } | null,
    ) => {
      if (!profile) return;
      profileToUser.set(profile.id, profile.userId);
      if (profile.user?.name) userToName.set(profile.userId, profile.user.name);
    };
    remember(appointment.consultation?.consultationPlan?.consultantProfile);
    remember(appointment.subscription?.subscriptionPlan?.consultantProfile);
    remember(appointment.webinar?.webinarPlan?.consultantProfile);
    remember(appointment.class?.classPlan?.consultantProfile);
    remember(appointment.trial?.subscriptionPlan?.consultantProfile);
    for (const collaborator of [
      ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
      ...(appointment.class?.classPlan?.collaborators ?? []),
    ]) {
      remember(collaborator.consultantProfile);
    }

    const hostUserIds = [
      ...new Set(
        resolvePlanOwnerIds(appointment)
          .map((profileId) => profileToUser.get(profileId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];
    const presenterProfileIds = new Set(
      [
        ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
        ...(appointment.class?.classPlan?.collaborators ?? []),
      ]
        .filter((collaborator) => isPresenterRole(collaborator.role))
        .map((collaborator) => collaborator.consultantProfile?.id),
    );
    const ownerProfileId =
      appointment.consultation?.consultationPlan?.consultantProfile?.id ??
      appointment.subscription?.subscriptionPlan?.consultantProfile?.id ??
      appointment.webinar?.webinarPlan?.consultantProfile?.id ??
      appointment.class?.classPlan?.consultantProfile?.id ??
      appointment.trial?.subscriptionPlan?.consultantProfile?.id ??
      null;
    const hostControlUserIds = [
      ...new Set(
        [ownerProfileId, ...presenterProfileIds]
          .map((profileId) => (profileId ? profileToUser.get(profileId) : null))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];

    const hosts = new Set(hostUserIds);
    const attendees = isGroupEvent
      ? []
      : await prisma.appointmentParticipant.findMany({
          where: { appointmentId: anchor.appointmentId, ...liveParticipant() },
          select: { user: { select: { id: true, name: true } } },
        });
    for (const { user: attendee } of attendees) {
      if (attendee.name) userToName.set(attendee.id, attendee.name);
    }
    const guestUserIds = [
      ...new Set(attendees.map(({ user }) => user.id)),
    ].filter((userId) => !hosts.has(userId));

    const offeringTitle =
      appointment.consultation?.consultationPlan?.title ??
      appointment.subscription?.subscriptionPlan?.title ??
      appointment.webinar?.webinarPlan?.title ??
      appointment.class?.classPlan?.title ??
      appointment.trial?.subscriptionPlan?.title ??
      null;

    // Exclude unconsented users from Stream call members while keeping session bounds for max_duration_seconds.
    const candidateUserIds = [...hostUserIds, ...guestUserIds];
    let droppedIds = new Set<string>();
    try {
      const upsertResult = (await upsertUsersToStream(candidateUserIds)) as
        | { droppedIds?: string[] }
        | undefined;
      if (Array.isArray(upsertResult?.droppedIds)) {
        droppedIds = new Set(upsertResult.droppedIds);
      }
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        streamLogger.info(
          "Filtering unconsented participants from call members while retaining session bounds",
          { anchorSlotId: validatedSlotId, purposeCode: err.purposeCode },
        );
        droppedIds = new Set(candidateUserIds);
      } else {
        throw err;
      }
    }

    return {
      startsAt: run.startsAt,
      endsAt: run.endsAt,
      durationMinutes: Math.round(
        (run.endsAt.getTime() - run.startsAt.getTime()) / 60_000,
      ),
      offeringTitle,
      members: candidateUserIds
        .filter((user_id) => !droppedIds.has(user_id))
        .map((user_id) => ({
          user_id,
          role: CALL_MEMBER_ROLE,
        })),
      hostUserIds,
      hostControlUserIds,
      guestUserIds,
      hostName: userToName.get(hostUserIds[0] ?? "") ?? null,
      guestName: userToName.get(guestUserIds[0] ?? "") ?? null,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to resolve session call profile", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

async function findDbMeetingBySlot(slotId: string): Promise<Meeting | null> {
  const validatedSlotId = slotIdSchema.parse(slotId);

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { appointmentOccurrenceId: validatedSlotId },
    });

    if (meeting) {
      streamLogger.debug("Found existing meeting session", {
        sessionId: meeting.id,
        slotId: validatedSlotId,
      });
    } else {
      streamLogger.debug("No existing meeting session found", {
        slotId: validatedSlotId,
      });
    }

    return meeting;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Error finding meeting session", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

async function refuseMeetingCreation(
  slot: MeetingSlot,
): Promise<string | null> {
  const maintenanceState = await getMaintenanceState();
  if (maintenanceState.phase !== "OFF") {
    return "New calls cannot be created during maintenance.";
  }

  const parsedSlot = slotSchema.safeParse({
    id: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    isTentative: slot.isTentative,
    appointmentId: slot.appointmentId,
  });
  if (!parsedSlot.success) {
    return `Invalid slot for meeting session: ${parsedSlot.error.issues
      .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
      .join("; ")}`;
  }

  const dbSlot = await prisma.appointmentOccurrence.findUnique({
    where: { id: parsedSlot.data.id },
    select: {
      isTentative: true,
      completionStatus: true,
      deletedAt: true,
      appointment: {
        select: {
          deletedAt: true,
          consultation: { select: { status: true } },
          subscription: { select: { status: true } },
          webinar: { select: { status: true } },
          class: { select: { status: true } },
          trial: { select: { status: true } },
        },
      },
    },
  });
  if (!dbSlot) {
    return "Session slot not found.";
  }
  if (dbSlot.isTentative) {
    return "This session is not confirmed yet.";
  }
  if (
    dbSlot.deletedAt ||
    dbSlot.completionStatus === "CANCELLED" ||
    dbSlot.completionStatus === "RESCHEDULED"
  ) {
    return "This session was cancelled or moved.";
  }
  const appt = dbSlot.appointment;
  if (!appt) return null;
  const bookingStatus =
    appt.consultation?.status ??
    appt.subscription?.status ??
    appt.webinar?.status ??
    appt.class?.status ??
    (appt.trial?.status === "CANCELLED" || appt.trial?.status === "REJECTED"
      ? "CANCELLED"
      : null);
  if (
    appt.deletedAt ||
    (bookingStatus && TERMINAL_APPOINTMENT_STATUSES.has(bookingStatus))
  ) {
    return "This booking is no longer active.";
  }

  return null;
}

const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

async function getMeetingCreationRefusal(
  slot: MeetingSlot,
): Promise<string | null> {
  try {
    const refusal = await refuseMeetingCreation(slot);
    if (refusal) {
      streamLogger.warn("Refused a meeting before creating the call", {
        slotId: slot.id,
        reason: refusal,
      });
    }
    return refusal;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to pre-check meeting creation", error, {
      slotId: slot.id,
    });
    return "We could not verify this session just now. Please try again.";
  }
}

async function readAppointmentOrganizationId(
  appointmentId: string | null | undefined,
): Promise<string | null> {
  if (!appointmentId) return null;
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { organizationId: true },
  });
  return appointment?.organizationId ?? null;
}

/** Persists the Meeting row for an occurrence after verifying caller entitlement and booking state. */
export async function createDbMeeting(
  slot: MeetingSlot,
  streamCallId: string,
): Promise<Meeting> {
  try {
    await requireEntitledCaller(slot.id);

    const refusal = await refuseMeetingCreation(slot);
    if (refusal) throw new MeetingRefusal(refusal);

    const validatedStreamCallId = streamCallIdSchema.parse(streamCallId);

    streamLogger.debug("Creating meeting session", {
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    const organizationId = await readAppointmentOrganizationId(
      slot.appointmentId,
    );

    const meeting = await prisma.meeting.create({
      data: {
        streamCallId: validatedStreamCallId,
        platform: "STREAM",
        occurrence: {
          connect: { id: slot.id },
        },
        ...(organizationId
          ? { organization: { connect: { id: organizationId } } }
          : {}),
      },
    });

    streamLogger.info("Meeting session created", {
      sessionId: meeting.id,
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    return meeting;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      streamLogger.info(
        "Meeting session already exists (concurrent creation), returning existing",
        { slotId: slot.id },
      );
      const existing = await prisma.meeting.findUnique({
        where: { appointmentOccurrenceId: slot.id },
      });
      if (existing) return existing;
    }

    if (error instanceof MeetingRefusal) {
      streamLogger.warn("Refused to create meeting session", {
        slotId: slot.id,
        streamCallId,
        reason: error.message,
      });
      throw new Error(error.message);
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to create meeting session", error, {
      slotId: slot.id,
      streamCallId,
    });

    if (error instanceof Error) {
      throw new Error(`Failed to create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while creating the meeting session.",
    );
  }
}

interface CallDescription {
  title: string;
  description: string;
}

function describeCall(
  appointmentType: AppointmentsType,
  appointmentId: string | null | undefined,
  profile: SessionCallProfile | null,
): CallDescription {
  const offeringTitle = profile?.offeringTitle ?? null;
  const guestName = profile?.guestName ?? null;

  if (guestName) {
    return {
      title: `${appointmentType} with ${guestName}`,
      description: `${appointmentType} Meeting`,
    };
  }
  if (appointmentType === "WEBINAR" && offeringTitle) {
    return {
      title: `Webinar: ${offeringTitle}`,
      description: `Webinar Session for ${offeringTitle}`,
    };
  }
  if (appointmentType === "CLASS" && offeringTitle) {
    return {
      title: `Class: ${offeringTitle}`,
      description: `Class Session for ${offeringTitle}`,
    };
  }
  return {
    title: `Meeting for Appointment ${appointmentId ?? "unknown"}`,
    description: `${appointmentType} Meeting`,
  };
}

function buildCallCustom(args: {
  occurrenceId: string;
  appointmentId: string | null | undefined;
  appointmentType: AppointmentsType;
  organizationId: string | null;
  profile: SessionCallProfile | null;
}): Record<string, unknown> {
  const { profile } = args;
  const { title, description } = describeCall(
    args.appointmentType,
    args.appointmentId,
    profile,
  );

  const consultantUserId = profile?.hostUserIds[0] ?? null;
  const consulteeUserId = profile?.guestUserIds[0] ?? null;
  const hostUserIds = profile?.hostControlUserIds ?? [];

  return {
    title,
    description,
    appointmentId: args.appointmentId ?? null,
    slotId: args.occurrenceId,
    occurrenceId: args.occurrenceId,
    appointmentType: args.appointmentType,
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(consultantUserId ? { consultantUserId } : {}),
    ...(hostUserIds.length > 0 ? { hostUserIds } : {}),
    ...(consulteeUserId ? { consulteeUserId } : {}),
    ...(profile
      ? {
          sessionStartsAt: profile.startsAt.toISOString(),
          sessionEndsAt: profile.endsAt.toISOString(),
          sessionDurationMinutes: profile.durationMinutes,
          ...(profile.offeringTitle
            ? { offeringTitle: profile.offeringTitle }
            : {}),
          ...(profile.hostName ? { hostName: profile.hostName } : {}),
          ...(profile.guestName ? { guestName: profile.guestName } : {}),
        }
      : {}),
  };
}

export type ProvisionedMeeting =
  | { ok: true; streamCallId: string }
  | { ok: false; refusal: string };

/** Provisions or reuses the Stream call and database Meeting row for an occurrence. */
export async function provisionAppointmentMeeting(
  slot: MeetingSlot,
): Promise<ProvisionedMeeting> {
  const anchorSlot: MeetingSlot = slot;

  const existingMeeting = await findDbMeetingBySlot(anchorSlot.id);
  const rebuildEndedEarly = existingMeeting?.endedReason === ENDED_EARLY_REASON;
  if (existingMeeting && !rebuildEndedEarly) {
    return { ok: true, streamCallId: existingMeeting.streamCallId };
  }

  const authorized = await readSlotForCaller(anchorSlot.id);
  if (!authorized) {
    return { ok: false, refusal: "You are not a participant in this session." };
  }

  const refusal = await getMeetingCreationRefusal(anchorSlot);
  if (refusal) return { ok: false, refusal };

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured — cannot provision meeting", {
      slotId: anchorSlot.id,
    });
    return { ok: false, refusal: "Video is not available right now." };
  }

  const streamCallId = rebuildEndedEarly
    ? `occurrence-${anchorSlot.id}-r${Date.now().toString(36)}`
    : `occurrence-${anchorSlot.id}`;
  const callProfile = await resolveSessionCallProfile(anchorSlot.id);

  const startsAt =
    callProfile?.startsAt ??
    (anchorSlot.startsAt ? new Date(anchorSlot.startsAt) : new Date());

  const authorUserId = callProfile?.hostUserIds[0] ?? authorized.userId;

  const maxDurationSeconds = resolveMaxCallDurationSeconds(
    callProfile,
    startsAt,
  );
  if (!callProfile?.hostUserIds.length) {
    streamLogger.warn("Minting a call without a resolvable host", {
      slotId: anchorSlot.id,
      authorUserId,
    });
  }

  const settingsOverride = buildCallSettingsOverride(
    authorized.appointment.appointmentType,
    maxDurationSeconds,
  );

  try {
    await withStreamCircuitBreaker(async () => {
      try {
        await upsertUsersToStream([authorUserId]);
      } catch (err) {
        if (!(err instanceof ConsentRequiredError)) throw err;
      }

      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        streamCallId,
      );
      await call.getOrCreate({
        data: {
          created_by_id: authorUserId,
          starts_at: startsAt,
          ...(settingsOverride ? { settings_override: settingsOverride } : {}),
          custom: buildCallCustom({
            occurrenceId: anchorSlot.id,
            appointmentId: anchorSlot.appointmentId,
            appointmentType: authorized.appointment.appointmentType,
            organizationId: authorized.appointment.organizationId ?? null,
            profile: callProfile,
          }),
          ...(callProfile && callProfile.members.length > 0
            ? { members: callProfile.members }
            : {}),
        },
      });
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to create the Stream call", error, {
      slotId: anchorSlot.id,
      streamCallId,
    });
    throw error instanceof Error
      ? new Error(`Failed to create meeting session: ${error.message}`, {
          cause: error,
        })
      : new Error("Failed to create meeting session.", { cause: error });
  }

  if (rebuildEndedEarly && existingMeeting) {
    const rebound = await prisma.meeting.updateMany({
      where: { id: existingMeeting.id, endedReason: ENDED_EARLY_REASON },
      data: {
        streamCallId,
        endedAt: null,
        endedReason: null,
        isRecording: false,
      },
    });
    if (rebound.count === 0) {
      const current = await prisma.meeting.findUnique({
        where: { id: existingMeeting.id },
        select: { streamCallId: true },
      });
      return {
        ok: true,
        streamCallId: current?.streamCallId ?? streamCallId,
      };
    }
    streamLogger.info("Rebuilt the room after an early end", {
      sessionId: existingMeeting.id,
      slotId: anchorSlot.id,
      previousStreamCallId: existingMeeting.streamCallId,
      streamCallId,
    });
    return { ok: true, streamCallId };
  }

  await createDbMeeting(anchorSlot, streamCallId);

  return { ok: true, streamCallId };
}
