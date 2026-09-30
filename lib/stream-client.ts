/**
 * Centralized Stream Client Manager
 * Provides singleton instances for StreamChat and handles connection management
 */

import * as Sentry from "@sentry/nextjs";
import { StreamChat } from "stream-chat";
import { StreamClient } from "@stream-io/node-sdk";
import { createCircuitBreaker } from "@/lib/redis";
import { Refusal } from "@/lib/errors/refusal";

// Environment validation
const STREAM_API_KEY = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const STREAM_API_SECRET = process.env.STREAM_API_SECRET;

// Singleton instances
let chatClientInstance: StreamChat | null = null;
let videoClientInstance: StreamClient | null = null;

// Connection state tracking
let isInitialized = false;

/**
 * Validates that Stream API credentials are configured
 * @throws Error if credentials are missing
 */
export function validateStreamConfig(): void {
  if (!STREAM_API_KEY) {
    throw new Error(
      "NEXT_PUBLIC_STREAM_API_KEY is not configured. Please set it in your environment variables.",
    );
  }
  if (!STREAM_API_SECRET) {
    throw new Error(
      "STREAM_API_SECRET is not configured. Please set it in your environment variables.",
    );
  }
}

/**
 * Check if Stream is properly configured
 */
export function isStreamConfigured(): boolean {
  return !!(STREAM_API_KEY && STREAM_API_SECRET);
}

/**
 * Get the singleton StreamChat server client instance
 * This client is for server-side operations only (has secret)
 */
export function getStreamChatClient(): StreamChat {
  validateStreamConfig();

  if (!chatClientInstance) {
    chatClientInstance = StreamChat.getInstance(
      STREAM_API_KEY!,
      STREAM_API_SECRET!,
      {
        timeout: 30000, // 30 seconds timeout for operations
      },
    );
    isInitialized = true;
  }

  return chatClientInstance;
}

/**
 * Get the singleton Stream Video server client instance
 * This client is for server-side video operations only (has secret)
 */
export function getStreamVideoClient(): StreamClient {
  validateStreamConfig();

  if (!videoClientInstance) {
    videoClientInstance = new StreamClient(STREAM_API_KEY!, STREAM_API_SECRET!);
  }

  return videoClientInstance;
}

/**
 * Get the Stream API key (safe for client-side)
 */
export function getStreamApiKey(): string {
  if (!STREAM_API_KEY) {
    throw new Error("NEXT_PUBLIC_STREAM_API_KEY is not configured");
  }
  return STREAM_API_KEY;
}

/**
 * Generate a chat token for a user
 * @param userId The user ID to generate token for
 * @param expirationTime Token lifetime in SECONDS. REQUIRED — see below.
 */
export function generateChatToken(
  userId: string,
  expirationTime: number,
): string {
  const client = getStreamChatClient();

  // #1134 P0-4 — the third argument is `iat`, and omitting it made a ban
  // permanent. Stream treats a token with no `iat` as INVALID once
  // `revoke_tokens_issued_before` is set for that user, and that flag persists
  // until explicitly cleared. So a 7-day suspension revoked every future token
  // too, forever. Match generateVideoToken's 60s skew allowance.
  const issued = Math.floor(Date.now() / 1000) - 60;

  // #1134 P0-4 follow-up — `expirationTime` was OPTIONAL and
  // `createToken(userId, undefined, issued)` minted a token with NO `exp`. That
  // path was latent (both production callers passed the shared
  // `STREAM_TOKEN_TTL_SECONDS`) and it was pinned by a test asserting the
  // no-expiry behaviour, which is what kept it alive through every refactor: a
  // test named "should generate token without expiration" reads as a contract,
  // not as a snapshot of an accident.
  //
  // A non-expiring token is not merely untidy. It is a credential that never
  // ages out, so the ONLY way to revoke it is `revoke_tokens_issued_before` —
  // the same mechanism that, once set, is global for the user. A leaked or
  // over-minted token therefore has no per-token remedy at all, and a user who
  // was ever suspended cannot be given a working token again without an
  // explicit `revokeUserToken(id, null)` that a caller will not remember to
  // make. Requiring the TTL makes the expiry a property of the CALL SITE, which
  // is the only place that knows how long the token is needed for.
  const exp = Math.floor(Date.now() / 1000) + expirationTime;
  return client.createToken(userId, exp, issued);
}

