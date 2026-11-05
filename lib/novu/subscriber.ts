/**
 * Novu Subscriber Management
 * Syncs user data to Novu as subscribers using User.id as subscriberId.
 */
import { createHmac, randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  EMAIL_CATEGORY_COLUMN,
  EMAIL_PREFERENCE_SELECT,
} from "@/lib/email/preferences";
import { getNovuClient, isNovuConfigured } from "./client";
import { resolveNovuSecretKey } from "./secret-key";
import { marketingConsentWhere } from "@/lib/compliance/marketing-policy";
import { CATEGORY_FLAG } from "./templates/conditions";
import { preferenceCategorySchema } from "./templates/types";

/** Computes the HMAC-SHA256 subscriber hash for Novu Inbox authentication when a secret key is configured. */
export function computeSubscriberHash(
  subscriberId: string,
): string | undefined {
  const { key } = resolveNovuSecretKey();
  if (!key) return undefined;
  return createHmac("sha256", key).update(subscriberId).digest("hex");
}

const SUBSCRIBER_PREFERENCE_SELECT = {
  ...EMAIL_PREFERENCE_SELECT,
  inAppEnabled: true,
  pushEnabled: true,
  marketingEmails: true,
} as const;

export const PENDING_SUBSCRIBER_SYNC_WHERE = {
  novuSyncPendingAt: { not: null },
  user: { emailVerified: true, erasedAt: null },
} as const;

const subscriberSelect = () =>
  ({
    id: true,
    email: true,
    emailVerified: true,
    name: true,
    phone: true,
    image: true,
    erasedAt: true,
    consentArtifacts: {
      where: marketingConsentWhere(),
      take: 1,
      select: { id: true },
    },
    orgWorkspaceProfile: {
      select: { notificationRoutingMode: true, locale: true },
    },
    notificationPreferences: {
      select: { ...SUBSCRIBER_PREFERENCE_SELECT, novuSyncToken: true },
    },
  }) as const;

type SubscriberSnapshot = Prisma.UserGetPayload<{
  select: ReturnType<typeof subscriberSelect>;
}>;
type PreferenceFlags = Prisma.NotificationPreferenceGetPayload<{
  select: typeof SUBSCRIBER_PREFERENCE_SELECT;
}>;

export interface SubscriberSyncStore {
  user: {
    findUnique(args: {
      where: { id: string };
      select: ReturnType<typeof subscriberSelect>;
    }): Promise<SubscriberSnapshot | null>;
  };
  notificationPreference: {
    upsert(args: {
      where: { userId: string };
      create: {
        userId: string;
        novuSyncToken: string;
        novuSyncPendingAt: Date;
      };
      update: { novuSyncToken: string; novuSyncPendingAt: Date };
      select: { userId: true };
    }): Promise<{ userId: string }>;
    updateMany(
      args: Prisma.NotificationPreferenceUpdateManyArgs,
    ): Promise<{ count: number }>;
    findMany(args: {
      where: {
        novuSyncPendingAt: { not: null };
        user: { emailVerified: true; erasedAt: null };
      };
      orderBy: { novuSyncPendingAt: "asc" };
      take: number;
      select: { userId: true };
    }): Promise<{ userId: string }[]>;
  };
}

/** A unique revision makes acknowledgement conditional on the exact saved change. */
export function subscriberSyncMark() {
  return { novuSyncToken: randomUUID(), novuSyncPendingAt: new Date() };
}

export async function stageSubscriberSync(
  userId: string,
  db: Pick<SubscriberSyncStore, "notificationPreference">,
): Promise<void> {
  const mark = subscriberSyncMark();
  await db.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...mark },
    update: mark,
    select: { userId: true },
  });
}

/** Complete custom data is derived from current persisted settings, never a queued snapshot. */
export function buildSubscriberCustomData(row: {
  consentArtifacts: { id: string }[];
  orgWorkspaceProfile: Pick<
    NonNullable<SubscriberSnapshot["orgWorkspaceProfile"]>,
    "notificationRoutingMode"
  > | null;
  notificationPreferences: PreferenceFlags | null;
}): Record<string, string | boolean> {
  const routingMode =
    row.orgWorkspaceProfile?.notificationRoutingMode ?? "BELL_AND_EMAIL";
  const prefs = row.notificationPreferences;
  const categoryFlags = Object.fromEntries(
    Object.entries(EMAIL_CATEGORY_COLUMN).map(([key, column]) => [
      CATEGORY_FLAG[preferenceCategorySchema.parse(key)],
      prefs?.[column] ?? true,
    ]),
  );
  return {
    routingMode,
    routingBell:
      routingMode === "BELL_AND_EMAIL" || routingMode === "BELL_ONLY",
    routingEmail:
      routingMode === "BELL_AND_EMAIL" || routingMode === "EMAIL_ONLY",
    masterEnabled: prefs?.allNotifications ?? true,
    preferInApp: prefs?.inAppEnabled ?? true,
    preferEmail: prefs?.emailEnabled ?? true,
    preferPush: prefs?.pushEnabled ?? false,
    ...categoryFlags,
    categoryMarketing: Boolean(
      prefs?.marketingEmails && row.consentArtifacts.length > 0,
    ),
  };
}

