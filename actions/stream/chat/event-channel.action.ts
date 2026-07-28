"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
  StreamUnavailableError,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  isChannelCached,
  markChannelExists,
  getMembershipCached,
  markMembership,
  initialSyncCompletedUsers,
  clearSyncCacheForUser,
} from "@/lib/stream-cache";
import { upsertUserToStream, upsertUsersToStream } from "./user.action";
import { MANAGED_CHANNEL_PREFIXES } from "@/lib/stream-channel-ids";
import { getDmChannelId } from "@/lib/stream-utils";
import { ConsentRequiredError } from "@/lib/compliance/dpdp";

// Validation schemas
const eventTypeSchema = z.enum([
  "webinar",
  "class",
  "consultation",
  "subscription",
]);
const eventIdSchema = z.string().min(1, "Event ID is required");
const userIdSchema = z.string().min(1, "User ID is required");

type EventType = z.infer<typeof eventTypeSchema>;

/**
 * Get the channel ID for an event
 */
function getChannelId(eventType: EventType, eventId: string): string {
  return `${eventType}-${eventId}`;
}

/**
 * Get the channel type for an event type
 */
function getChannelType(eventType: EventType): "messaging" | "team" {
  return eventType === "consultation" || eventType === "subscription"
    ? "messaging"
    : "team";
}

/**
 * Check if an event channel exists (with caching)
 */
export async function checkEventChannelExists(
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  // Check cache first
  const cached = isChannelCached(channelType, channelId);
  if (cached !== undefined) {
    streamLogger.debug("Channel existence from cache", {
      channelId,
      exists: cached,
    });
    return cached;
  }

  const client = getStreamChatClient();

  try {
    const channel = client.channel(channelType, channelId);
    // #473 — fast-fail under a Stream outage instead of blocking the dashboard
    // for the full 30s timeout. Breaker-open degrades to "false" (same as a
    // query failure), so the caller treats the channel as not-yet-existing.
    await withStreamCircuitBreaker(
      () => channel.query({ state: false, messages: { limit: 0 } }),
      () => {
        throw new StreamUnavailableError();
      },
    );

    // Cache the result
    markChannelExists(channelType, channelId);
    streamLogger.debug("Channel exists", { channelId });
    return true;
  } catch (error) {
    // Channel doesn't exist if query fails (or Stream is unavailable)
    streamLogger.debug("Channel does not exist", { channelId });
    return false;
  }
}

/**
 * Add a user to an event channel, creating the channel if it doesn't exist
 * Uses caching to avoid redundant operations
 */
