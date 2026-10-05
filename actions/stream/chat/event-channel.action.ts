"use server";

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  initialSyncCompletedUsers,
  clearSyncCacheForUser,
} from "@/lib/stream-cache";
import { upsertUserToStream } from "./user.action";
import { MANAGED_CHANNEL_PREFIXES } from "@/lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import {
  dmEligibleStatusFilter,
  OPENABLE_EVENT_STATUSES,
} from "@/lib/stream/dm-eligibility-statuses";
import { queryChannelsPaged } from "@/lib/stream/batch";
import { ConsentRequiredError } from "@/lib/compliance/dpdp";
import { isUpsertRefusal } from "@/lib/stream/connect-failure";
import {
  DEFAULT_RETENTION_DAYS,
  isPastRetention,
} from "@/lib/stream/channel-lifecycle";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { Refusal, type RefusalShape } from "@/lib/errors/refusal";
import {
  addUserToEventChannel as addUserToEventChannelInternal,
  checkEventChannelExists as checkEventChannelExistsInternal,
  eventIdSchema,
  eventTypeSchema,
  getChannelId,
  getEventData,
  isEventParticipant,
  removeUserFromEventChannel as removeUserFromEventChannelInternal,
  resolveEventRetentionDays,
  STREAM_SERVER_TRUSTED,
  userIdSchema,
  type EventType,
} from "@/lib/stream/event-channel-service";

type EventChannelActorCheck = { ok: true } | { ok: false; refusal: Refusal };

async function isEventChannelHost(
  userId: string,
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  try {
    const eventData = await getEventData(eventType, eventId);
    return eventData?.consultantId === userId;
  } catch (error) {
    streamLogger.warn("Could not resolve event host; denying cross-user act", {
      eventType,
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function isUserEnrolledInEvent(
  userId: string,
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  if (eventType === "webinar" || eventType === "class") {
    return isEventParticipant(eventType, eventId, userId);
  }
  const eventData = await getEventData(eventType, eventId);
  if (!eventData) return false;
  return (
    eventData.consultantId === userId || eventData.members.includes(userId)
  );
}

async function requireEventChannelActor(
  forUserId: string,
  eventType: EventType,
  eventId: string,
  {
    allowEventHost = false,
    allowSelfWithoutEnrollment = false,
  }: {
    allowEventHost?: boolean;
    allowSelfWithoutEnrollment?: boolean;
  } = {},
): Promise<EventChannelActorCheck> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return {
      ok: false,
      refusal: new Refusal({
        code: "UNAUTHENTICATED",
        httpStatus: 401,
        userMessage: "Please sign in again to continue.",
        devMessage: "Unauthorized: sign in to manage event channel membership",
      }),
    };
  }
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }
  if (
    isPrivileged(session.user.role) ||
    (allowEventHost &&
      (await isEventChannelHost(session.user.id, eventType, eventId)))
  ) {
    return { ok: true };
  }
  if (session.user.id === forUserId) {
    if (
      allowSelfWithoutEnrollment ||
      (await isUserEnrolledInEvent(session.user.id, eventType, eventId))
    ) {
      return { ok: true };
    }
    throw new Error("Forbidden: not a participant in this event");
  }
  throw new Error(
    "Forbidden: cannot manage event channel membership for another user",
  );
}

export async function checkEventChannelExists(
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  const session = await getSession(true);
  if (!session?.user?.id || session.user.banned) {
    return false;
  }
  return checkEventChannelExistsInternal(eventType, eventId);
}

export async function addUserToEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{
  success: boolean;
  channelId: string;
  created?: boolean;
  refusal?: RefusalShape;
}> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);

  const actor = await requireEventChannelActor(userId, eventType, eventId);
  if (!actor.ok) {
    streamLogger.warn("Refused event channel join", {
      channelId,
      eventType,
      eventId,
      userId,
      reason: actor.refusal.devMessage,
    });
    return {
      success: false,
      channelId,
      refusal: actor.refusal.toShape(),
    };
  }

  return addUserToEventChannelInternal(eventType, eventId, userId);
}

export async function removeUserFromEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);

  const actor = await requireEventChannelActor(userId, eventType, eventId, {
    allowEventHost: true,
    allowSelfWithoutEnrollment: true,
  });
  if (!actor.ok) {
    streamLogger.warn("Refused event channel removal", {
      channelId,
      eventType,
      eventId,
      userId,
      reason: actor.refusal.devMessage,
    });
    return { success: false };
  }

  return removeUserFromEventChannelInternal(eventType, eventId, userId);
}

