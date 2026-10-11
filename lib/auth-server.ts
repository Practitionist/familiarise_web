import { cache } from "react";
import { cookies, headers } from "next/headers";
import { auth } from "@/lib/auth";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import {
  classifyMissingSession,
  verifiedSessionToken,
} from "@/lib/auth/session-cookie";
import {
  isNextControlFlowError,
  SessionLookupFailedError,
} from "@/lib/auth/session-lookup-error";

type ResolvedRead = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

/**
 * One session read, made tri-state. The customSession plugin wraps the core
 * lookup in `.catch(() => null)`, so a null with a validly signed cookie is
 * settled by one row read: a live row means the lookup failed, not that the
 * session is gone. Any failure throws `SessionLookupFailedError`.
 */
async function resolveSession(): Promise<ResolvedRead | null> {
  const requestHeaders = await headers();
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: requestHeaders });
  } catch (cause) {
    if (isNextControlFlowError(cause)) throw cause;
    throw new SessionLookupFailedError(cause);
  }
  if (session?.user?.id) return session;

  let token: string | null;
  try {
    const jar = await cookies();
    token = verifiedSessionToken((name) => jar.get(name)?.value);
  } catch {
    // Outside a request scope (a job, a bare test) there is no jar to consult.
    return null;
  }
  if (token && (await classifyMissingSession(token)) === "failed") {
    throw new SessionLookupFailedError(
      new Error("session row is live but the session lookup answered null"),
    );
  }
  return null;
}

/**
 * Render-memoized: nested layouts whose guards run in the same RSC render
 * share one read, and a rejected read is re-thrown to every later guard.
 * `cache` exists only in the React build Next aliases into the RSC layer, so
 * one-shot processes fall back to the plain reader. Built on first call so
 * importing never touches `cache`.
 */
let memoizedResolve: typeof resolveSession | undefined;

function sessionResolver(): typeof resolveSession {
  memoizedResolve ??=
    typeof cache === "function" ? cache(resolveSession) : resolveSession;
  return memoizedResolve;
}

/**
 * The caller's session, or null when there is none. Throws
 * `SessionLookupFailedError` (a 503 refusal) when the lookup itself failed,
 * so an outage never reads as signed out.
 *
 * A STAFF/ADMIN session without an enrolled second factor reads as null
 * unless `allowUnenrolledOperator` is set: only `lookupSession`, behind the
 * page guards and `requireApiAuth`, opts in to answer with the 2FA setup
 * redirect or a 428.
 */
export async function getSession({ allowUnenrolledOperator = false } = {}) {
  const session = await sessionResolver()();
  if (allowUnenrolledOperator || !session) return session;
  const unenrolled =
    isOperatorRole(session.user.role) && session.user.twoFactorEnabled !== true;
  return unenrolled ? null : session;
}