export async function addUserToEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean; channelId: string; created?: boolean }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  // Check membership cache first
  const membershipCached = getMembershipCached(channelId, userId);
  if (membershipCached === true) {
    streamLogger.debug("User already member (cached)", { channelId, userId });
    return { success: true, channelId };
  }

  const client = getStreamChatClient();

  try {
    // Ensure user is upserted to Stream first
    await upsertUserToStream(userId);

    const channel = client.channel(channelType, channelId);

    // Try to add member directly (works for existing channels)
    try {
      // #473 — breaker-open rethrows StreamUnavailableError, which propagates
      // out of the outer try (so we don't masquerade an outage as "channel
      // missing" and attempt a pointless create that also fast-fails).
      await withStreamCircuitBreaker(
        () => channel.addMembers([userId]),
        () => {
          throw new StreamUnavailableError();
        },
      );
      markMembership(channelId, userId, true);
      streamLogger.debug("Added user to existing channel", {
        channelId,
        userId,
      });
      return { success: true, channelId };
    } catch (addError) {
      if (addError instanceof StreamUnavailableError) throw addError;
      // Channel might not exist, try to create it
      streamLogger.debug("Channel may not exist, attempting creation", {
        channelId,
      });
    }

    // Channel doesn't exist, create it based on event type
    let created = false;
    const eventData = await getEventData(eventType, eventId);

    if (!eventData) {
      throw new Error(`${eventType} not found: ${eventId}`);
    }

    // Create channel with all data and members in a single atomic call
    // This fixes the "created_by_id must be provided" error and reduces 3 API calls to 1
    const { consultantId, members, name } = eventData;
    const allMembers = Array.from(new Set([consultantId, ...members, userId]));

    // Ensure all members exist in Stream Chat before creating the channel
    // Without this, channel creation fails with "users don't exist" error
    await upsertUsersToStream(allMembers);

    // Re-initialize channel with all required data for atomic creation
    // Note: Explicitly typing channel data for stream-chat v9
    const eventChannelData = {
      name,
      created_by_id: consultantId,
      [`${eventType}_id`]: eventId,
      members: allMembers,
    };
    const channelWithData = client.channel(
      channelType,
      channelId,
      eventChannelData as Record<string, unknown>,
    );

    // #473 — fast-fail channel creation under a Stream outage.
    await withStreamCircuitBreaker(
      () => channelWithData.create(),
      () => {
        throw new StreamUnavailableError();
      },
    );

    // Lazy-create bypasses createChannel, so the #899 channel-scoped host
    // grant is repeated here. Non-fatal: chat still works without it.
    try {
      await channelWithData.assignRoles([
        { user_id: consultantId, channel_role: "channel_moderator" },
      ]);
    } catch (grantError) {
      streamLogger.warn("Failed to grant channel_moderator to event host", {
        channelId,
        consultantId,
        error: grantError,
      });
    }

    markChannelExists(channelType, channelId);
    markMembership(channelId, userId, true);
    created = true;

    streamLogger.info("Created channel and added user", {
      channelId,
      userId,
      memberCount: allMembers.length,
    });

    return { success: true, channelId, created };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to add user to event channel", error, {
      eventType,
      eventId,
      userId,
    });
    throw error;
  }
}

/**
 * Remove a user from an event channel.
 * Used when a collaborator is removed from a webinar/class plan.
 */
export async function removeUserFromEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  const client = getStreamChatClient();

  try {
    const channel = client.channel(channelType, channelId);
    await channel.removeMembers([userId]);
    markMembership(channelId, userId, false);
    streamLogger.info("Removed user from event channel", {
      channelId,
      userId,
    });
    return { success: true };
  } catch (error) {
    // Clear membership cache regardless — if removal failed, we don't want
    // stale "is member" cache entries preventing future add/remove operations.
    markMembership(channelId, userId, false);
    // Channel may not exist — that's fine, user has no access anyway
    streamLogger.warn("Failed to remove user from event channel", {
      eventType,
      eventId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false };
  }
}

/**
 * Get event data for channel creation
 */
