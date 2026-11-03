import { isAPIError } from "better-auth/api";
import { cookies, headers } from "next/headers";
import { auth } from "@/lib/auth";
import { renderMemo } from "@/lib/render-memo";
import { needsOperatorTwoFactor } from "@/lib/auth/qa-accounts";
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
 * One session read, made tri-state. A 401 means the refresh hook ended the
 * session; any other throw, or a null while the cookie's row is still live,
 * is a failed lookup and throws `SessionLookupFailedError`.
 */
async function resolveSession(): Promise<ResolvedRead | null> {
  const requestHeaders = await headers();
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: requestHeaders });
  } catch (cause) {
    if (isNextControlFlowError(cause)) throw cause;
    if (isAPIError(cause) && cause.statusCode === 401) return null;
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
 */
const memoizedResolve = renderMemo(resolveSession);

/**
 * The caller's session, or null when there is none. Throws
 * `SessionLookupFailedError` (a 503 refusal) when the lookup itself failed,
 * so an outage never reads as signed out.
 *
 * A STAFF/ADMIN session without an enrolled second factor (QA operators off
 * production aside) reads as null unless `allowUnenrolledOperator` is set:
 * only `lookupSession`, behind the page guards and `requireApiAuth`, opts in
 * to answer with the 2FA setup redirect or a 428.
 */
export async function getSession({ allowUnenrolledOperator = false } = {}) {
  const session = await memoizedResolve();
  if (allowUnenrolledOperator || !session) return session;
  return needsOperatorTwoFactor(session.user) ? null : session;
}