// #1134 P0-1 — a `generateCallToken` wrapper (a token carrying a `call_cids`
// claim) was written for the join gate and then removed unused: the video client
// is an app-wide singleton holding one user token, and the JS SDK has no
// per-call token on a shared client, so using one would mean a second client per
// meeting. /api/meetings/[id]/join grants membership server-side instead. Add
// call tokens back when guest/magic-link join lands, which genuinely needs them.

/**
 * Generate a video token for a user
 * @param userId The user ID to generate token for
 * @param expirationSeconds Token expiration in seconds (default: 3600 = 1 hour)
 */
export function generateVideoToken(
  userId: string,
  expirationSeconds: number = 3600,
): string {
  const client = getStreamVideoClient();

  const exp = Math.round(Date.now() / 1000) + expirationSeconds;
  const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago for clock skew

  return client.generateUserToken({
    user_id: userId,
    exp,
    iat: issued,
  });
}

/**
 * Check if the Stream client is initialized
 */
export function isClientInitialized(): boolean {
  return isInitialized;
}

/**
 * Reset client instances (useful for testing)
 */
export function resetClients(): void {
  chatClientInstance = null;
  videoClientInstance = null;
  isInitialized = false;
}

/**
 * Sentinel thrown by withStreamCircuitBreaker when the breaker is OPEN and the
 * caller did not supply a fallback. Lets hot paths distinguish "Stream is down,
 * we fast-failed" from a genuine Stream API error and degrade accordingly.
 */
export class StreamUnavailableError extends Error {
  constructor() {
    super("Stream circuit breaker is OPEN — Stream temporarily unavailable");
    this.name = "StreamUnavailableError";
  }
}

/**
 * #899 — a Stream "channel not found" (error code 16 / HTTP 404) is the EXPECTED
 * miss on the lazy create-or-join path: callers probe with addMembers/query
 * before getOrCreate, so a not-yet-created webinar/class channel always 404s the
 * first time. It proves Stream is up and responding, so it must NOT trip the
 * circuit breaker or be reported to Sentry as an error — only genuine outages
 * (network/timeout/5xx) should. (stream-chat ErrorFromResponse exposes .code/.status.)
 */
export function isExpectedStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return streamErrorCode(error) === 16 || streamHttpStatus(error) === 404;
}

/**
 * #1829 — the HTTP status of a Stream error, across BOTH SDKs.
 *
 * There is no single place either SDK puts it, and reading the wrong one makes a
 * classifier silently always-false rather than throwing:
 *
 *   `@stream-io/node-sdk` (video/live-streaming) throws `StreamError`, whose own
 *   enumerable keys are `["metadata", "code"]`. The status is at
 *   `metadata.responseCode`, built from `response.status`. There is NO `.status`
 *   and NO `.statusCode` — the class does not define them.
 *
 *   `stream-chat` throws `ErrorFromResponse`, which DOES set `.status` (and
 *   `.code` from the body).
 *
 * So a classifier reading only `.status` works for chat and is dead for every
 * video call, with nothing to indicate which. `isRateLimitError` was exactly
 * that, which made the STREAM_QUOTA path unreachable from the two routes that
 * document it and let a 429 trip the circuit breaker — the opposite of the
 * intent, and the 2026-08-23 incident this file's docblock claims to have fixed.
 *
 * Order matters: `metadata.responseCode` is authoritative for the video SDK
 * because it is set from the response itself, whereas `code` is the body's
 * `code` field and is a Stream error code (16 = not-found), not an HTTP status.
 * `status` is checked first because for `stream-chat` it is the direct value.
 */