async function getEventData(eventType: EventType, eventId: string) {
  switch (eventType) {
    case "webinar": {
      const webinar = await prisma.webinar.findUnique({
        where: { id: eventId },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: { user: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!webinar) return null;

      const consultantId = webinar.webinarPlan.consultantProfile?.user?.id;
      if (!consultantId) return null;

      const members =
        webinar.appointment?.slotsOfAppointment?.flatMap((s) =>
          s.user.map((u) => u.id),
        ) || [];

      return { consultantId, members, name: webinar.webinarPlan.title };
    }

    case "class": {
      const classData = await prisma.class.findUnique({
        where: { id: eventId },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: { user: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!classData) return null;

      const consultantId = classData.classPlan.consultantProfile?.user?.id;
      if (!consultantId) return null;

      const members =
        classData.appointments?.flatMap(
          (a) =>
            a.slotsOfAppointment?.flatMap((s) => s.user.map((u) => u.id)) || [],
        ) || [];

      return { consultantId, members, name: classData.classPlan.title };
    }

    case "consultation": {
      const consultation = await prisma.consultation.findUnique({
        where: { id: eventId },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          requestedBy: { include: { user: { select: { id: true } } } },
        },
      });
      if (!consultation) return null;

      const consultantId =
        consultation.consultationPlan.consultantProfile?.user?.id;
      const consulteeId = consultation.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      return {
        consultantId,
        members: [consulteeId],
        name: consultation.consultationPlan.title,
      };
    }

    case "subscription": {
      const subscription = await prisma.subscription.findUnique({
        where: { id: eventId },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          requestedBy: { include: { user: { select: { id: true } } } },
        },
      });
      if (!subscription) return null;

      const consultantId =
        subscription.subscriptionPlan.consultantProfile?.user?.id;
      const consulteeId = subscription.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      return {
        consultantId,
        members: [consulteeId],
        name: subscription.subscriptionPlan.title,
      };
    }

    default:
      return null;
  }
}

/**
 * Get all event channels for a user
 */
export async function getUserEventChannels(userId: string) {
  userIdSchema.parse(userId);

  const client = getStreamChatClient();

  try {
    // #473 — dashboard hot path. Breaker-open returns an empty channel list so
    // the page renders (degraded) rather than hanging on the 30s Stream timeout.
    const channels = await withStreamCircuitBreaker(
      () =>
        client.queryChannels(
          { members: { $in: [userId] } },
          { last_message_at: -1 },
          { limit: 100 },
        ),
      // #473 — degrade to an empty list when the breaker is open (T is inferred
      // from the operation, so the empty array needs no cast).
      () => [],
    );

    return channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      // Access custom channel data with type assertion (stream-chat v9)
      name: (channel.data as { name?: string } | undefined)?.name,
      memberCount: Object.keys(channel.state.members || {}).length,
    }));
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to get user event channels", error, { userId });
    throw error;
  }
}

/**
 * Sync user to all their event channels.
 * OPTIMIZED: Uses batch queries and parallel processing.
 * Runs once per user per server session, unless force=true.
 *
 * @param force - When true, bypass the session-level dedup guard and also
 *                remove the user from any Stream channels that are no longer
 *                backed by an active DB record (reconciliation cleanup).
 */
