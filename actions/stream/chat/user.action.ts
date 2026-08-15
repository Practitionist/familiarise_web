"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { mapRoleToStream } from "@/lib/user";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
  StreamUnavailableError,
} from "@/lib/stream-client";
import { forEachChunk } from "@/lib/stream/batch";
import { streamLogger } from "@/lib/stream-logger";
import { markUserSynced, isUserSynced } from "@/lib/stream-cache";
import { canDirectMessage } from "@/lib/stream/dm-eligibility";
import { dmEligibleStatusFilter } from "@/lib/stream/dm-eligibility-statuses";
import { checkConsent, ConsentRequiredError } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import * as Sentry from "@sentry/nextjs";

// Input validation schemas
const userIdSchema = z.string().min(1, "User ID is required");
const userIdsSchema = z
  .array(userIdSchema)
  .min(1, "At least one user ID required");
const searchTermSchema = z.string().min(1, "Search term is required").max(100);

/**
 * Upserts a user to Stream Chat
 * Uses caching to avoid redundant upserts
 * @param userId The ID of the user to upsert
 * @returns The upserted user or null if already synced
 */
export const upsertUserToStream = async (userId: string) => {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);

  // Check cache first - skip if recently synced
  if (isUserSynced(validatedUserId)) {
    streamLogger.debug("User already synced recently, skipping", {
      userId: validatedUserId,
    });
    return null;
  }

  try {
    // Get user details from the database
    const user = await prisma.user.findUnique({
      where: { id: validatedUserId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (!user) {
      throw new Error(`User not found: ${validatedUserId}`);
    }

    // DPDP Act 2023: refuse to hand user PII over to Stream.io when the
    // user has withdrawn (or never granted) consent for STREAM_DATA_PROCESSING.
    // The signup hook auto-stamps this; a full opt-out via the org consent
    // flow (DELETE /api/organizations/[orgId]/consent with no purposeCode)
    // revokes it and `checkConsent` returns false, killing future video/chat
    // sessions. There is no personal self-service re-grant page today; consent
    // is re-established by an org admin via that consent route (#701).
    const hasStreamConsent = await checkConsent({
      userId: user.id,
      purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
    });
    if (!hasStreamConsent) {
      streamLogger.warn("Refusing Stream upsert — STREAM_DATA_PROCESSING consent absent", {
        userId: user.id,
      });
      throw new ConsentRequiredError(
        PURPOSE_CODES.STREAM_DATA_PROCESSING,
        "Video and chat are unavailable because data-processing consent for messaging has not been granted (or was withdrawn). Consent is established at signup and managed by your organization administrator.",
      );
    }

    const client = getStreamChatClient();
    const streamRole = mapRoleToStream(user.role);

    streamLogger.debug("Upserting user to Stream", {
      userId: user.id,
      role: streamRole,
    });

    // Upsert the user to Stream Chat
    // #473 — fast-fail under a Stream outage instead of blocking the dashboard
    // on the 30s timeout. Breaker-open rethrows StreamUnavailableError, which
    // the caller's existing catch logs and surfaces gracefully.
    const streamUser = await withStreamCircuitBreaker(
      () =>
        client.upsertUser({
          id: user.id,
          name: user.name ?? user.id,
          email: user.email,
          image: user.image ?? undefined,
          role: streamRole,
        }),
      () => {
        throw new StreamUnavailableError();
      },
    );

    // Mark as synced in cache
    markUserSynced(user.id);

    return streamUser;
  } catch (error) {
    // A consent gate is a deliberate refusal (already warn-logged above), not
    // an infra failure — rethrow without an error-level log so it doesn't
    // pollute error-monitoring dashboards with false positives.
    if (error instanceof ConsentRequiredError) {
      throw error;
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Failed to upsert user to Stream", error, {
      userId: validatedUserId,
    });
    throw error;
  }
};

/**
 * Upserts multiple users to Stream Chat in a single batch call
 * Much more efficient than individual upserts
 * @param userIds The IDs of the users to upsert
 * @returns The upserted users
 */
export const upsertUsersToStream = async (userIds: string[]) => {
  // Validate input
  const validatedIds = userIdsSchema.parse(userIds);

  // Filter out already synced users
  const unsyncedIds = validatedIds.filter((id) => !isUserSynced(id));

  if (unsyncedIds.length === 0) {
    streamLogger.debug("All users already synced, skipping batch upsert", {
      totalRequested: validatedIds.length,
    });
    return { users: {} };
  }

  try {
    // Get user details from the database
    const users = await prisma.user.findMany({
      where: { id: { in: unsyncedIds } },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (users.length === 0) {
      streamLogger.warn("No users found for batch upsert", {
        requestedIds: unsyncedIds,
      });
      return { users: {} };
    }

    // DPDP gate (batch). Filter out users who have withdrawn — or never
    // granted — STREAM_DATA_PROCESSING consent. The non-consenters are
    // logged for ops visibility; the channel proceeds with the
    // consenters only. The signup auth hook stamps consent at account
    // creation so this should only filter when a user explicitly
    // withdraws via the in-app /consent route.
    const consentResults = await Promise.all(
      users.map(async (u) => ({
        user: u,
        hasConsent: await checkConsent({
          userId: u.id,
          purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
        }),
      })),
    );
    const consenters = consentResults
      .filter((r) => r.hasConsent)
      .map((r) => r.user);
    const droppedIds = consentResults
      .filter((r) => !r.hasConsent)
      .map((r) => r.user.id);
    if (droppedIds.length > 0) {
      streamLogger.warn(
        "Batch upsert dropping users missing STREAM_DATA_PROCESSING consent",
        { droppedIds, droppedCount: droppedIds.length },
      );
    }
    if (consenters.length === 0) {
      return { users: {} };
    }

    const client = getStreamChatClient();

    // Prepare users for batch upsert
    // Note: Using type assertion for custom user data (stream-chat v9)
    const streamUsers = consenters.map((user) => {
      const streamRole = mapRoleToStream(user.role);
      return {
        id: user.id,
        name: user.name ?? user.id,
        email: user.email,
        image: user.image ?? undefined,
        role: streamRole,
      };
    });

    streamLogger.debug("Batch upserting users to Stream", {
      count: streamUsers.length,
      skipped: validatedIds.length - unsyncedIds.length,
      droppedNoConsent: droppedIds.length,
    });

    // #1134 P1-20 — chunked at Stream's documented 100-users-per-request
    // ceiling. This used to hand the whole array to one call, so a webinar
    // roster above 100 (the plan default, and Webinar.maxParticipants is
    // unbounded) produced an oversized request that threw — and the attendee
    // silently got no chat.
    // #473 — fast-fail each batch under a Stream outage.
    let result: Awaited<ReturnType<typeof client.upsertUsers>> | undefined;
    await forEachChunk(streamUsers, async (batch) => {
      result = await withStreamCircuitBreaker(
        () =>
          client.upsertUsers(
            batch as Parameters<typeof client.upsertUsers>[0],
          ),
        () => {
          throw new StreamUnavailableError();
        },
      );
    });

    // Mark all as synced
    consenters.forEach((user) => markUserSynced(user.id));

    return result;
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Failed to batch upsert users to Stream", error, {
      userCount: unsyncedIds.length,
    });
    throw error;
  }
};

/**
 * Enhanced user search with relationship status for Direct Message dialog.
 * Uses batched queries instead of per-user relationship checks to minimize DB round-trips.
 * @param searchTerm The term to search for (name or email)
 * @param currentUserId The current user's ID to exclude from results
 * @returns Users with relationship status information
 */
export const searchUsersWithRelationships = async (
  searchTerm: string,
  currentUserId: string,
) => {
  // Validate inputs
  const validatedTerm = searchTermSchema.parse(searchTerm.trim());
  const validatedUserId = userIdSchema.parse(currentUserId);

  try {
    // Fetch current user's profile IDs once
    const [currentUser, users] = await Promise.all([
      prisma.user.findUnique({
        where: { id: validatedUserId },
        select: { consultantProfileId: true, consulteeProfileId: true },
      }),
      prisma.user.findMany({
        where: {
          AND: [
            { id: { not: validatedUserId } },
            {
              NOT: [
                { id: { startsWith: "recording-egress-" } },
                { id: { startsWith: "system-" } },
              ],
            },
            {
              OR: [
                { name: { contains: validatedTerm, mode: "insensitive" } },
                { email: { contains: validatedTerm, mode: "insensitive" } },
              ],
            },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          consultantProfileId: true,
          consulteeProfileId: true,
        },
        take: 20,
        orderBy: [{ name: "asc" }],
      }),
    ]);

    // No caller profile means no relationship is derivable, so nothing is
    // returnable. This branch used to `return users.map(… hasRelationship:
    // false)` — handing back the full unfiltered match set precisely when the
    // relationship check could not run, which is the one case where it mattered
    // most. Fail closed.
    if (!currentUser || users.length === 0) {
      return [];
    }

    // Batch: find all related user IDs in a few queries instead of N+1
    const resultUserIds = users.map((u) => u.id);
    const resultConsultantProfileIds = users
      .map((u) => u.consultantProfileId)
      .filter((id): id is string => !!id);
    const resultConsulteeProfileIds = users
      .map((u) => u.consulteeProfileId)
      .filter((id): id is string => !!id);

    const relatedUserIds = new Set<string>();

    // Build parallel batched relationship queries
    const relationshipQueries: Promise<void>[] = [];

    // Current user is consultant → find consultees among results
    if (currentUser.consultantProfileId && resultConsulteeProfileIds.length > 0) {
      relationshipQueries.push(
        prisma.consultation
          .findMany({
            where: {
              consultationPlan: { consultantProfileId: currentUser.consultantProfileId },
              requestedById: { in: resultConsulteeProfileIds },
              status: dmEligibleStatusFilter(),
            },
            select: { requestedBy: { select: { user: { select: { id: true } } } } },
          })
          .then((rows) => rows.forEach((r) => {
            if (r.requestedBy?.user?.id) relatedUserIds.add(r.requestedBy.user.id);
          })),
        // No `schedulingPeriodEndsAt` bound: under the ever-transacted rule a
        // lapsed subscription is still a relationship that happened, and the
        // window used to make this disagree with the search routes about who
        // counts as connected. Same set everywhere now — see
        // lib/stream/dm-eligibility.ts.
        prisma.subscription
          .findMany({
            where: {
              subscriptionPlan: { consultantProfileId: currentUser.consultantProfileId },
              requestedById: { in: resultConsulteeProfileIds },
              status: dmEligibleStatusFilter(),
            },
            select: { requestedBy: { select: { user: { select: { id: true } } } } },
          })
          .then((rows) => rows.forEach((r) => {
            if (r.requestedBy?.user?.id) relatedUserIds.add(r.requestedBy.user.id);
          })),
      );
    }

    // Current user is consultee → find consultants among results
    if (currentUser.consulteeProfileId && resultConsultantProfileIds.length > 0) {
      relationshipQueries.push(
        prisma.consultation
          .findMany({
            where: {
              consultationPlan: { consultantProfileId: { in: resultConsultantProfileIds } },
              requestedById: currentUser.consulteeProfileId,
              status: dmEligibleStatusFilter(),
            },
            select: {
              consultationPlan: {
                select: { consultantProfile: { select: { user: { select: { id: true } } } } },
              },
            },
          })
          .then((rows) => rows.forEach((r) => {
            if (r.consultationPlan?.consultantProfile?.user?.id)
              relatedUserIds.add(r.consultationPlan.consultantProfile.user.id);
          })),
        prisma.subscription
          .findMany({
            where: {
              subscriptionPlan: { consultantProfileId: { in: resultConsultantProfileIds } },
              requestedById: currentUser.consulteeProfileId,
              status: dmEligibleStatusFilter(),
            },
            select: {
              subscriptionPlan: {
                select: { consultantProfile: { select: { user: { select: { id: true } } } } },
              },
            },
          })
          .then((rows) => rows.forEach((r) => {
            if (r.subscriptionPlan?.consultantProfile?.user?.id)
              relatedUserIds.add(r.subscriptionPlan.consultantProfile.user.id);
          })),
      );
    }

    // Shared appointments (webinars, classes) - single batched query
    if (resultUserIds.length > 0) {
      relationshipQueries.push(
        prisma.slotOfAppointment
          .findMany({
            where: {
              deletedAt: null,
              appointment: { deletedAt: null },
              user: { some: { id: validatedUserId } },
              AND: { user: { some: { id: { in: resultUserIds } } } },
            },
            select: { user: { where: { id: { in: resultUserIds } }, select: { id: true } } },
          })
          .then((slots) => slots.forEach((s) => s.user.forEach((u) => relatedUserIds.add(u.id)))),
      );
    }

    await Promise.all(relationshipQueries);

    // Drop unrelated users rather than ranking them below related ones.
    //
    // `hasRelationship` was a SORT KEY, not a filter: a search for "char"
    // returned every Charlotte on the platform — name, email, avatar and role —
    // with the connected ones merely listed first. That is a directory of the
    // entire user base behind a two-character query, and the field name made it
    // read like a gate. Unrelated users are now not returned at all.
    //
    // `hasRelationship` stays on the payload, and is now always `true`. It is
    // kept so existing consumers do not break on a missing key; new code should
    // treat presence in this list as the answer.
    const usersWithRelationships = users
      .filter((user) => relatedUserIds.has(user.id))
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: user.role,
        hasRelationship: true as const,
      }));

    // Code-unit ordering, not localeCompare — same rule as the channel ids
    // (#1134 P0-3). Nothing keys off this ordering, but the codebase has been
    // bitten once by ICU-dependent sorts and a consistent habit is cheaper than
    // remembering which sorts are load-bearing.
    usersWithRelationships.sort((a, b) => {
      const an = a.name || "";
      const bn = b.name || "";
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    streamLogger.debug("User search completed", {
      term: validatedTerm,
      matchedCount: users.length,
      resultCount: usersWithRelationships.length,
    });

    return usersWithRelationships;
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("User search failed", error, {
      searchTerm: validatedTerm,
    });
    throw error;
  }
};

/**
 * Check if two users have any relationship through appointments.
 *
 * Thin re-export of `canDirectMessage` so the server-action surface keeps its
 * name while the logic lives in `lib/stream/dm-eligibility.ts`. The three
 * private helpers that used to live here (`checkConsultationRelationship`,
 * `checkSubscriptionRelationship`, `checkSharedAppointments`) moved with it —
 * they were the only implementation of the rule, and leaving a second copy
 * behind is how the status sets diverged in the first place.
 *
 * Two behaviour changes came with the move, both deliberate:
 *  - the status set widened to `DM_ELIGIBLE_STATUSES` (adds
 *    APPROVED_PENDING_PAYMENT and COMPLETED) and the subscription
 *    scheduling-window filter is gone, per the ever-transacted rule;
 *  - it no longer swallows errors into `false`.
 *
 * @param userId1 First user ID
 * @param userId2 Second user ID
 * @returns Boolean indicating if they have any relationship
 */
export const checkUserRelationship = async (
  userId1: string,
  userId2: string,
): Promise<boolean> => canDirectMessage(userId1, userId2);

/**
 * @deprecated Use searchUsersWithRelationships instead — this performs a global
 * unscoped search that exposes PII of arbitrary users.
 * @param searchTerm The term to search for (name or email)
 * @returns The users that match the search term
 */
export const searchUsers = async (searchTerm: string) => {
  const validatedTerm = searchTermSchema.parse(searchTerm.trim());

  try {
    const users = await prisma.user.findMany({
      where: {
        AND: [
          {
            NOT: [
              { id: { startsWith: "recording-egress-" } },
              { id: { startsWith: "system-" } },
            ],
          },
          {
            OR: [
              { name: { contains: validatedTerm, mode: "insensitive" } },
              { email: { contains: validatedTerm, mode: "insensitive" } },
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
      take: 10,
      orderBy: [{ name: "asc" }],
    });

    streamLogger.debug("Legacy user search completed", {
      term: validatedTerm,
      resultCount: users.length,
    });

    return users;
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Legacy user search failed", error, {
      searchTerm: validatedTerm,
    });
    throw error;
  }
};
