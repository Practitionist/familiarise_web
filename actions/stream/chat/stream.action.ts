"use server";

import { z } from "zod";
import {
  generateVideoToken,
  generateChatToken,
  isStreamConfigured,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import {
  okResult,
  refusalResult,
  type ActionResult,
} from "@/lib/errors/action-result";
import { Refusal } from "@/lib/errors/refusal";
import prisma from "@/lib/prisma";
import { STREAM_TOKEN_TTL_SECONDS } from "@/lib/stream/token-ttl";
import * as Sentry from "@sentry/nextjs";

// Input validation
const userIdSchema = z.string().min(1, "User ID is required");

const STREAM_CONSENT_REFUSAL =
  "Chat and video are unavailable because data-processing consent for real-time communication has not been granted.";

/**
 * Tokens may only be minted for the caller's own userId (staff/admin may mint
 * for anyone), and never for a banned or erased user — Stream's server-side API
 * skips all permission checks, so this session bind is the only gate against
 * identity spoofing and re-minting a revoked/suspended/erased identity.
 */
async function assertCanMintToken(
  forUserId: string,
): Promise<Refusal | undefined> {
  // Bypass the cookie-session cache so a just-demoted staff/admin (or a
  // just-banned user) can't keep minting cross-user tokens until the cache
  // expires (#899).
  const session = await getSession(true);
  if (!session?.user?.id) {
    // A tab whose cookie expired while it sat open: an answer the caller
    // RETURNS, because anything thrown here is captured (FAMILIARISE_WEB-13).
    return new Refusal({
      code: "UNAUTHENTICATED",
      httpStatus: 401,
      userMessage: "Please sign in again to continue.",
      devMessage: "Unauthorized: sign in to request a Stream token",
    });
  }
  // Never mint for a banned/suspended user or erased account.
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }
  if ((session.user as { erasedAt?: Date | string | null }).erasedAt) {
    throw new Error("Forbidden: account erased");
  }
  if (session.user.id !== forUserId && !isPrivileged(session.user.role)) {
    throw new Error("Forbidden: cannot mint a token for another user");
  }
  const targetUser = await prisma.user?.findUnique?.({
    where: { id: forUserId },
    select: { id: true, erasedAt: true, banned: true },
  });
  if (targetUser === null || targetUser?.erasedAt) {
    throw new Error("Forbidden: account erased");
  }
  if (targetUser?.banned) {
    throw new Error("Forbidden: account suspended");
  }
  const hasStreamConsent = await checkConsent({
    userId: forUserId,
    purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
  });
  if (!hasStreamConsent) {
    streamLogger.warn(
      "Refusing Stream token mint — STREAM_DATA_PROCESSING consent not granted",
      { userId: forUserId },
    );
    return new Refusal({
      code: "CONSENT_REQUIRED",
      httpStatus: 403,
      userMessage: STREAM_CONSENT_REFUSAL,
      devMessage: `Consent required for purpose: ${PURPOSE_CODES.STREAM_DATA_PROCESSING}`,
      context: { purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING },
    });
  }
  return undefined;
}

/**
 * Generate a video call token for a user
 * Token is valid for 1 hour by default
 * @param userId The user ID to generate token for
 * @returns The video token, or the refusal when there is no session to mint for
 */
export async function tokenProvider(
  userId: string,
): Promise<ActionResult<string>> {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);
  const refused = await assertCanMintToken(validatedUserId);
  if (refused) return refusalResult(refused);

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured for video token generation");
    throw new Error("Stream API is not configured");
  }

  try {
    const token = generateVideoToken(validatedUserId, STREAM_TOKEN_TTL_SECONDS);

    streamLogger.debug("Generated video token", { userId: validatedUserId });

    return okResult(token);
  } catch (error) {
    streamLogger.error("Failed to generate video token", error, {
      userId: validatedUserId,
    });
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    throw error;
  }
}

/**
 * Generate a chat token for a user
 * Token is valid for 1 hour by default
 * @param userId The user ID to generate token for
 * @returns The chat token, or the refusal when there is no session to mint for
 */
export async function chatTokenProvider(
  userId: string,
): Promise<ActionResult<string>> {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);
  const refused = await assertCanMintToken(validatedUserId);
  if (refused) return refusalResult(refused);

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured for chat token generation");
    throw new Error("Stream API is not configured");
  }

  try {
    const token = generateChatToken(validatedUserId, STREAM_TOKEN_TTL_SECONDS);

    streamLogger.debug("Generated chat token", { userId: validatedUserId });

    return okResult(token);
  } catch (error) {
    streamLogger.error("Failed to generate chat token", error, {
      userId: validatedUserId,
    });
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    throw error;
  }
}