interface DmPair {
  consultantUserId: string;
  consulteeUserId: string;
  organizationId: string | null;
}

export async function syncUserEventChannels(
  userId: string,
  force = false,
): Promise<{
  success: boolean;
  skipped?: boolean;
  error?: string;
  refusal?: RefusalShape;
  channelsSynced?: number;
  failed?: number;
  staleChannelsRemoved?: number;
  degraded?: boolean;
  durationMs?: number;
}> {
  userIdSchema.parse(userId);

  const session = await getSession(true);
  if (!session?.user?.id) {
    const refusal = new Refusal({
      code: "UNAUTHENTICATED",
      httpStatus: 401,
      userMessage: "Please sign in again to continue.",
      devMessage: "Unauthorized: sign in to sync channels",
    });
    return {
      success: false,
      error: refusal.devMessage,
      refusal: refusal.toShape(),
    };
  }
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }
  if (session.user.id !== userId && !isPrivileged(session.user.role)) {
    throw new Error("Forbidden: cannot sync channels for another user");
  }

  if (force) {
    clearSyncCacheForUser(userId);
  }

  if (initialSyncCompletedUsers.has(userId)) {
    streamLogger.debug("Sync already completed for user this session", {
      userId,
    });
    return { success: true, skipped: true };
  }

  streamLogger.info("Starting channel sync for user", { userId, force });
  const startTime = Date.now();

  try {
    try {
      if (
        isUpsertRefusal(
          await upsertUserToStream(userId, {
            serverTrusted: STREAM_SERVER_TRUSTED,
          }),
        )
      ) {
        streamLogger.info(
          "Skipping channel sync — Stream refused the account",
          {
            userId,
          },
        );
        initialSyncCompletedUsers.add(userId);
        return { success: true, skipped: true };
      }
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        streamLogger.info(
          "Skipping channel sync — Stream consent not granted",
          {
            userId,
            purposeCode: err.purposeCode,
          },
        );
        initialSyncCompletedUsers.add(userId);
        return { success: true, skipped: true };
      }
      throw err;
    }

    const client = getStreamChatClient();

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        consultantProfileId: true,
        consulteeProfileId: true,
      },
    });

    if (!user) {
      streamLogger.warn("User not found for sync", { userId });
      return { success: false, error: "User not found" };
    }

    const eventIds: { type: EventType; id: string }[] = [];

    const [webinarData, classData, directDmPairs] = await Promise.all([
      getWebinarDataForUser(userId, user),
      getClassDataForUser(userId, user),
      getDmPairsForUser(userId, user),
    ]);

    webinarData.ids.forEach((id) => eventIds.push({ type: "webinar", id }));
    classData.ids.forEach((id) => eventIds.push({ type: "class", id }));

    const mergedDmPairMap = new Map<string, DmPair>();
    for (const pair of [
      ...directDmPairs,
      ...webinarData.dmPairs,
      ...classData.dmPairs,
    ]) {
      const chId = getDmChannelId(
        pair.consultantUserId,
        pair.consulteeUserId,
        pair.organizationId,
      );
      mergedDmPairMap.set(chId, pair);
    }
    const dmPairs = Array.from(mergedDmPairMap.values());

    streamLogger.debug("Events found for user", {
      userId,
      webinars: webinarData.ids.length,
      classes: classData.ids.length,
      dmPairs: dmPairs.length,
      total: eventIds.length,
    });

    const expectedChannelIds = new Set([
      ...eventIds.map(({ type, id }) => getChannelId(type, id)),
      ...Array.from(mergedDmPairMap.keys()),
    ]);

    const BATCH_SIZE = 5;
    let degraded = false;

    const { channels: streamChannels, truncated } = await queryChannelsPaged(
      (opts) =>
        withStreamCircuitBreaker(
          () =>
            client.queryChannels(
              { members: { $in: [userId] } },
              { created_at: 1 },
              opts,
            ),
          () => {
            degraded = true;
            return [];
          },
        ),
    );

    if (degraded) {
      streamLogger.warn(
        "Reconciliation degraded — Stream circuit open, no memberships examined",
        { userId, truncated },
      );
    }

    if (truncated) {
      streamLogger.warn(
        "Reconciliation truncated at Stream's offset cap; some memberships were not examined",
        { userId, examined: streamChannels.length },
      );
    }

    const staleChannels = streamChannels.filter(
      (ch) =>
        ch.id &&
        !expectedChannelIds.has(ch.id) &&
        MANAGED_CHANNEL_PREFIXES.some((prefix) => ch.id!.startsWith(prefix)),
    );

    let staleRemovedCount = 0;
    let staleFailCount = 0;

    if (staleChannels.length > 0) {
      streamLogger.info("Found stale channel memberships, cleaning up", {
        userId,
        staleCount: staleChannels.length,
        staleIds: staleChannels.map((ch) => ch.id),
      });

      for (let i = 0; i < staleChannels.length; i += BATCH_SIZE) {
        const batch = staleChannels.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map((ch) => ch.removeMembers([userId])),
        );

        results.forEach((result) => {
          if (result.status === "fulfilled") staleRemovedCount++;
          else staleFailCount++;
        });
      }

      streamLogger.info("Stale channel cleanup completed", {
        userId,
        staleChannelsRemoved: staleRemovedCount,
        staleFailed: staleFailCount,
      });
    }

    const duration = Date.now() - startTime;
    streamLogger.info("Channel sync completed", {
      userId,
      expectedChannels: expectedChannelIds.size,
      staleChannelsRemoved: staleRemovedCount,
      staleFailed: staleFailCount,
      degraded,
      durationMs: duration,
    });

    if (degraded) {
      streamLogger.warn(
        "Channel sync degraded — not marking the user synced, so the next load retries",
        { userId },
      );
    } else {
      initialSyncCompletedUsers.add(userId);
    }

    return {
      success: true,
      channelsSynced: expectedChannelIds.size,
      failed: staleFailCount,
      staleChannelsRemoved: staleRemovedCount,
      degraded,
      durationMs: duration,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Channel sync failed", error, { userId });
    throw error;
  }
}