export async function syncUserEventChannels(
  userId: string,
  force = false,
): Promise<{
  success: boolean;
  skipped?: boolean;
  error?: string;
  channelsSynced?: number;
  failed?: number;
  staleChannelsRemoved?: number;
  durationMs?: number;
}> {
  userIdSchema.parse(userId);

  // Allow forced re-sync by clearing the session guard first
  if (force) {
    clearSyncCacheForUser(userId);
  }

  // Check if sync already completed for this user in this session
  if (initialSyncCompletedUsers.has(userId)) {
    streamLogger.debug("Sync already completed for user this session", {
      userId,
    });
    return { success: true, skipped: true };
  }

  streamLogger.info("Starting channel sync for user", { userId, force });
  const startTime = Date.now();

  try {
    // Upsert the user to Stream first. A DPDP consent gate (no/withdrawn
    // STREAM_DATA_PROCESSING consent) is a deliberate refusal, NOT a failure:
    // degrade gracefully by skipping the whole Stream sync rather than letting
    // it bubble as an unhandled error through the dashboard-load path. The gate
    // is unchanged — we simply don't crash the page for a non-consenting user.
    try {
      await upsertUserToStream(userId);
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        streamLogger.info(
          "Skipping channel sync — Stream consent not granted",
          {
            userId,
            purposeCode: err.purposeCode,
          },
        );
        // Mark sync "completed" for this session so we don't retry the gated
        // upsert on every navigation; a re-grant clears caches via the consent
        // flow and a forced re-sync re-attempts it.
        initialSyncCompletedUsers.add(userId);
        return { success: true, skipped: true };
      }
      throw err;
    }

    // Grab the Stream server client (needed for reconciliation query)
    const client = getStreamChatClient();

    // Get user's profile IDs
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

    // Collect all event IDs the user should have access to (webinars + classes only)
    const eventIds: { type: EventType; id: string }[] = [];

    // Batch query all events in parallel
    const [webinars, classes, dmPairs] = await Promise.all([
      getWebinarIdsForUser(userId, user),
      getClassIdsForUser(userId, user),
      getDmPairsForUser(userId, user),
    ]);

    webinars.forEach((id) => eventIds.push({ type: "webinar", id }));
    classes.forEach((id) => eventIds.push({ type: "class", id }));

    streamLogger.debug("Events found for user", {
      userId,
      webinars: webinars.length,
      classes: classes.length,
      dmPairs: dmPairs.length,
      total: eventIds.length,
    });

    // Build the set of channel IDs this user is expected to be in
    const expectedChannelIds = new Set([
      ...eventIds.map(({ type, id }) => getChannelId(type, id)),
      ...dmPairs.map(({ consultantUserId, consulteeUserId, organizationId }) =>
        getDmChannelId(consultantUserId, consulteeUserId, organizationId),
      ),
    ]);

    // --- Add pass: join any channels the user is missing ---
    const BATCH_SIZE = 5;
    let successCount = 0;
    let failCount = 0;

    if (eventIds.length > 0) {
      for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
        const batch = eventIds.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map((event) =>
            addUserToEventChannel(event.type, event.id, userId),
          ),
        );

        results.forEach((result) => {
          if (result.status === "fulfilled") successCount++;
          else failCount++;
        });
      }
    }

    // --- DM add-pass: one channel per pair PER FUNDING CONTEXT ---
    // A pair working both B2C and through an org now has two threads, and this
    // pass joins the user to each. `dmPairs` is already keyed that way.
    for (let i = 0; i < dmPairs.length; i += BATCH_SIZE) {
      const batch = dmPairs.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((pair) =>
          addUserToDmChannel(
            pair.consultantUserId,
            pair.consulteeUserId,
            userId,
            pair.organizationId,
          ),
        ),
      );
      results.forEach((r) => {
        if (r.status === "fulfilled") successCount++;
        else failCount++;
      });
    }

    // --- Reconciliation pass: remove user from stale channels ---
    // Query Stream for every channel this user currently belongs to.
    // Paginate to handle users with 100+ channel memberships.
    const PAGE_SIZE = 100;
    let allStreamChannels: Awaited<ReturnType<typeof client.queryChannels>> =
      [];
    let offset = 0;
    let page;
    do {
      // #473 — breaker-open returns [] so reconciliation simply skips the
      // stale-cleanup pass this run rather than blocking the sync on a dead
      // Stream backend; the add-pass above already short-circuits too.
      page = await withStreamCircuitBreaker(
        () =>
          client.queryChannels(
            { members: { $in: [userId] } },
            {},
            { limit: PAGE_SIZE, offset },
          ),
        () => [], // #473 — degrade to empty page when the breaker is open.
      );
      allStreamChannels = allStreamChannels.concat(page);
      offset += PAGE_SIZE;
    } while (page.length === PAGE_SIZE);
    const streamChannels = allStreamChannels;

    // Only clean up channels with managed prefixes — preserve collab, support,
    // and manually-created channels that aren't part of the event/dm lifecycle.
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
          // Only remove this user's own membership — the channel is preserved for others
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
      successCount,
      failCount,
      staleChannelsRemoved: staleRemovedCount,
      durationMs: duration,
    });

    // Mark sync as completed for this user (suppress future automatic re-runs)
    initialSyncCompletedUsers.add(userId);

    return {
      success: true,
      channelsSynced: successCount,
      failed: failCount,
      staleChannelsRemoved: staleRemovedCount,
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

/**
 * Get unique consultant-consultee DM pairs for a user, across consultations and subscriptions.
 */
/** A DM the user should be a member of, in one specific funding context. */
interface DmPair {
  consultantUserId: string;
  consulteeUserId: string;
  /** null = personal (B2C). Part of the channel key — see getDmChannelId. */
  organizationId: string | null;
}

/**
 * The org context a DM channel was created under.
 *
 * Precedence MUST match `createConsultationChannel` / `createSubscriptionChannel`
 * exactly — `plan.organizationId ?? appointment.organizationId ?? null` — because
 * this function recomputes the channel id those creators already used. They are
 * two distinct cases: a plan can be org-HOSTED while the booking is self-funded,
 * and a personal plan can be booked through an org-funded membership.
 *
 * Reading only the appointment treated every org-hosted-plan booking as
 * personal, so the reconcile set looked for `dm-<a>-<b>` while the real channel
 * was `dmo-…`. At best it was never re-joined; at worst the real one was treated
 * as stale and the user removed from it.
 *
 * Subscriptions carry many appointments but are funded once, so the first is
 * representative.
 */
function bookingOrgId(booking: {
  consultationPlan?: { organizationId: string | null } | null;
  subscriptionPlan?: { organizationId: string | null } | null;
  appointment?: { organizationId: string | null } | null;
  appointments?: { organizationId: string | null }[];
}): string | null {
  return (
    booking.consultationPlan?.organizationId ??
    booking.subscriptionPlan?.organizationId ??
    booking.appointment?.organizationId ??
    booking.appointments?.[0]?.organizationId ??
    null
  );
}

async function getDmPairsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<DmPair[]> {
  // Keyed by channel id, so a pair working in two contexts yields two entries
  // rather than one overwriting the other.
  const pairMap = new Map<string, DmPair>();

  if (user.consultantProfileId) {
    const [consultations, subscriptions] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          consultationPlan: { consultantProfileId: user.consultantProfileId },
          status: { in: ["APPROVED", "SCHEDULED"] },
        },
        include: {
          requestedBy: { include: { user: { select: { id: true } } } },
          // The DM channel key includes the funding context, so the reconcile
          // set has to know it too — otherwise it looks for a personal channel
          // that an org booking never created. Plan org FIRST, matching
          // createConsultationChannel's precedence exactly.
          consultationPlan: { select: { organizationId: true } },
          appointment: { select: { organizationId: true } },
        },
      }),
      prisma.subscription.findMany({
        where: {
          subscriptionPlan: { consultantProfileId: user.consultantProfileId },
          status: { in: ["APPROVED", "SCHEDULED"] },
        },
        include: {
          requestedBy: { include: { user: { select: { id: true } } } },
          subscriptionPlan: { select: { organizationId: true } },
          appointments: { select: { organizationId: true }, take: 1 },
        },
      }),
    ]);
    for (const c of [...consultations, ...subscriptions]) {
      const consulteeUserId = c.requestedBy?.user?.id;
      if (!consulteeUserId) continue;
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
          status: { in: ["APPROVED", "SCHEDULED"] },
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
          status: { in: ["APPROVED", "SCHEDULED"] },
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointments: { select: { organizationId: true }, take: 1 },
        },
      }),
    ]);
    for (const c of consultations) {
      const consultantUserId = c.consultationPlan?.consultantProfile?.user?.id;
      if (!consultantUserId) continue;
      const organizationId = bookingOrgId(c);
      const channelId = getDmChannelId(consultantUserId, userId, organizationId);
      pairMap.set(channelId, {
        consultantUserId,
        consulteeUserId: userId,
        organizationId,
      });
    }
    for (const sub of subscriptions) {
      const consultantUserId =
        sub.subscriptionPlan?.consultantProfile?.user?.id;
      if (!consultantUserId) continue;
      const organizationId = bookingOrgId(sub);
      const channelId = getDmChannelId(consultantUserId, userId, organizationId);
      pairMap.set(channelId, {
        consultantUserId,
        consulteeUserId: userId,
        organizationId,
      });
    }
  }

  return Array.from(pairMap.values());
}

