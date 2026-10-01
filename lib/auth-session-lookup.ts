import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { markExpected } from "@/lib/observability/expected";

/**
 * #1716 — the three answers a session lookup can give. `getSession` alone
 * collapses the third into the second: the `customSession` plugin's endpoint
 * wraps the core lookup in `.catch(() => null)` (better-auth 1.7.6,
 * `plugins/custom-session/index.mjs`), so an adapter failure — a ~27 s
 * cold-instance stall on a VALID cookie — came back as "no session" and the
 * caller answered 401 to a signed-in user.
 *
 * Its own module so the many suites that mock `lib/auth-server` to a bare
 * `getSession` keep driving it.
 */
export type ResolvedSession = NonNullable<
  Awaited<ReturnType<typeof getSession>>
>;

export type SessionLookup =
  | { kind: "found"; session: ResolvedSession }
  | { kind: "none" }
  | { kind: "failed"; cause: unknown };

/**
 * Thrown by page guards on a failed lookup, so the boundary retries, never signs out.
 *
 * ## Why the constructor marks the error
 *
 * The code is `SESSION_LOOKUP_FAILED`, the catalog maps it to `UNREACHABLE`,
 * and a lookup that threw is an *answer we modelled* — the boundary retries and
 * the customer keeps their session. Paging on it would report correct
 * behaviour as a fault, indistinguishable from a real defect in a log.
 *
 * Marking in the constructor rather than at each throw site is deliberate. There
 * is one throw site in `lib/auth-guard.ts` today and no reason to believe a
 * second will be written more carefully; a marker that has to be remembered at
 * every construction is a marker that is eventually forgotten, and the failure it
 * leaves behind is invisible rather than loud.
 *
 * The one other construction (`lib/auth-guard.ts:73`, "stale-session cleanup did
 * not redirect") is an internal invariant, not a lookup failure — but it is
 * unreachable by construction, since `redirect()` throws rather than returning, so
 * the class-level marker costs nothing real there. A future caller that needs a
 * genuine fault to page should throw its own error type, not this one: an error
 * carrying a typed refusal code is a refusal by this repo's Rule 3, and the code
 * is what says so.
 */
export class SessionLookupFailedError extends Error {
  readonly code = "SESSION_LOOKUP_FAILED";
  constructor(readonly cause: unknown) {
    super("Session lookup failed");
    this.name = "SessionLookupFailedError";
    markExpected(this);
  }
}

/**
 * Mark a lookup `cause` on the way out, when it is something a marker can ride on.
 *
 * The wrapper above is what escapes a page render, but `lib/auth-helpers.ts`
 * captures the *cause* directly (`reportSentryError(lookup.cause, …)` on the
 * `requireApiAuth` path), and a consumer is free to rethrow the cause instead of
 * the wrapper. Marking here means the marker is attached exactly once, at the
 * point where the tri-state decided this is a `failed` rather than a `none`.
 *
 * Non-`Error` throws are left alone: `markExpected` has nothing object-shaped to
 * stamp, and `reportSentryError` would build a fresh `Error` from them anyway
 * (see `lib/observability/expected.ts` for why that loses the marker).
 */
function markLookupCause(cause: unknown): unknown {
  return cause instanceof Error ? markExpected(cause) : cause;
}

// Better Auth's default names: the `__Secure-` prefix rides on https origins.
const SESSION_TOKEN_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
];

/**
 * The session token from a correctly signed cookie, else null. better-call
 * signs as `<token>.<base64 HMAC-SHA256(token, secret)>`, URL-encoded.
 */
async function sessionTokenFromCookie(): Promise<string | null> {
  const jar = await cookies();
  const secret = process.env.BETTER_AUTH_SECRET;
  for (const name of SESSION_TOKEN_COOKIES) {
    const raw = jar.get(name)?.value;
    if (!raw) continue;
    if (!secret) return null;
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const token = value.substring(0, dot);
    const given = Buffer.from(value.substring(dot + 1), "base64");
    const expected = createHmac("sha256", secret).update(token).digest();
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? token
      : null;
  }
  return null;
}

/**
 * Next's control-flow throws (DYNAMIC_SERVER_USAGE while prerendering,
 * NEXT_REDIRECT, NEXT_NOT_FOUND, BAILOUT_TO_CLIENT_SIDE_RENDERING) carry a
 * string `digest` and must reach the framework; a database fault carries none.
 */
function isNextControlFlowError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string"
  );
}

/**
 * `getSession` with the failure made visible. A thrown lookup is a failure;
 * a null WITH a session cookie is ambiguous, so one indexed read of the row
 * settles it: a live row means the lookup did not complete (fail), no row
 * means the session is gone (none). The extra read runs only on the null
 * path, which is rare for a signed-in caller.
 */
export async function lookupSession(
  disableCookieCache = false,
): Promise<SessionLookup> {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    // Opted in: the page guards and requireApiAuth answer an unenrolled
    // operator with the setup redirect or a 428, and a null here would read
    // as a failed lookup (the row is live) and answer 503.
    session = await getSession(disableCookieCache, {
      allowUnenrolledOperator: true,
    });
  } catch (cause) {
    if (isNextControlFlowError(cause)) throw cause;
    return { kind: "failed", cause: markLookupCause(cause) };
  }
  if (session?.user?.id) return { kind: "found", session };

  let token: string | null;
  try {
    token = await sessionTokenFromCookie();
  } catch {
    // Outside a request scope (a job, a bare test) there is no jar to consult.
    return { kind: "none" };
  }
  if (!token) return { kind: "none" };
  try {
    const row = await prisma.session.findUnique({
      where: { token },
      select: { expiresAt: true },
    });
    if (row && row.expiresAt > new Date()) {
      return {
        kind: "failed",
        cause: markLookupCause(
          new Error("session row is live but the session lookup answered null"),
        ),
      };
    }
    return { kind: "none" };
  } catch (cause) {
    return { kind: "failed", cause: markLookupCause(cause) };
  }
}
