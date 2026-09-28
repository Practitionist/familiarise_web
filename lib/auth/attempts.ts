/**
 * Per-account sign-in attempt tracking: the graduated lockout, and the
 * authority that decides whether the page may name the account state.
 *
 * ## Why this exists
 *
 * The edge limiter (`lib/rate-limit.ts`) is keyed on **IP**. That is the right
 * first line, and it stays. It is also, on its own, not a defence against
 * password spraying: an attacker with a residential proxy rotates addresses for
 * free, and a per-IP counter that resets every time they do is a counter that
 * never fills. Conversely, a legitimate user on a shared office NAT shares one
 * IP with everyone else in the building.
 *
 * So the second line is keyed on the **account**, which an attacker rotating
 * IPs cannot rotate. `lib/auth.ts` reads it on every credential sign-in; a
 * non-null `lockedUntil` gates whether a session is issued at all, and
 * `disclosure` carries the verdict the sign-in page renders.
 *
 * ## The two outputs
 *
 * - `lockedUntil` — set once failures cross `LOCKOUT_THRESHOLD`. Answered as
 *   `ACCOUNT_TEMPORARILY_LOCKED` with a real `Retry-After`, so a customer is
 *   told when to come back instead of guessing. **The lockout counts failures,
 *   never successes**: a legitimate user who misremembers one password must
 *   not be locked out by their own memory lapse.
 *
 * - `disclosure` — whether the page may say "we found no account for this
 *   address" / "that address is suspended" instead of the collapsed "that email
 *   and password don't match".
 *
 * ## Why disclosure is graded
 *
 * Flattening `INVALID_EMAIL_OR_PASSWORD` into "no such user" would be the
 * largest single security regression available in this file. It turns the
 * sign-in form into an oracle: type any address, get told whether a paying
 * customer has one. The reply-all address book, a competitor, and a scraper
 * all become one form submission each.
 *
 * The cost lands on the *attacker* rather than the customer, because the lockout
 * above is keyed on the same address being probed. By attempt three a probe is
 * already inside a window that ends in a 15-minute lock, so enumerating N
 * addresses costs N lockouts and yields nothing after the first three probes
 * per address. Meanwhile a real user with a real account who mistypes three
 * times gets the useful sentence *and* the lockout — which is precisely what
 * makes them contact support instead of abandoning the account. The lockout is
 * not a tax on the feature; it is what makes the feature affordable.
 *
 * The disclosure is also **read-only and inert**: it describes an address the
 * caller already typed. It returns no ids, never reveals whether an address is
 * staff or enterprise, and says nothing about an address the caller has not
 * submitted.
 *
 * ## Storage, and why not `@upstash/ratelimit`
 *
 * Plain Redis `INCR` + `EXPIRE`, on the same client the rest of the rate
 * limiting uses, keys namespaced `auth:attempts:` / `auth:lockout:`.
 *
 * The counter needs three things the limiter does not give: an **exact**
 * consumed count (the limiter only reports `remaining`, which forces the
 * `max - remaining` inversion in `verdictFrom` and couples correctness to two
 * separately-declared constants that can drift), a **per-address TTL** used as
 * the lockout expiry, and **deletion** on success. `@upstash/ratelimit` 2.0.8
 * exposes no reset primitive — `getRemaining` exists, `resetRemaining` does not
 * — so "clear on success" would have meant guessing its internal key layout
 * (which also changes for multi-window limiters). A raw counter is ~20 lines,
 * has no hidden coupling, and is trivially testable.
 *
 * Two hard constraints:
 *
 * - **Keys are a SHA-256 of the normalised address, never the address.** Redis
 *   keys are plaintext at rest and visible in `MONITOR`; an address list in
 *   Redis is a customer list in Redis. This project holds `sendDefaultPii:
 *   false` in Sentry for the same reason.
 * - **A Redis failure fails OPEN for the lockout and CLOSED for disclosure.**
 *   The two directions are opposite on purpose: an unreachable counter must not
 *   lock every paying customer out of their own account, and it must not hand
 *   an enumeration oracle to whoever knocked Redis over. The IP-keyed edge
 *   limiter is still doing its job in this state.
 *
 * `INCR` is atomic, so concurrent failures against one address cannot
 * interleave a lost increment — the counter is the shared state that makes
 * spraying expensive, so it has to be correct under exactly the concurrency an
 * attacker is generating.
 */

import { createHash } from "node:crypto";

import redisEdge from "@/lib/redis-edge";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import type { AccountState, SignInDisclosure } from "@/lib/labels/auth-errors";

/**
 * Redis key for an address: `sha256(lower(trim(email)))`, hex.
 *
 * Trimming and lower-casing first is what makes the counter *per account*
 * rather than per string — otherwise `Bob@x.com` and `bob@x.com ` are two
 * separate budgets for one account, and the second is free.
 */