export function streamHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    metadata?: { responseCode?: unknown };
  };
  // `stream-chat`'s ErrorFromResponse.
  if (typeof e.status === "number") return e.status;
  // `@stream-io/node-sdk`'s StreamError — the HTTP response status.
  if (typeof e.metadata?.responseCode === "number")
    return e.metadata.responseCode;
  // Razorpay/Stripe-shaped, kept because sibling code in this repo is written
  // against it and a shared helper that silently drops those would be its own
  // regression.
  if (typeof e.statusCode === "number") return e.statusCode;
  return null;
}

/**
 * The Stream error `code` from a response BODY (`16` = not found), or the HTTP
 * status when the body was not JSON — the SDK passes `response.status` into the
 * `code` slot on that path, so the two overlap harmlessly.
 */
export function streamErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

/**
 * A Stream rate-limit rejection (HTTP 429) means the app exhausted a per-minute
 * quota — quota, not availability. The 2026-08-23 incident showed why the two
 * must not be conflated: the daily expire cron burned through its
 * UpdateChannelPartial budget, and the resulting 429s tripped this breaker,
 * which then fast-failed the UNRELATED deleteChannels stage too. Rate limits
 * therefore neither trip the breaker nor page Sentry as errors; callers that
 * pace themselves (see jobs/stream/expire-event-channels.ts FREEZE_PACING_MS)
 * should stay under the cap in the first place.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return streamHttpStatus(error) === 429;
}

/**
 * A Stream refusal to serve because the APP IS SUSPENDED is not an outage, and
 * treating it as one is how the most likely real incident at a pre-revenue
 * company presents as an unreadable flap.
 *
 * #1280 2.2 — only 404 and 429 were classified, so a suspended account fell
 * into the generic branch: Sentry error, breaker trips, 30-second reset,
 * half-open probe, trips again, forever. Nothing in that loop says "we owe
 * Stream money", which is the only fact a human can act on.
 *
 * ## Exactly one code, checked against Stream's published table
 *
 * Read from <https://getstream.io/chat/docs/node/api_errors_response/>:
 *
 *   | code | HTTP | meaning              |
 *   |------|------|----------------------|
 *   |   99 |  403 | App suspended        |
 *   |    2 |  401 | Access Key invalid   |
 *   |   17 |  403 | Insufficient perms   |
 *   |   70 |  403 | No channel access    |
 *
 * An earlier revision of this matched `402 || 403 || code 99 || code 2`, and
 * three quarters of that was wrong in a way that mattered:
 *
 *   - **code 2 is authentication, not billing.** A rotated-away or mistyped
 *     API key would have been excluded from the breaker and reported as "we owe
 *     Stream money" — the single most misleading diagnosis available for a
 *     misconfiguration, because it sends someone to the billing page instead of
 *     the env vars.
 *   - **a bare 403 is not billing either.** Codes 17 and 70 share it, so an
 *     ordinary permission refusal would have been laundered into a billing
 *     alert.
 *   - **Stream documents no 402 at all.** Keeping it implied knowledge of a
 *     contract that does not exist.
 *
 * So: code 99, and nothing else. Narrow and cited beats broad and guessed —
 * anything this does not catch still reaches the generic branch, which pages.
 *
 * Treated like 429 for the breaker: it does NOT trip, because retrying cannot
 * fix it and opening the breaker only hides the cause. Unlike 429 it does not
 * self-resolve, so it escalates to its own alert.
 */
export function isStreamBillingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as { code?: number | null };
  return e.code === 99;
}

/**
 * How long a caller should wait before retrying after a Stream 429.
 *
 * Deliberately 60 s. A 429 means an app-wide per-minute budget is spent, so the
 * budget resets on the provider's minute boundary; retrying sooner is the same
 * request failing again, and a user who retries a join button every 2 s is
 * spending the budget that the rest of the app needs. One minute is also what a
 * reasonable client-side backoff lands on, so a caller that just honours the
 * header and a caller with its own ladder agree.
 */
export const STREAM_QUOTA_RETRY_AFTER_SECONDS = 60;

