/**
 * Novu subscriber identity. The subscriberId is `User.id`; Novu creates the
 * subscriber on the first trigger or Inbox session, and holds no profile or
 * preference data of ours. Preferences live only in Postgres.
 */
import { createHmac } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { getNovuClient, isNovuConfigured } from "./client";
import { resolveNovuSecretKey } from "./secret-key";

/** Computes the HMAC-SHA256 subscriber hash for Novu Inbox authentication when a secret key is configured. */
export function computeSubscriberHash(
  subscriberId: string,
): string | undefined {
  const { key } = resolveNovuSecretKey();
  if (!key) return undefined;
  return createHmac("sha256", key).update(subscriberId).digest("hex");
}

const StatusCodeSchema = z.object({ statusCode: z.number() });

function statusCodeOf(error: unknown): number | undefined {
  const parsed = StatusCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.statusCode : undefined;
}

/** Strips echoed PII from Novu errors and classifies timeouts as warnings. */
function reportDeleteError(error: unknown): void {
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
      op: "delete",
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
 * but it may report the vendor copy as still pending.
 */
export async function deleteSubscriber(userId: string): Promise<boolean> {
  if (!isNovuConfigured()) return true;

  try {
    await removeSubscriber(userId);
    console.log(`[Novu] Subscriber deleted: ${userId}`);
    return true;
  } catch (error) {
    reportDeleteError(error);
    console.error(
      "[Novu] Failed to delete subscriber:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
