"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  CONSULTEE_JOIN_WINDOW_MS,
  REJOIN_GRACE_MS,
  getOccurrenceJoinState,
  isDeadOccurrence,
  isDeliberateEnd,
} from "@/lib/appointments/occurrences";
import { isConfirmedStatus } from "@/lib/appointments/status";
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
import { bookingOrgId } from "@/lib/stream-utils";
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

const ownerProfileSelect = {
  select: {
    id: true,
    userId: true,
    user: { select: { id: true, name: true } },
  },
} as const;

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
          select: {
            title: true,
            organizationId: true,
            consultantProfile: ownerProfileSelect,
          },
        },
      },
    },
    subscription: {
      select: {
        subscriptionPlan: {
          select: {
            title: true,
            organizationId: true,
            consultantProfile: ownerProfileSelect,
          },
        },
      },
    },
    webinar: {
      select: {
        webinarPlan: {
          select: {
            title: true,
            organizationId: true,
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
            organizationId: true,
            consultantProfile: ownerProfileSelect,
            collaborators: collaboratorsSelect,
          },
        },
      },
    },
    trial: {
      select: {
        subscriptionPlan: {
          select: {
            title: true,
            organizationId: true,
            consultantProfile: ownerProfileSelect,
          },
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
      (slot.consultantProfileId === consultantProfileId ||
        resolvePlanOwnerIds(appointment).includes(consultantProfileId))) ||
    isPrivileged(session.user.role);

  if (!entitled) {
    streamLogger.warn("Rejected meeting resolution for unrelated caller", {
      slotId,
      userId,
    });
    return null;
  }

  return { slot, appointment, userId, consultantProfileId };
}

class MeetingRefusal extends Error {}

async function requireEntitledCaller(slotId: string) {
  const authorized = await readSlotForCaller(slotId);
  if (!authorized) {
    throw new MeetingRefusal("You are not a participant in this session.");
  }
  return authorized;
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

type AuthorizedSlotRead = NonNullable<
  Awaited<ReturnType<typeof readSlotForCaller>>
>;
type AuthorizedAppointment = AuthorizedSlotRead["appointment"];
type ProfileEntry = {
  id: string;
  userId?: string | null;
  user?: { id?: string | null; name?: string | null } | null;
};

function rememberProfile(
  profile: ProfileEntry | null | undefined,
  profileToUser: Map<string, string>,
  userToName: Map<string, string>,
): void {
  if (!profile) return;
  const resolvedUserId = profile.userId ?? profile.user?.id ?? null;
  if (!resolvedUserId) return;
  profileToUser.set(profile.id, resolvedUserId);
  if (profile.user?.name) {
    userToName.set(resolvedUserId, profile.user.name);
  }
}

function collectAppointmentProfiles(
  appointment: AuthorizedAppointment,
  profileToUser: Map<string, string>,
  userToName: Map<string, string>,
): void {
  const planProfiles = [
    appointment.consultation?.consultationPlan?.consultantProfile,
    appointment.subscription?.subscriptionPlan?.consultantProfile,
    appointment.webinar?.webinarPlan?.consultantProfile,
    appointment.class?.classPlan?.consultantProfile,
    appointment.trial?.subscriptionPlan?.consultantProfile,
  ];
  for (const profile of planProfiles) {
    rememberProfile(profile, profileToUser, userToName);
  }
  const collaborators = [
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
    ...(appointment.class?.classPlan?.collaborators ?? []),
  ];
  for (const collaborator of collaborators) {
    rememberProfile(collaborator.consultantProfile, profileToUser, userToName);
  }
}

async function ensureOccurrenceProfileMapped(args: {
  occurrenceProfileId: string | null;
  callerConsultantProfileId: string | null | undefined;
  callerUserId: string;
  profileToUser: Map<string, string>;
  userToName: Map<string, string>;
}): Promise<void> {
  const { occurrenceProfileId, profileToUser, userToName } = args;
  if (!occurrenceProfileId || profileToUser.has(occurrenceProfileId)) return;
  if (args.callerConsultantProfileId === occurrenceProfileId) {
    profileToUser.set(occurrenceProfileId, args.callerUserId);
    return;
  }
  const occProfile = await prisma.consultantProfile.findUnique({
    where: { id: occurrenceProfileId },
    ...ownerProfileSelect,
  });
  rememberProfile(occProfile, profileToUser, userToName);
}

function resolveOwnerProfileId(
  appointment: AuthorizedAppointment,
): string | null {
  return (
    appointment.consultation?.consultationPlan?.consultantProfile?.id ??
    appointment.subscription?.subscriptionPlan?.consultantProfile?.id ??
    appointment.webinar?.webinarPlan?.consultantProfile?.id ??
    appointment.class?.classPlan?.consultantProfile?.id ??
    appointment.trial?.subscriptionPlan?.consultantProfile?.id ??
    null
  );
}

function resolveHostIdentitySets(
  occurrenceProfileId: string | null,
  appointment: AuthorizedAppointment,
  profileToUser: Map<string, string>,
): { hostUserIds: string[]; hostControlUserIds: string[] } {
  const hostProfileIds = [
    ...(occurrenceProfileId ? [occurrenceProfileId] : []),
    ...resolvePlanOwnerIds(appointment),
  ];
  const occurrenceAssignedUserId = occurrenceProfileId
    ? (profileToUser.get(occurrenceProfileId) ?? null)
    : null;
  const hostUserIds = [
    ...new Set([
      ...(occurrenceAssignedUserId ? [occurrenceAssignedUserId] : []),
      ...hostProfileIds
        .map((profileId) => profileToUser.get(profileId))
        .filter((userId): userId is string => Boolean(userId)),
    ]),
  ];
  const presenterProfileIds = [
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
    ...(appointment.class?.classPlan?.collaborators ?? []),
  ]
    .filter((collaborator) => isPresenterRole(collaborator.role))
    .map((collaborator) => collaborator.consultantProfile?.id);
  const ownerProfileId = resolveOwnerProfileId(appointment);
  const hostControlUserIds = [
    ...new Set([
      ...(occurrenceAssignedUserId ? [occurrenceAssignedUserId] : []),
      ...[occurrenceProfileId, ownerProfileId, ...presenterProfileIds]
        .map((profileId) => (profileId ? profileToUser.get(profileId) : null))
        .filter((userId): userId is string => Boolean(userId)),
    ]),
  ];
  return { hostUserIds, hostControlUserIds };
}

async function resolveGuestUserIds(
  appointmentId: string,
  isGroupEvent: boolean,
  hostUserIds: string[],
  userToName: Map<string, string>,
): Promise<string[]> {
  if (isGroupEvent) return [];
  const hosts = new Set(hostUserIds);
  const attendees = await prisma.appointmentParticipant.findMany({
    where: { appointmentId, ...liveParticipant() },
    select: { user: { select: { id: true, name: true } } },
  });
  for (const { user: attendee } of attendees) {
    if (attendee.name) userToName.set(attendee.id, attendee.name);
  }
  return [...new Set(attendees.map(({ user }) => user.id))].filter(
    (userId) => !hosts.has(userId),
  );
}

function resolveOfferingTitle(
  appointment: AuthorizedAppointment,
): string | null {
  return (
    appointment.consultation?.consultationPlan?.title ??
    appointment.subscription?.subscriptionPlan?.title ??
    appointment.webinar?.webinarPlan?.title ??
    appointment.class?.classPlan?.title ??
    appointment.trial?.subscriptionPlan?.title ??
    null
  );
}

/** Resolves session bounds, offering title, and Stream call members for an occurrence. */
async function resolveSessionCallProfile(
  anchorSlotId: string,
): Promise<SessionCallProfile | null> {
  const validatedSlotId = slotIdSchema.parse(anchorSlotId);

  try {
    const authorized = await readSlotForCaller(validatedSlotId);
    if (!authorized) return null;
    const {
      slot: anchor,
      appointment,
      userId: callerUserId,
      consultantProfileId: callerConsultantProfileId,
    } = authorized;
    if (!anchor.appointmentId || isDeadOccurrence(anchor)) return null;

    const isGroupEvent =
      appointment.appointmentType === "WEBINAR" ||
      appointment.appointmentType === "CLASS";
    const profileToUser = new Map<string, string>();
    const userToName = new Map<string, string>();
    collectAppointmentProfiles(appointment, profileToUser, userToName);
    await ensureOccurrenceProfileMapped({
      occurrenceProfileId: anchor.consultantProfileId,
      callerConsultantProfileId,
      callerUserId,
      profileToUser,
      userToName,
    });

    const { hostUserIds, hostControlUserIds } = resolveHostIdentitySets(
      anchor.consultantProfileId,
      appointment,
      profileToUser,
    );
    const guestUserIds = await resolveGuestUserIds(
      anchor.appointmentId,
      isGroupEvent,
      hostUserIds,
      userToName,
    );

    const candidateUserIds = [...hostUserIds, ...guestUserIds];
    let droppedIds = new Set<string>();
    try {
      const upsertResult = await upsertUsersToStream(candidateUserIds);
      droppedIds = new Set(upsertResult?.droppedIds ?? []);
    } catch (upsertError) {
      streamLogger.warn(
        "Best-effort member upsert failed while resolving session call profile",
        {
          slotId: validatedSlotId,
          error:
            upsertError instanceof Error
              ? upsertError.message
              : String(upsertError),
        },
      );
    }

    return {
      startsAt: anchor.startsAt,
      endsAt: anchor.endsAt,
      durationMinutes: Math.round(
        (anchor.endsAt.getTime() - anchor.startsAt.getTime()) / 60_000,
      ),
      offeringTitle: resolveOfferingTitle(appointment),
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
      startsAt: true,
      endsAt: true,
      isTentative: true,
      completionStatus: true,
      deletedAt: true,
      meeting: {
        select: { id: true, endedAt: true, endedReason: true },
      },
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
  if (isDeadOccurrence(dbSlot)) {
    return "This session was cancelled or moved.";
  }
  if (isDeliberateEnd(dbSlot.meeting)) {
    return "This session has already ended.";
  }
  const appt = dbSlot.appointment;
  if (appt) {
    if (appt.deletedAt) {
      return "This booking is no longer active.";
    }
    const bookingStatus =
      appt.consultation?.status ??
      appt.subscription?.status ??
      appt.webinar?.status ??
      appt.class?.status ??
      appt.trial?.status ??
      null;
    if (bookingStatus && TERMINAL_APPOINTMENT_STATUSES.has(bookingStatus)) {
      return "This booking is no longer active.";
    }
    if (bookingStatus && !isConfirmedStatus(bookingStatus)) {
      return "This booking is not confirmed yet.";
    }
  }

  if (process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS !== "true") {
    const joinState = getOccurrenceJoinState(
      {
        id: parsedSlot.data.id,
        startsAt: dbSlot.startsAt,
        endsAt: dbSlot.endsAt,
        isTentative: dbSlot.isTentative,
        completionStatus: dbSlot.completionStatus,
        deletedAt: dbSlot.deletedAt,
        meeting: dbSlot.meeting,
      },
      {
        joinWindowMs: Math.max(
          CONSULTANT_JOIN_WINDOW_MS,
          CONSULTEE_JOIN_WINDOW_MS,
        ),
        rejoinGraceMs: REJOIN_GRACE_MS,
      },
    );
    if (joinState === "countdown") {
      return "This meeting room is not open yet. You can join up to 15 minutes before the start time.";
    }
    if (joinState === "ended") {
      return "This session has ended.";
    }
  }

  return null;
}

const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "COMPLETED",
  "CONVERTED",
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

function resolveAppointmentOrgId(
  appointment: {
    organizationId?: string | null;
    consultation?: {
      consultationPlan?: { organizationId?: string | null } | null;
    } | null;
    subscription?: {
      subscriptionPlan?: { organizationId?: string | null } | null;
    } | null;
    webinar?: {
      webinarPlan?: { organizationId?: string | null } | null;
    } | null;
    class?: {
      classPlan?: { organizationId?: string | null } | null;
    } | null;
    trial?: {
      subscriptionPlan?: { organizationId?: string | null } | null;
    } | null;
  } | null,
): string | null {
  if (!appointment) return null;
  return bookingOrgId({
    consultationPlan: appointment.consultation?.consultationPlan
      ? {
          organizationId:
            appointment.consultation.consultationPlan.organizationId ?? null,
        }
      : null,
    subscriptionPlan:
      appointment.subscription?.subscriptionPlan ||
      appointment.trial?.subscriptionPlan
        ? {
            organizationId:
              appointment.subscription?.subscriptionPlan?.organizationId ??
              appointment.trial?.subscriptionPlan?.organizationId ??
              null,
          }
        : null,
    webinarPlan: appointment.webinar?.webinarPlan
      ? {
          organizationId:
            appointment.webinar.webinarPlan.organizationId ?? null,
        }
      : null,
    classPlan: appointment.class?.classPlan
      ? {
          organizationId: appointment.class.classPlan.organizationId ?? null,
        }
      : null,
    appointment: { organizationId: appointment.organizationId ?? null },
  });
}

async function readAppointmentOrganizationId(
  appointmentId: string | null | undefined,
): Promise<string | null> {
  if (!appointmentId) return null;
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      organizationId: true,
      consultation: {
        select: { consultationPlan: { select: { organizationId: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { organizationId: true } } },
      },
      webinar: {
        select: { webinarPlan: { select: { organizationId: true } } },
      },
      class: {
        select: { classPlan: { select: { organizationId: true } } },
      },
      trial: {
        select: { subscriptionPlan: { select: { organizationId: true } } },
      },
    },
  });
  return resolveAppointmentOrgId(appointment);
}

/** Persists the Meeting row for an occurrence after verifying caller entitlement and booking state. */
export async function createDbMeeting(
  slot: MeetingSlot,
  streamCallId: string,
): Promise<Meeting> {
  try {
    const authorized = await requireEntitledCaller(slot.id);

    const refusal = await refuseMeetingCreation(slot);
    if (refusal) throw new MeetingRefusal(refusal);

    const validatedStreamCallId = streamCallIdSchema.parse(streamCallId);

    streamLogger.debug("Creating meeting session", {
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    const organizationId =
      resolveAppointmentOrgId(authorized.appointment) ??
      (await readAppointmentOrganizationId(authorized.slot.appointmentId));

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
    ...(args.organizationId
      ? {
          organizationId: args.organizationId,
          organization_id: args.organizationId,
        }
      : {}),
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
  { ok: true; streamCallId: string } | { ok: false; refusal: string };

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
    (anchorSlot.startsAt
      ? new Date(anchorSlot.startsAt)
      : authorized.slot.startsAt);

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
  const resolvedAppointmentId = authorized.slot.appointmentId;
  const resolvedOrganizationId = resolveAppointmentOrgId(
    authorized.appointment,
  );

  try {
    await withStreamCircuitBreaker(async () => {
      await upsertUsersToStream([authorUserId]);

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
            appointmentId: resolvedAppointmentId,
            appointmentType: authorized.appointment.appointmentType,
            organizationId: resolvedOrganizationId,
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

  await createDbMeeting(
    { ...anchorSlot, appointmentId: resolvedAppointmentId },
    streamCallId,
  );

  return { ok: true, streamCallId };
}