/**
 * Create or join a DM channel for a consultant-consultee pair.
 */
async function addUserToDmChannel(
  consultantUserId: string,
  consulteeUserId: string,
  currentUserId: string,
  /** Funding context — the channel key differs per org (see getDmChannelId). */
  organizationId: string | null,
): Promise<{ success: boolean; channelId: string; created?: boolean }> {
  const channelId = getDmChannelId(
    consultantUserId,
    consulteeUserId,
    organizationId,
  );
  const channelType = "messaging";

  if (getMembershipCached(channelId, currentUserId) === true) {
    return { success: true, channelId };
  }

  const client = getStreamChatClient();
  const channel = client.channel(channelType, channelId);

  // Try adding to existing channel first
  try {
    // #473 — surface breaker-open as StreamUnavailableError so an outage
    // doesn't get mistaken for "channel missing" and trigger a doomed create.
    await withStreamCircuitBreaker(
      () => channel.addMembers([currentUserId]),
      () => {
        throw new StreamUnavailableError();
      },
    );
    markMembership(channelId, currentUserId, true);
    return { success: true, channelId };
  } catch (addError) {
    if (addError instanceof StreamUnavailableError) throw addError;
    // Channel may not exist — fall through to creation
  }

  // Create the DM channel
  await upsertUsersToStream([consultantUserId, consulteeUserId]);
  const channelWithData = client.channel(channelType, channelId, {
    members: [consultantUserId, consulteeUserId],
    created_by_id: consultantUserId,
    dm_consultant_user_id: consultantUserId,
    dm_consultee_user_id: consulteeUserId,
  } as Record<string, unknown>);
  await withStreamCircuitBreaker(
    () => channelWithData.create(),
    () => {
      throw new StreamUnavailableError();
    },
  );

  // Lazy-create bypasses createChannel, so the #899 channel-scoped host
  // grant is repeated here. Non-fatal: chat still works without it.
  try {
    await channelWithData.assignRoles([
      { user_id: consultantUserId, channel_role: "channel_moderator" },
    ]);
  } catch (grantError) {
    streamLogger.warn("Failed to grant channel_moderator to DM consultant", {
      channelId,
      consultantUserId,
      error: grantError,
    });
  }

  markChannelExists(channelType, channelId);
  markMembership(channelId, currentUserId, true);
  streamLogger.info("Created DM channel", {
    channelId,
    consultantUserId,
    consulteeUserId,
  });
  return { success: true, channelId, created: true };
}