async function getDmPairsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<DmPair[]> {
  const pairMap = new Map<string, DmPair>();

  if (user.consultantProfileId) {
    const [consultations, subscriptions] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          consultationPlan: { consultantProfileId: user.consultantProfileId },
          status: dmEligibleStatusFilter(),
        },
        include: {
          requestedBy: { include: { user: { select: { id: true } } } },
          consultationPlan: { select: { organizationId: true } },
          appointment: { select: { organizationId: true } },
        },
      }),
      prisma.subscription.findMany({
        where: {
          subscriptionPlan: { consultantProfileId: user.consultantProfileId },
          status: dmEligibleStatusFilter(),
        },
        include: {
          requestedBy: { include: { user: { select: { id: true } } } },
          subscriptionPlan: { select: { organizationId: true } },
          appointment: { select: { organizationId: true } },
        },
      }),
    ]);
    for (const c of [...consultations, ...subscriptions]) {
      const consulteeUserId = c.requestedBy?.user?.id;
      if (!consulteeUserId || consulteeUserId === userId) continue;
      const organizationId = bookingOrgId(c);
      const channelId = getDmChannelId(userId, consulteeUserId, organizationId);
      pairMap.set(channelId, {
        consultantUserId: userId,
        consulteeUserId,
        organizationId,
      });
    }
  }

  if (user.consulteeProfileId) {
    const [consultations, subscriptions] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          requestedById: user.consulteeProfileId,
          status: dmEligibleStatusFilter(),
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointment: { select: { organizationId: true } },
        },
      }),
      prisma.subscription.findMany({
        where: {
          requestedById: user.consulteeProfileId,
          status: dmEligibleStatusFilter(),
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointment: { select: { organizationId: true } },
        },
      }),
    ]);
    for (const c of consultations) {
      const consultantUserId = c.consultationPlan?.consultantProfile?.user?.id;
      if (!consultantUserId || consultantUserId === userId) continue;
      const organizationId = bookingOrgId(c);
      const channelId = getDmChannelId(
        consultantUserId,
        userId,
        organizationId,
      );
      pairMap.set(channelId, {
        consultantUserId,
        consulteeUserId: userId,
        organizationId,
      });
    }
    for (const s of subscriptions) {
      const consultantUserId = s.subscriptionPlan?.consultantProfile?.user?.id;
      if (!consultantUserId || consultantUserId === userId) continue;
      const organizationId = bookingOrgId(s);
      const channelId = getDmChannelId(
        consultantUserId,
        userId,
        organizationId,
      );
      pairMap.set(channelId, {
        consultantUserId,
        consulteeUserId: userId,
        organizationId,
      });
    }
  }

  return Array.from(pairMap.values());
}

