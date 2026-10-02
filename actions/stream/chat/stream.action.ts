"use server";

import { z } from "zod";
import {
  generateVideoToken,
  generateChatToken,
  isStreamConfigured,
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  okResult,
  refusalResult,
  type ActionResult,
} from "@/lib/errors/action-result";
import { Refusal } from "@/lib/errors/refusal";
import { STREAM_TOKEN_TTL_SECONDS } from "@/lib/stream/token-ttl";
import { noteStreamTokenMint } from "@/lib/stream/usage";
import { STREAM_CONSENT_REFUSAL } from "@/lib/meetings/access";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import * as Sentry from "@sentry/nextjs";

// Input validation
const userIdSchema = z.string().min(1, "User ID is required");

/**
 * Cut the subject's live Stream access, so a withdrawal is not merely "the next
 * token is refused" while an already-connected socket keeps reading and writing.
 *
 * `revokeUserToken(id, now)` sets `revoke_tokens_issued_before = now`, which
 * invalidates every token issued before that instant — including the one the
 * open socket is holding — and drops that connection. This is the same write
 * `applyStreamEnforcement` performs for a moderation ban
 * (`lib/moderation/side-effects.ts`), reused rather than reinvented.
 *
 * `deactivateUser` is deliberately NOT used, and the difference is the whole
 * reason this is safe to fire from a token mint:
 *
 *   - `deactivateUser` is PERMANENT. The only undo is `restoreStreamAccess`,
 *     whose docblock is explicit that callers "should invoke this from whatever
 *     unban path they build; there is no automated one today".
 *   - Consent withdrawal is REVERSIBLE. `upsertUserToStream` documents the
 *     remedy — "consent is re-established by an org admin via that consent
 *     route" — and the org consent POST re-grants. Deactivating on withdrawal
 *     would turn a reversible legal act into a permanent account state with no
 *     automated way back, which is a worse defect than the one being fixed.
 *   - Revocation SELF-HEALS, because `lib/stream-client.ts` always stamps `iat`
 *     (the SKILL's hard rule). A token minted after the re-grant carries a later
 *     `iat` than the revoke timestamp and Stream accepts it. See the identical
 *     reasoning in `applyStreamEnforcement`'s comment.
 *
 * Best-effort by design: this runs on a REFUSAL path, so a Stream outage must
 * not turn "no consent" into a 500, and must not become the retry budget for a
 * verdict that is already decided. Swallowed failures are warn-logged, never
 * error-level — the gate is what enforces consent; this only kills the socket.
 */
async function revokeStreamAccessOnWithdrawal(userId: string): Promise<void> {
  try {
    await withStreamCircuitBreaker(async () => {
      const chat = getStreamChatClient();
      await chat.revokeUserToken(userId, new Date());
    });
    streamLogger.info("Revoked Stream tokens after consent withdrawal", {
      userId,
    });
  } catch (error) {
    streamLogger.warn(
      "Could not revoke Stream tokens for a user without consent — the gate still refuses to mint",
      { userId, error },
    );
  }
}

