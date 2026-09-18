import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

/**
 * #1716 — the three answers a session lookup can give. `getSession` alone
 * collapses the third into the second: the `customSession` plugin's endpoint
 * wraps the core lookup in `.catch(() => null)` (better-auth 1.6.5,
 * `plugins/custom-session/index.mjs:50`), so an adapter failure — a ~27 s
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

/** Thrown by page guards on a failed lookup, so the boundary retries, never signs out. */
export class SessionLookupFailedError extends Error {
  readonly code = "SESSION_LOOKUP_FAILED";
  constructor(readonly cause: unknown) {
    super("Session lookup failed");
    this.name = "SessionLookupFailedError";
  }
}

// Better Auth's default names: the `__Secure-` prefix rides on https origins.
const SESSION_TOKEN_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
];

/** The raw session token from the signed cookie, or null when no cookie rides. */
async function sessionTokenFromCookie(): Promise<string | null> {
  const jar = await cookies();
  for (const name of SESSION_TOKEN_COOKIES) {
    const value = jar.get(name)?.value;
    if (!value) continue;
    // better-call signs as `<token>.<signature>`; the token is what the row is keyed on.
    const dot = value.lastIndexOf(".");
    return dot < 1 ? null : value.substring(0, dot);
  }
  return null;
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
    session = await getSession(disableCookieCache);
  } catch (cause) {
    return { kind: "failed", cause };
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
        cause: new Error(
          "session row is live but the session lookup answered null",
        ),
      };
    }
    return { kind: "none" };
  } catch (cause) {
    return { kind: "failed", cause };
  }
}