function isWebinarOrClassPastRetention(
  endsAt: Date | null | undefined,
  retentionDays: number | null | undefined,
): boolean {
  if (!endsAt) return false;
  return isPastRetention(endsAt, retentionDays ?? DEFAULT_RETENTION_DAYS);
}

const openableStatusSet = new Set<string>(OPENABLE_EVENT_STATUSES);

const eventPlanRetentionSelect = {
  select: {
    organizationId: true,
    consultantProfile: { select: { user: { select: { id: true } } } },
    organization: {
      select: {
        chatRetentionDays: true,
        streamRecordingRetentionDays: true,
      },
    },
  },
};

const eventAppointmentRetentionSelect = {
  select: {
    organizationId: true,
    organization: {
      select: {
        chatRetentionDays: true,
        streamRecordingRetentionDays: true,
      },
    },
    participants: {
      where: liveParticipant(),
      select: { userId: true },
    },
    occurrences: {
      select: { endsAt: true },
      orderBy: { endsAt: "desc" as const },
      take: 1,
    },
  },
};

type EventOrgRetentionShape = {
  chatRetentionDays?: number | null;
  streamRecordingRetentionDays?: number | null;
} | null;

type EventPlanRetentionShape = {
  organizationId: string | null;
  consultantProfile?: { user?: { id?: string } | null } | null;
  organization?: EventOrgRetentionShape;
} | null;

type EventAppointmentRetentionShape = {
  organizationId: string | null;
  organization?: EventOrgRetentionShape;
  participants?: { userId: string }[];
  occurrences?: { endsAt: Date }[];
} | null;

type NormalizedEventRow = {
  id: string;
  status?: string;
  fallbackEndsAt?: Date | null;
  plan?: EventPlanRetentionShape;
  appointment?: EventAppointmentRetentionShape;
};

function isNormalizedEventActive(row: NormalizedEventRow): boolean {
  const endsAt =
    row.appointment?.occurrences?.[0]?.endsAt ?? row.fallbackEndsAt ?? null;
  const retention = resolveEventRetentionDays(
    row.plan?.organization,
    row.appointment?.organization,
  );
  return !isWebinarOrClassPastRetention(endsAt, retention);
}

function resolveNormalizedEventOrgId(row: NormalizedEventRow): string | null {
  return bookingOrgId({
    webinarPlan: row.plan,
    appointment: row.appointment,
  });
}

function isRowOpenableForDm(row: NormalizedEventRow): boolean {
  return !row.status || openableStatusSet.has(row.status);
}

function collectHostedRowDmPairs(
  userId: string,
  row: NormalizedEventRow,
): DmPair[] {
  if (!isRowOpenableForDm(row)) return [];
  const orgId = resolveNormalizedEventOrgId(row);
  const pairs: DmPair[] = [];
  for (const p of row.appointment?.participants ?? []) {
    if (p.userId && p.userId !== userId) {
      pairs.push({
        consultantUserId: userId,
        consulteeUserId: p.userId,
        organizationId: orgId,
      });
    }
  }
  return pairs;
}

function buildAttendedRowDmPair(
  userId: string,
  row: NormalizedEventRow,
  requireConsulteeSeatCheck: boolean,
): DmPair | null {
  if (!isRowOpenableForDm(row)) return null;
  const consultantUserId = row.plan?.consultantProfile?.user?.id;
  if (!consultantUserId || consultantUserId === userId) return null;
  const hasSeat = (row.appointment?.participants ?? []).some(
    (p) => p.userId === userId,
  );
  if (requireConsulteeSeatCheck && !hasSeat) return null;
  return {
    consultantUserId,
    consulteeUserId: userId,
    organizationId: resolveNormalizedEventOrgId(row),
  };
}

