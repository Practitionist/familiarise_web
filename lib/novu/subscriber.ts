/**
 * Novu Subscriber Management
 * Syncs user data to Novu as subscribers using User.id as subscriberId.
 */
import { createHmac } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { EMAIL_CATEGORY_COLUMN } from "@/lib/email/preferences";
import { getNovuClient, isNovuConfigured } from "./client";
import { resolveNovuSecretKey } from "./secret-key";
import { CATEGORY_FLAG } from "./templates/conditions";
import type { PreferenceCategory } from "./templates/types";

/** Computes the HMAC-SHA256 subscriber hash for Novu Inbox authentication when a secret key is configured. */
export function computeSubscriberHash(
  subscriberId: string,
): string | undefined {
  const { key } = resolveNovuSecretKey();
  if (!key) return undefined;
  return createHmac("sha256", key).update(subscriberId).digest("hex");
}

type RoutingMode = "BELL_AND_EMAIL" | "BELL_ONLY" | "EMAIL_ONLY" | "NEITHER";

export interface SubscriberPreferencesInput {
  allNotifications: boolean;
  inApp?: boolean;
  email?: boolean;
  push?: boolean;
  appointmentReminders?: boolean;
  paymentNotifications?: boolean;
  supportUpdates?: boolean;
  feedbackAlerts?: boolean;
  trialNotifications?: boolean;
  subscriptionAlerts?: boolean;
  marketingEmails?: boolean;
  orgBillingAlerts?: boolean;
  orgMembershipAlerts?: boolean;
  orgProgramAlerts?: boolean;
}

interface SubscriberData {
  userId: string;
  email: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  avatar?: string;
  locale?: string;
  routingMode?: RoutingMode;
  preferences?: SubscriberPreferencesInput;
}

type PersistedUserPrefsRow = {
  orgWorkspaceProfile?: {
    notificationRoutingMode?: RoutingMode | null;
  } | null;
  notificationPreferences?: {
    allNotifications?: boolean;
    inAppEnabled?: boolean;
    emailEnabled?: boolean;
    pushEnabled?: boolean;
    appointmentReminders?: boolean;
    paymentNotifications?: boolean;
    supportUpdates?: boolean;
    feedbackAlerts?: boolean;
    trialNotifications?: boolean;
    subscriptionAlerts?: boolean;
    marketingEmails?: boolean;
    orgBillingAlerts?: boolean;
    orgMembershipAlerts?: boolean;
    orgProgramAlerts?: boolean;
  } | null;
};

/**
 * Builds the complete Novu custom-data map by merging caller overrides with persisted
 * preferences. Propagates DB failures so a transient outage never un-mutes opted-out users.
 */
export async function buildSubscriberCustomData(
  userId: string,
  overrides: {
    routingMode?: RoutingMode;
    preferences?: SubscriberPreferencesInput;
  },
): Promise<Record<string, string | boolean>> {
  let dbRow: PersistedUserPrefsRow | null = null;
  if (
    overrides.routingMode === undefined ||
    overrides.preferences === undefined
  ) {
    dbRow = (await prisma.user?.findUnique({
      where: { id: userId },
      select: {
        orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
        notificationPreferences: {
          select: {
            allNotifications: true,
            inAppEnabled: true,
            emailEnabled: true,
            pushEnabled: true,
            appointmentReminders: true,
            paymentNotifications: true,
            supportUpdates: true,
            feedbackAlerts: true,
            trialNotifications: true,
            subscriptionAlerts: true,
            marketingEmails: true,
            orgBillingAlerts: true,
            orgMembershipAlerts: true,
            orgProgramAlerts: true,
          },
        },
      },
    })) as PersistedUserPrefsRow | null;
  }

  const routingMode: RoutingMode =
    overrides.routingMode ??
    dbRow?.orgWorkspaceProfile?.notificationRoutingMode ??
    "BELL_AND_EMAIL";
  const dbPrefs = dbRow?.notificationPreferences;
  const prefs = overrides.preferences;

  const categoryFlags = Object.fromEntries(
    (Object.keys(EMAIL_CATEGORY_COLUMN) as PreferenceCategory[]).map(
      (category) => {
        const col = EMAIL_CATEGORY_COLUMN[category];
        return [
          CATEGORY_FLAG[category],
          prefs?.[col] ?? dbPrefs?.[col] ?? true,
        ];
      },
    ),
  );

  return {
    routingMode,
    routingBell:
      routingMode === "BELL_AND_EMAIL" || routingMode === "BELL_ONLY",
    routingEmail:
      routingMode === "BELL_AND_EMAIL" || routingMode === "EMAIL_ONLY",
    masterEnabled: prefs?.allNotifications ?? dbPrefs?.allNotifications ?? true,
    preferInApp: prefs?.inApp ?? dbPrefs?.inAppEnabled ?? true,
    preferEmail: prefs?.email ?? dbPrefs?.emailEnabled ?? true,
    preferPush: prefs?.push ?? dbPrefs?.pushEnabled ?? false,
    ...categoryFlags,
    categoryMarketing:
      prefs?.marketingEmails ?? dbPrefs?.marketingEmails ?? false,
  };
}

/** Strips echoed PII from Novu errors and classifies timeouts as warnings. */
const StatusCodeSchema = z.object({ statusCode: z.number() });

function statusCodeOf(error: unknown): number | undefined {
  const parsed = StatusCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.statusCode : undefined;
}

function reportSubscriberError(
  error: unknown,
  op: "sync" | "update_preferences" | "delete",
): void {
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

/** Upserts user profile and notification preference flags onto the Novu subscriber. */
export async function syncSubscriber(data: SubscriberData): Promise<void> {
  if (!isNovuConfigured()) {
    console.warn("[Novu] Not configured, skipping subscriber sync");
    return;
  }

  try {
    const novu = getNovuClient();
    const customData = await buildSubscriberCustomData(data.userId, {
      routingMode: data.routingMode,
      preferences: data.preferences,
    });
    await novu.subscribers.create({
      subscriberId: data.userId,
      firstName: data.firstName,
      lastName: data.lastName || "",
      email: data.email,
      phone: data.phone || undefined,
      avatar: data.avatar || undefined,
      locale: data.locale || "en",
      data: customData,
    });
    console.log(`[Novu] Subscriber synced: ${data.userId}`);
  } catch (error) {
    reportSubscriberError(error, "sync");
    console.error(
      "[Novu] Failed to sync subscriber:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Idempotently upserts subscriber custom preference data in Novu. */
export async function updateSubscriberPreferences(
  userId: string,
  preferences: SubscriberPreferencesInput,
  routingMode?: RoutingMode,
): Promise<void> {
  if (!isNovuConfigured()) return;

  try {
    const novu = getNovuClient();
    const customData = await buildSubscriberCustomData(userId, {
      routingMode,
      preferences,
    });
    await novu.subscribers.create({
      subscriberId: userId,
      data: customData,
    });
    console.log(`[Novu] Preferences updated for subscriber: ${userId}`);
  } catch (error) {
    reportSubscriberError(error, "update_preferences");
    console.error(
      "[Novu] Failed to update subscriber preferences:",
      error instanceof Error ? error.message : String(error),
    );
  }
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