/**
 * Get webinar IDs for a user (both hosted and enrolled).
 * Handles dual-role users who are both consultant and consultee.
 */
async function getWebinarIdsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<string[]> {
  const queries: Promise<{ id: string }[]>[] = [];

  // Consultant: get webinars they host
  if (user.consultantProfileId) {
    queries.push(
      prisma.webinar.findMany({
        where: {
          webinarPlan: { consultantProfileId: user.consultantProfileId },
        },
        select: { id: true },
      }),
    );
  }

  // Consultee: get webinars they registered for
  queries.push(
    prisma.webinar.findMany({
      where: {
        appointment: {
          slotsOfAppointment: { some: { user: { some: { id: userId } } } },
        },
      },
      select: { id: true },
    }),
  );

  const results = await Promise.all(queries);
  return Array.from(new Set(results.flatMap((r) => r.map((w) => w.id))));
}

/**
 * Get class IDs for a user (both hosted and enrolled).
 * Handles dual-role users who are both consultant and consultee.
 */
async function getClassIdsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<string[]> {
  const queries: Promise<{ id: string }[]>[] = [];

  // Consultant: get classes they host
  if (user.consultantProfileId) {
    queries.push(
      prisma.class.findMany({
        where: {
          classPlan: { consultantProfileId: user.consultantProfileId },
        },
        select: { id: true },
      }),
    );
  }

  // Consultee: get classes they enrolled in
  queries.push(
    prisma.class.findMany({
      where: {
        appointments: {
          some: {
            slotsOfAppointment: { some: { user: { some: { id: userId } } } },
          },
        },
      },
      select: { id: true },
    }),
  );

  const results = await Promise.all(queries);
  return Array.from(new Set(results.flatMap((r) => r.map((c) => c.id))));
}