function collectNormalizedEventData(
  userId: string,
  hostedRows: NormalizedEventRow[],
  collaboratorRows: NormalizedEventRow[],
  attendedRows: NormalizedEventRow[],
  requireConsulteeSeatCheck: boolean,
): { ids: string[]; dmPairs: DmPair[] } {
  const ids = new Set<string>();
  const dmPairs: DmPair[] = [];

  for (const row of hostedRows.filter(isNormalizedEventActive)) {
    ids.add(row.id);
    dmPairs.push(...collectHostedRowDmPairs(userId, row));
  }

  for (const row of collaboratorRows.filter(isNormalizedEventActive)) {
    ids.add(row.id);
  }

  for (const row of attendedRows.filter(isNormalizedEventActive)) {
    ids.add(row.id);
    const pair = buildAttendedRowDmPair(userId, row, requireConsulteeSeatCheck);
    if (pair) dmPairs.push(pair);
  }

  return { ids: Array.from(ids), dmPairs };
}

async function getWebinarDataForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<{ ids: string[]; dmPairs: DmPair[] }> {
  const webinarRetentionSelect = {
    id: true,
    status: true,
    webinarPlan: eventPlanRetentionSelect,
    appointment: eventAppointmentRetentionSelect,
  };

  type RawWebinarRow = {
    id: string;
    status?: string;
    webinarPlan?: EventPlanRetentionShape;
    appointment?: EventAppointmentRetentionShape;
  };

  const toNormalized = (w: RawWebinarRow): NormalizedEventRow => ({
    id: w.id,
    status: w.status,
    plan: w.webinarPlan,
    appointment: w.appointment,
  });

  const [hostedWebinars, collaboratorWebinars] = user.consultantProfileId
    ? await Promise.all([
        prisma.webinar.findMany({
          where: {
            webinarPlan: { consultantProfileId: user.consultantProfileId },
          },
          select: webinarRetentionSelect,
        }),
        prisma.webinar.findMany({
          where: {
            webinarPlan: {
              collaborators: {
                some: {
                  consultantProfileId: user.consultantProfileId,
                  status: "ACCEPTED",
                  consultantProfile: { deletedAt: null },
                },
              },
            },
          },
          select: webinarRetentionSelect,
        }),
      ])
    : [[], []];

  const attendedWebinars = user.consulteeProfileId
    ? await prisma.webinar.findMany({
        where: {
          appointment: {
            participants: { some: liveParticipant(userId) },
          },
        },
        select: webinarRetentionSelect,
      })
    : [];

  return collectNormalizedEventData(
    userId,
    (hostedWebinars ?? []).map(toNormalized),
    (collaboratorWebinars ?? []).map(toNormalized),
    (attendedWebinars ?? []).map(toNormalized),
    false,
  );
}

async function getClassDataForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<{ ids: string[]; dmPairs: DmPair[] }> {
  const classRetentionSelect = {
    id: true,
    status: true,
    schedulingPeriodEndsAt: true,
    classPlan: eventPlanRetentionSelect,
    appointment: eventAppointmentRetentionSelect,
  };

  type RawClassRow = {
    id: string;
    status?: string;
    schedulingPeriodEndsAt?: Date | null;
    classPlan?: EventPlanRetentionShape;
    appointment?: EventAppointmentRetentionShape;
  };

  const toNormalized = (c: RawClassRow): NormalizedEventRow => ({
    id: c.id,
    status: c.status,
    fallbackEndsAt: c.schedulingPeriodEndsAt,
    plan: c.classPlan,
    appointment: c.appointment,
  });

  const [hostedClasses, collaboratorClasses] = user.consultantProfileId
    ? await Promise.all([
        prisma.class.findMany({
          where: {
            classPlan: { consultantProfileId: user.consultantProfileId },
          },
          select: classRetentionSelect,
        }),
        prisma.class.findMany({
          where: {
            classPlan: {
              collaborators: {
                some: {
                  consultantProfileId: user.consultantProfileId,
                  status: "ACCEPTED",
                  consultantProfile: { deletedAt: null },
                },
              },
            },
          },
          select: classRetentionSelect,
        }),
      ])
    : [[], []];

  const attendedClasses = user.consulteeProfileId
    ? await prisma.class.findMany({
        where: {
          appointment: {
            participants: { some: liveParticipant(userId) },
          },
        },
        select: classRetentionSelect,
      })
    : [];

  return collectNormalizedEventData(
    userId,
    (hostedClasses ?? []).map(toNormalized),
    (collaboratorClasses ?? []).map(toNormalized),
    (attendedClasses ?? []).map(toNormalized),
    true,
  );
}