/**
 * The typed refusal a route should answer with when a Stream call 429s.
 *
 * Exists because the two most important Stream call sites — the meeting join
 * door and the recording start door — both answered 500 and reported the error
 * to Sentry, which is wrong twice over. A 429 is self-inflicted quota
 * exhaustion, not a fault: reporting it spends error quota on a fact Stream has
 * already alerted us about (see the capture suppression in
 * {@link withStreamCircuitBreaker}), and a 500 tells the user — and every
 * retry-on-5xx client, and every 5xx-bucket dashboard — that we broke something
 * we did not break.
 *
 * It is a `Refusal` rather than a bare object so the shape cannot drift from the
 * house pattern: `code` is what a client branches on, `userMessage` is the
 * sentence a toast shows, and `devMessage` is all Sentry and the logs get. No
 * Stream error text reaches any of the three, which is what "a typed code with a
 * face, never raw backend text" means in practice.
 *
 * Returned, not thrown: the call site has the error in hand and is already in
 * its catch block, and `apiError`'s refusal branch records a 5xx refusal as an
 * `info` event rather than a fault.
 */
export function streamQuotaRefusal(): Refusal {
  return new Refusal({
    code: "STREAM_QUOTA",
    // 503, not 429: the 429 was OURS to fix, not the caller's request. The
    // distinction matters to every client that retries on 5xx but should not
    // retry on 429, and to any monitor that counts 4xx as a bad request.
    httpStatus: 503,
    userMessage: "Video is busy right now. Please wait a moment and try again.",
    devMessage: `Stream rate limit (HTTP 429) — the app-level per-minute budget for this endpoint is spent. Retry-After: ${STREAM_QUOTA_RETRY_AFTER_SECONDS}s.`,
  });
}

/** True when `error` is a Stream 429 — the one case a route must not report. */
export function isStreamQuotaError(error: unknown): boolean {
  return isRateLimitError(error);
}

/**
 * #1280 2.1 — Stream's OWN breaker, not Redis's.
 *
 * These used to be the same object. Five Stream failures opened it and booking
 * locks went through it too, so a video-vendor outage stopped checkout; in the
 * other direction a Redis outage told users "Video is temporarily unavailable"
 * and pointed `/api/health` at the wrong vendor.
 */
const streamCircuitBreaker = createCircuitBreaker("stream");

/** Exposed so /api/health can report Stream's breaker rather than Redis's. */
export function getStreamCircuitStatus() {
  return streamCircuitBreaker.status();
}