/**
 * Tokens may only be minted for the caller's own userId (staff/admin may mint
 * for anyone), and never for a banned user — Stream's server-side API skips all
 * permission checks, so this session bind is the only gate against identity
 * spoofing and re-minting a revoked/suspended identity (#693/#899).
 *
 * And never for a SUBJECT without `STREAM_DATA_PROCESSING` consent — the
 * DPDP Act 2023 purpose gate, which used to exist only on the Stream user
 * upsert (`actions/stream/chat/user.action.ts`). That was two checks guarding
 * one of the three ways a chat or video credential is obtained: the upsert is
 * skipped entirely for an already-synced user, the sync cache outlives a
 * withdrawal in the tabs already open, and `isUserSynced` short-circuits before
 * the gate is even reached. A withdrawn user kept an existing socket and could
 * re-mint a FRESH one-hour token (`STREAM_TOKEN_TTL_SECONDS = 3600`) every time
 * the client cache expired — indefinitely. docs/compliance/08 records this as
 * Gap #3.
 *
 * ## Why the gate sits HERE and not only on the upsert
 *
 * This is the only surface that hands out a credential. `chatTokenProvider` and
 * `tokenProvider` are the two functions the video and chat SDKs call back into
 * (and the SDK calls `tokenProvider` again on its own schedule), so a refusal
 * here stops every path to a new token: the first connect, a reconnect after a
 * dropped socket, a fresh tab, and a page that sat open past withdrawal. It is
 * also where the revocation above can hang, so refusing and cutting the live
 * access are one decision rather than two that can drift.
 *
 * ## Why the gate is LAST in this function
 *
 * Order is load-bearing. `checkConsent` is a database read keyed by a
 * caller-supplied id, so running it before the session bind and the
 * cross-user check would turn this action into an oracle: any signed-in user
 * could ask "does <arbitrary-id> have stream consent?" by watching whether the
 * answer is a token or a refusal. Identity is settled first; only then is a
 * consent row read, and only ever for a subject the caller is entitled to act
 * for.
 *
 * ## Why it is checked for the SUBJECT, not the caller
 *
 * Consent is per (subject × purpose) and never a user-level boolean — the whole
 * point of the taxonomy. A privileged caller does not carry consent on someone
 * else's behalf, so an operator impersonating a data principal cannot be used as
 * a consent-laundering route. In this app every caller is the subject
 * (`providers/StreamProviderImpl.tsx` passes the session user), so the
 * privileged branch is a capability, not a live path.
 *
 * ## Refusal, not failure
 *
 * The answer is RETURNED through `refusalResult`, matching how the missing-
 * session case above already behaves (FAMILIARISE_WEB-13) and how
 * `upsertUserToStream` rethrows `ConsentRequiredError` without an error-level
 * log: "a deliberate refusal, not a failure". It is warn-logged, never
 * `captureException`, so a withdrawn user is not a Sentry incident — and the
 * client, which already handles a Refusal from this action
 * (`refusedConnectFailure` in the provider), renders the message without
 * retrying or reporting it.
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
  // Never mint for a banned/suspended user (#693).
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }
  if (session.user.id !== forUserId && !isPrivileged(session.user.role)) {
    throw new Error("Forbidden: cannot mint a token for another user");
  }

  // DPDP gate, last. Fail-closed by construction: `checkConsent` returns false
  // for a missing artifact, a withdrawn one, or one past its retention window.
  // A throw here (a DB blip) propagates and mints nothing, which is the correct
  // direction — this must never fail OPEN into a token.
  const hasStreamConsent = await checkConsent({
    userId: forUserId,
    purposeCode: PURPOSE_CODES.STREAM_DATA_PROCESSING,
  });
  if (!hasStreamConsent) {
    streamLogger.warn(
      "Refusing Stream token mint — STREAM_DATA_PROCESSING consent absent",
      {
        userId: forUserId,
        requestedBy: session.user.id,
      },
    );
    // Not awaited into the verdict: the refusal is already decided, and the
    // revocation only makes it bite the sockets that predate it.
    void revokeStreamAccessOnWithdrawal(forUserId);
    return new Refusal({
      code: "CONSENT_REQUIRED",
      httpStatus: 403,
      userMessage: STREAM_CONSENT_REFUSAL,
      devMessage: `Refused Stream token for ${forUserId}: STREAM_DATA_PROCESSING consent absent`,
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

    // #E5 — count the mint against Stream's trailing-30-day MAU window. This is
    // the ONLY place in the repository that can measure MAU, because MAU is
    // defined by who CONNECTED to Stream and no Postgres table records that;
    // a `Session` row proves a signed-in user, which is a superset.
    //
    // Chat only, not video: both actions mint for the same user in the same
    // session, so counting both would inflate MAU twofold for no information.
    // And it is AWAITED rather than floated, on purpose — the meter is one Redis
    // `SET NX` for a user already inside the window, and it is cheap enough to
    // be worth knowing whether it landed. Letting it float instead would trade
    // one Upstash command for a promise this module already has the plumbing to
    // settle.
    await noteStreamTokenMint(validatedUserId);

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