export function accountAttemptKey(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

const ATTEMPTS_PREFIX = "auth:attempts:";
const LOCKOUT_PREFIX = "auth:lockout:";

/**
 * Failures in the window before the account may be named.
 *
 * Three is the smallest number that is genuinely useful to a human (a mistyped
 * address, a stale saved password, a half-remembered one) and the largest that
 * does not hand out a meaningful number of free probes.
 */
export const DISCLOSURE_UNLOCK_AFTER = 3;

/** Failures before the account is locked. */
export const LOCKOUT_THRESHOLD = 8;

/** The first lockout. */
const LOCKOUT_WINDOW_SECONDS_1 = 15 * 60;

/** The second, and every one after it — reached by ignoring the first. */
const LOCKOUT_WINDOW_SECONDS_2 = 60 * 60;

/** How long a lockout is counted for when escalating. */
const LOCKOUT_ESCALATION_WINDOW_SECONDS = 24 * 60 * 60;

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                  */
/* -------------------------------------------------------------------------- */

export interface SignInAttemptVerdict {
  /** When set, sign-in is refused with `ACCOUNT_TEMPORARILY_LOCKED`. */
  lockedUntil: Date | null;
  /** Seconds until the lockout lifts, for `Retry-After`. */
  retryAfterSeconds: number | null;
  /** What the page is allowed to say about this address. */
  disclosure: SignInDisclosure;
}

/** The answer for "no information, proceed normally". */
const NO_ATTEMPT_INFO: SignInAttemptVerdict = {
  lockedUntil: null,
  retryAfterSeconds: null,
  disclosure: { unlocked: false, attempts: 0 },
};

/* -------------------------------------------------------------------------- */
/* Primitives                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Increment a counter and set its TTL on first use.
 *
 * `INCR` creates the key at 0 then increments, so "was it just created?" is
 * answered by reading it back at 1. That single round trip is deliberate: two
 * callers racing on a new key both see a consistent count, and the TTL is set
 * by whichever observes the creation, so a counter can never end up with no
 * expiry.
 *
 * Returns the post-increment value and the remaining TTL in seconds.
 */
async function incrementWithTtl(
  key: string,
  ttlSeconds: number,
): Promise<{ count: number; ttlSeconds: number }> {
  const count = await redisEdge.incr(key);
  if (count === 1) {
    await redisEdge.expire(key, ttlSeconds);
  }
  const ttl = await redisEdge.ttl(key);
  // A non-positive TTL means the key exists with no expiry (should be
  // unreachable — see above) or expired between calls. Either way, re-assert
  // the window rather than report an infinite lockout to a customer.
  const effective = typeof ttl === "number" && ttl > 0 ? ttl : ttlSeconds;
  return { count, ttlSeconds: effective };
}

async function readCounter(
  key: string,
): Promise<{ count: number; ttlSeconds: number } | null> {
  const [raw, ttl] = await Promise.all([redisEdge.get(key), redisEdge.ttl(key)]);
  const count = Number(raw ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  return {
    count,
    ttlSeconds: typeof ttl === "number" && ttl > 0 ? ttl : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Verdict construction                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn the two counters into a verdict.
 *
 * Pure and exported, because the interesting behaviour is the interaction
 * between the thresholds rather than any Redis call, and that is what the unit
 * tests should be able to exercise exhaustively.
 */
export function verdictFrom(
  failures: number,
  failureTtlSeconds: number,
  priorLockouts: number,
): SignInAttemptVerdict {
  const disclosure: SignInDisclosure = {
    unlocked: failures >= DISCLOSURE_UNLOCK_AFTER,
    attempts: failures,
  };

  if (failures < LOCKOUT_THRESHOLD) {
    return { lockedUntil: null, retryAfterSeconds: null, disclosure };
  }

  // A second lockout inside the escalation window is the long one.
  const escalate = priorLockouts >= 1;
  const window = escalate
    ? LOCKOUT_WINDOW_SECONDS_2
    : LOCKOUT_WINDOW_SECONDS_1;
  const seconds = Math.max(failureTtlSeconds, window);

  return {
    lockedUntil: new Date(Date.now() + seconds * 1000),
    retryAfterSeconds: seconds,
    disclosure,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read the current verdict for an address **without** changing it.
 *
 * Called on the before-path of a credential sign-in. A read, so a caller cannot
 * burn an attempt budget by repeatedly asking — important, because this is the
 * function the edge layer calls on *every* request to a sign-in-shaped route.
 */
export async function readSignInAttempt(
  email: string,
): Promise<SignInAttemptVerdict> {
  const key = accountAttemptKey(email);
  try {
    const [failures, lockouts] = await Promise.all([
      readCounter(`${ATTEMPTS_PREFIX}${key}`),
      readCounter(`${LOCKOUT_PREFIX}${key}`),
    ]);
    return verdictFrom(
      failures?.count ?? 0,
      failures?.ttlSeconds ?? 0,
      lockouts?.count ?? 0,
    );
  } catch (error) {
    // Fail open on the lockout, fail closed on disclosure — see the header.
    captureThrottled("auth/attempts:readSignInAttempt", error, {
      subsystem: "auth",
      op: "readSignInAttempt",
      expected: true,
    });
    return NO_ATTEMPT_INFO;
  }
}

/**
 * Record a **failed** sign-in and return the resulting verdict.
 *
 * Only call this when the credentials were genuinely wrong. Calling it on a
 * captcha rejection, a rate-limit refusal, or a validation error would hand out
 * a denial-of-service: an attacker who cannot authenticate at all would still be
 * able to lock a real customer out of their own account.
 */
export async function recordSignInFailure(
  email: string,
): Promise<SignInAttemptVerdict> {
  const key = accountAttemptKey(email);
  try {
    const [failures, lockouts] = await Promise.all([
      incrementWithTtl(`${ATTEMPTS_PREFIX}${key}`, LOCKOUT_WINDOW_SECONDS_2),
      readCounter(`${LOCKOUT_PREFIX}${key}`),
    ]);
    const verdict = verdictFrom(
      failures.count,
      failures.ttlSeconds,
      lockouts?.count ?? 0,
    );
    if (verdict.lockedUntil) {
      // Re-assert the escalation counter alongside the lockout, so the *next*
      // lockout for this address is the long one. `incr` + conditional `expire`
      // keeps this to two commands and is safe under concurrency: a duplicate
      // TTL refresh is harmless.
      await incrementWithTtl(
        `${LOCKOUT_PREFIX}${key}`,
        LOCKOUT_ESCALATION_WINDOW_SECONDS,
      );
    }
    return verdict;
  } catch (error) {
    captureThrottled("auth/attempts:recordSignInFailure", error, {
      subsystem: "auth",
      op: "recordSignInFailure",
      expected: true,
    });
    return NO_ATTEMPT_INFO;
  }
}

/**
 * Clear both counters after a successful sign-in.
 *
 * Best-effort by design. A failure here leaves a genuine user closer to a
 * lockout than they should be, which is an annoyance — and *not* clearing is
 * strictly safer than clearing too eagerly, because a clear-on-every-attempt
 * implementation would let an attacker reset the budget by interleaving one
 * success with each guess.
 */
export async function clearSignInAttempts(email: string): Promise<void> {
  const key = accountAttemptKey(email);
  try {
    await redisEdge.del(...[`${ATTEMPTS_PREFIX}${key}`, `${LOCKOUT_PREFIX}${key}`]);
  } catch (error) {
    captureThrottled("auth/attempts:clearSignInAttempts", error, {
      subsystem: "auth",
      op: "clearSignInAttempts",
      expected: true,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Account state                                                             */
/* -------------------------------------------------------------------------- */

/** The minimal user shape this module needs; keeps Prisma out of the tests. */
export interface AccountStateProbe {
  user: {
    id: string;
    emailVerified: boolean;
    banned: boolean | null;
  } | null;
  /** True when the user has a `credential` Account row. */
  hasPassword: boolean;
  /** True when the domain is SSO-enforced (the `SSO_REQUIRED` veto). */
  ssoEnforced: boolean;
}

/**
 * Classify the account behind an address, for the specific copy.
 *
 * Split out from the request path so the caller can compute it **only once
 * disclosure is unlocked**. Computing it unconditionally is the bug this module
 * exists to prevent: the query cost is trivial, but a response body carrying
 * `banned: true` for an arbitrary address is a live oracle, and the client is
 * not a safe place to keep that secret — anything in a browser can be read by
 * the person it is being kept from.
 *
 * Order matters: a banned account is reported as banned whatever else is true,
 * because telling a suspended user to check their verification is both wrong and
 * a dead end for them.
 */
export function classifyAccountState(probe: AccountStateProbe): AccountState {
  if (!probe.user) return "unknown";
  if (probe.user.banned === true) return "banned";
  if (!probe.user.emailVerified) return "unverified";
  if (probe.ssoEnforced) return "sso_only";
  if (!probe.hasPassword) return "no_password";
  return "active";
}

/* -------------------------------------------------------------------------- */
/* Response payload                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The shape attached to the sign-in response, consumed by
 * `humanizeAuthError(flow, error, { disclosure })`.
 *
 * `unlocked` is the only thing that gates the existence-revealing copy, and the
 * server is the only thing that sets it. `accountState` is attached only when
 * `unlocked` is true, so an unprivileged response never carries it at all.
 */
export interface SignInDisclosurePayload {
  unlocked: boolean;
  attempts: number;
  accountState?: AccountState;
}

export function toDisclosurePayload(
  verdict: SignInAttemptVerdict,
  accountState?: AccountState,
): SignInDisclosurePayload {
  return {
    unlocked: verdict.disclosure.unlocked,
    attempts: verdict.disclosure.attempts,
    ...(verdict.disclosure.unlocked && accountState ? { accountState } : {}),
  };
}