// ─────────────────────────────────────────────────────────────────────────────
// Why the breaker state is NOT in Redis — read this before "fixing" it
// ─────────────────────────────────────────────────────────────────────────────
//
// The obvious repair for a breaker that barely works on serverless is to move
// its state into Redis (`SET breaker:stream OPEN EX 30`) and gate every call on
// it. That was evaluated and rejected. Four reasons, in order of how much they
// would have cost:
//
//  1. **It is the largest new Upstash line item available.** Gating means a GET
//     on the way into EVERY Stream call — and Stream calls are the hot path
//     here: `upsertUsersToStream` on dashboard loads, `queryChannels` for the
//     sidebar and the unread badge, channel opens, member diffs. The Upstash
//     500k-command cap has already been hit twice (#1792 at 696k, #1822), and
//     `.env.sample` records the standing discipline that command COUNT is the
//     budget, not dollar spend. Spending ~7% of the remaining cap to make a
//     breaker accurate is a bad trade, and it is exactly the kind of burn the
//     cron-tick cadence work (#1686/#1792) was done to remove.
//
//  2. **It re-couples Stream to Redis, which is the thing #1280 2.1 removed.**
//     A Redis-backed gate must be READ on the Stream path, so a Redis outage
//     degrades Stream calls, and the fast-fail reason becomes "Redis is down"
//     rather than "Stream is down". That is the precise mis-attribution that
//     issue was filed to end: `/api/health` blamed Stream for a Redis outage
//     and sent whoever was on call to the wrong vendor. The gate would also have
//     to fail open (restoring a 30-second stall per call during the outage) or
//     fail closed (declaring Stream down when it is fine). Both are worse than
//     the in-memory breaker.
//
//  3. **A shared OPEN has a larger blast radius than the failure it describes.**
//     Today an open breaker refuses one warm instance for 30 s. A shared key
//     would let a single instance's socket blip — a cold start, one DNS
//     hiccup, an idle container's first TLS handshake — fast-fail EVERY instance
//     in the fleet for the full 30 s. Converting a local symptom into a global
//     one is not obviously an improvement, and the 5-failures-to-open threshold
//     was tuned (per #1280 Bucket 4) against exactly that kind of cascade.
//
//  4. **Half the value is not the fast-fail at all — it is the KNOWLEDGE that a
//     fast-fail happened.** That is cheap and is implemented instead: the
//     breaker's state is exposed through `getStreamCircuitStatus()` and reported
//     by `/api/health` (which did not call it until now, so a Stream outage
//     was invisible), and the Sentry trickle in `sentry.shared.config.ts` means
//     the storm of `StreamUnavailableError`s a long outage produces costs one
//     event per window instead of thousands. The 2026-09-21 Upstash incident
//     showed this project will spend a whole error quota on a single dependency;
//     the breaker is the noisiest producer in that shape, and that is a
//     reporting problem, not a state-placement problem.
//
// What this DOES mean, stated plainly so nobody is surprised: on a cold instance
// the breaker starts CLOSED and has to accumulate five consecutive failures
// before it refuses anything, so it protects the second probe of an outage and
// essentially none of the first. The thresholds are deliberately not touched
// (#1280 Bucket 4), and no caller should come to depend on a fast-fail as a
// correctness mechanism — every Stream call site is required to handle a
// rejected call on its own terms anyway.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #473 — wrap a hot-path Stream network call in Stream's circuit breaker so a
 * Stream outage fast-fails (sub-ms) instead of every dashboard load eating the
 * full 30s client timeout and cascading.
 *
 * Closed-breaker behaviour is identical to calling `operation` directly, except
 * an expected "channel not found" miss (#899) is classified via `shouldTrip` so
 * it neither counts toward the breaker nor reaches Sentry — it rejects with the
 * original error for the caller's create/fallback branch. Other real Stream
 * errors reject with the original error and are captured. Only when the breaker
 * is already OPEN does withCircuitBreaker reject with its generic "circuit
 * breaker is OPEN" Error — we intercept that to run the caller's `fallback`
 * (graceful degradation) or throw the typed StreamUnavailableError.
 */
export async function withStreamCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
): Promise<T> {
  try {
    // #899 — expected "channel not found" misses must not trip the breaker;
    // neither do 429s (quota ≠ outage, see isRateLimitError).
    return await streamCircuitBreaker.run(
      operation,
      undefined,
      (e) =>
        !(
          isExpectedStreamError(e) ||
          isRateLimitError(e) ||
          isStreamBillingError(e)
        ),
    );
  } catch (error) {
    // Distinguish "breaker is OPEN, we never tried" from a real Stream error.
    if (
      error instanceof Error &&
      error.message.includes("circuit breaker is OPEN")
    ) {
      if (fallback) return fallback();
      const unavailable = new StreamUnavailableError();
      Sentry.captureException(unavailable, {
        tags: { subsystem: "stream" },
        level: "warning",
      });
      throw unavailable;
    }
    // A billing refusal is the one class here that needs a HUMAN, not a retry.
    // It is reported before the generic branch and with its own tag, so it does
    // not read as one more Stream error in a flap.
    if (isStreamBillingError(error)) {
      Sentry.captureException(error, {
        tags: { subsystem: "stream", reason: "stream.billing" },
        level: "error",
      });
      throw error;
    }
    // #899 — an expected miss (channel not found) is normal on the lazy
    // create-or-join path: rethrow for the caller's create/fallback branch
    // without Sentry noise. A 429 is self-inflicted quota exhaustion, already
    // alerted on by Stream itself — also not an error page. Only genuine
    // Stream errors are captured.
    if (!(isExpectedStreamError(error) || isRateLimitError(error))) {
      Sentry.captureException(error, { tags: { subsystem: "stream" } });
    }
    throw error;
  }
}

// Type exports for external use
export type { StreamChat };
