import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import type { AppointmentsType, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import { resolvePlanOwnerIds } from "@/lib/booking/plan-owners";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";
import { isPresenterRole } from "@/lib/collaborators/roles";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import { CALL_MEMBER_ROLE } from "@/lib/stream/call-cid";
import { bookingOrgId } from "@/lib/stream-utils";
import {
  resolveRoomCapSeconds,
  roomTimeCustom,
} from "@/lib/meetings/duration-cap";
import {
  buildCallSettingsOverride,
  resolveCallParticipantLimits,
} from "@/lib/meetings/room-ready";
import { effectiveMaxParticipants } from "@/lib/events/capacity";
import { getPlatformVideoConfig } from "@/lib/stream/video-config";

/** Callers here are already entitled via readSlotForCaller, so syncing the session's other members is allowed. */
export const STREAM_SERVER_TRUSTED = Symbol.for(
  "familiarise.stream.serverTrusted",
);

export const slotIdSchema = z.string().min(1, "Slot ID is required");

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

const collaboratorsSelect = {
  where: {
    status: "ACCEPTED" as const,
    consultantProfile: { deletedAt: null },
  },
  select: { role: true, consultantProfile: ownerProfileSelect },
} as const;

const appointmentAccessSelect = (userId: string) =>
  ({
    appointmentType: true,
    organizationId: true,
    participants: {
      where: { ...liveParticipant(userId), ...NOT_COLLABORATOR_ROW },
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
        maxParticipants: true,
        webinarPlan: {
          select: {
            maxParticipants: true,
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
        maxParticipants: true,
        classPlan: {
          select: {
            maxParticipants: true,
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
export async function readSlotForCaller(slotId: string) {
  const session = await getSession();
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

type SessionCallMember = { user_id: string; role: string };

type SessionCallProfile = {
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
      const upsertResult = await upsertUsersToStream(candidateUserIds, {
        serverTrusted: STREAM_SERVER_TRUSTED,
      });
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

export function resolveAppointmentOrgId(
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

/** The extension a room carries; Postgres `Meeting` owns it and every call payload is derived from it. */
export interface RoomExtension {
  extendedSeconds: number;
  extensionsUsed: number;
}

function buildCallCustom(args: {
  occurrenceId: string;
  appointmentId: string | null | undefined;
  appointmentType: AppointmentsType;
  organizationId: string | null;
  profile: SessionCallProfile | null;
  extension: RoomExtension;
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
          ...roomTimeCustom({
            bookedEndsAt: profile.endsAt,
            ...args.extension,
          }),
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

type AuthorizedSlot = NonNullable<
  Awaited<ReturnType<typeof readSlotForCaller>>
>;

/** Seats sold for a webinar or class instance; null for a 1:1 session. */
function resolveEventCapacity(
  appointment: AuthorizedAppointment,
): number | null {
  const { webinar, class: classEvent } = appointment;
  if (webinar) return effectiveMaxParticipants(webinar, webinar.webinarPlan);
  if (classEvent) {
    return effectiveMaxParticipants(classEvent, classEvent.classPlan);
  }
  return null;
}

/** The one getOrCreate payload a room is created with, whether provisioned or reopened. */
export async function buildRoomCallPlan(
  authorized: AuthorizedSlot,
  extension: RoomExtension,
) {
  const occurrenceId = authorized.slot.id;
  const [profile, videoConfig] = await Promise.all([
    resolveSessionCallProfile(occurrenceId),
    getPlatformVideoConfig(),
  ]);
  const startsAt = profile?.startsAt ?? authorized.slot.startsAt;
  const authorUserId = profile?.hostUserIds[0] ?? authorized.userId;
  if (!profile?.hostUserIds.length) {
    streamLogger.warn("Minting a call without a resolvable host", {
      slotId: occurrenceId,
      authorUserId,
    });
  }

  const { appointmentType } = authorized.appointment;
  const settingsOverride = buildCallSettingsOverride(
    appointmentType,
    profile
      ? resolveRoomCapSeconds(
          startsAt,
          profile.endsAt,
          extension.extendedSeconds,
        )
      : null,
    resolveCallParticipantLimits(
      appointmentType,
      resolveEventCapacity(authorized.appointment),
    ),
    videoConfig,
  );
  const payload = {
    data: {
      created_by_id: authorUserId,
      starts_at: startsAt,
      settings_override: settingsOverride,
      custom: buildCallCustom({
        occurrenceId,
        appointmentId: authorized.slot.appointmentId,
        appointmentType,
        organizationId: resolveAppointmentOrgId(authorized.appointment),
        profile,
        extension,
      }),
      ...(profile && profile.members.length > 0
        ? { members: profile.members }
        : {}),
    },
  };
  return { authorUserId, payload };
}