/** Restores an obligation if an older in-flight write finishes after a newer acknowledgement. */
async function retainSubscriberSync(
  userId: string,
  db: SubscriberSyncStore,
): Promise<void> {
  await db.notificationPreference.updateMany({
    where: { userId, novuSyncToken: null, user: { erasedAt: null } },
    data: subscriberSyncMark(),
  });
}

export async function attemptSubscriberSync(
  userId: string,
  db: SubscriberSyncStore = prisma,
): Promise<boolean> {
  if (!isNovuConfigured()) return false;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: subscriberSelect(),
  });
  const token = user?.notificationPreferences?.novuSyncToken;
  if (!user || !token) return true;
  if (user.erasedAt) {
    await db.notificationPreference.updateMany({
      where: { userId, novuSyncToken: token },
      data: { novuSyncToken: null, novuSyncPendingAt: null },
    });
    return true;
  }
  if (!user.emailVerified) return false;
  const nameParts = (user.name || "User").split(" ");
  try {
    await getNovuClient().subscribers.create({
      subscriberId: user.id,
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(" "),
      email: user.email,
      phone: user.phone || undefined,
      avatar: user.image || undefined,
      locale: user.orgWorkspaceProfile?.locale || "en",
      data: buildSubscriberCustomData(user),
    });
    const settled = await db.notificationPreference.updateMany({
      where: { userId, novuSyncToken: token },
      data: { novuSyncToken: null, novuSyncPendingAt: null },
    });
    if (settled.count === 0) await retainSubscriberSync(userId, db);
    return true;
  } catch (error) {
    // Move a failed revision behind other pending users without replacing newer work.
    await db.notificationPreference.updateMany({
      where: { userId, novuSyncToken: token },
      data: { novuSyncPendingAt: new Date() },
    });
    await retainSubscriberSync(userId, db);
    const original = error instanceof Error ? error : new Error(String(error));
    const clean = new Error(original.message);
    clean.name = original.name;
    if (original.stack) clean.stack = original.stack;
    throw clean;
  }
}

/** Stages before network I/O, including first-time and profile synchronization. */
export async function syncSubscriber(userId: string): Promise<boolean> {
  await stageSubscriberSync(userId, prisma);
  return attemptSubscriberSync(userId, prisma);
}

export async function drainSubscriberSyncs(
  db: SubscriberSyncStore,
  limit: number,
): Promise<{
  scanned: number;
  synced: number;
  pending: number;
  failures: number;
}> {
  const result = { scanned: 0, synced: 0, pending: 0, failures: 0 };
  if (limit <= 0) return result;
  const rows = await db.notificationPreference.findMany({
    where: PENDING_SUBSCRIBER_SYNC_WHERE,
    orderBy: { novuSyncPendingAt: "asc" },
    take: limit,
    select: { userId: true },
  });
  if (!isNovuConfigured())
    return { ...result, scanned: rows.length, pending: rows.length };
  for (let start = 0; start < rows.length; start += 5) {
    const outcomes = await Promise.allSettled(
      rows
        .slice(start, start + 5)
        .map((row) => attemptSubscriberSync(row.userId, db)),
    );
    for (const outcome of outcomes) {
      result.scanned += 1;
      if (outcome.status === "rejected") result.failures += 1;
      else if (outcome.value) result.synced += 1;
      else result.pending += 1;
    }
  }
  return result;
}

/** Strips echoed PII from Novu errors and classifies timeouts as warnings. */
const StatusCodeSchema = z.object({ statusCode: z.number() });

function statusCodeOf(error: unknown): number | undefined {
  const parsed = StatusCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.statusCode : undefined;
}

function reportSubscriberError(error: unknown, op: "delete"): void {
  const rawError = error instanceof Error ? error : new Error(String(error));
  const cleanError = new Error(rawError.message);
  cleanError.name = rawError.name;
  if (rawError.stack) cleanError.stack = rawError.stack;
  const isTimeout = rawError.name === "RequestTimeoutError";
  const statusCode = statusCodeOf(error);

  Sentry.captureException(cleanError, {
    level: isTimeout ? "warning" : "error",
    tags: {
      subsystem: "novu",
      op,
      ...(isTimeout ? { expected: "true" } : {}),
    },
    ...(statusCode !== undefined ? { extra: { statusCode } } : {}),
  });
}

/** Deletes the subscriber or throws; one that never existed counts as deleted. */
export async function removeSubscriber(userId: string): Promise<void> {
  if (!isNovuConfigured()) return;
  try {
    await getNovuClient().subscribers.delete(userId);
  } catch (error) {
    if (statusCodeOf(error) === 404) return;
    throw error;
  }
}

/**
 * Delete a subscriber from Novu (e.g. on account deletion).
 *
 * Returns whether Novu acknowledged the deletion (unconfigured counts as
 * acknowledged: nothing was ever mirrored). Never throws — the caller's
 * local erasure is already committed and must not be reported as failed,
 * but it may report the vendor copy as still pending (#1738 review).
 */
export async function deleteSubscriber(userId: string): Promise<boolean> {
  if (!isNovuConfigured()) return true;

  try {
    await removeSubscriber(userId);
    console.log(`[Novu] Subscriber deleted: ${userId}`);
    return true;
  } catch (error) {
    reportSubscriberError(error, "delete");
    console.error(
      "[Novu] Failed to delete subscriber:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
