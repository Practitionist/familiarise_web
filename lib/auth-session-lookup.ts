import { getSession } from "@/lib/auth-server";
import { markExpected } from "@/lib/observability/expected";
import {
  isNextControlFlowError,
  SessionLookupFailedError,
} from "@/lib/auth/session-lookup-error";

/**
 * `getSession` as a value instead of a throw: the guards (`requireApiAuth`,
 * `requireApiSession`, the page guards in lib/auth-guard.ts) branch on it.
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

/** Marked here so a caller that reports the cause directly never pages. */
function markLookupCause(cause: unknown): unknown {
  return cause instanceof Error ? markExpected(cause) : cause;
}

/** Includes an unenrolled operator's session; the guards answer it themselves. */
export async function lookupSession(): Promise<SessionLookup> {
  try {
    const session = await getSession({ allowUnenrolledOperator: true });
    return session?.user?.id ? { kind: "found", session } : { kind: "none" };
  } catch (cause) {
    if (cause instanceof SessionLookupFailedError) {
      return { kind: "failed", cause: markLookupCause(cause.cause) };
    }
    if (isNextControlFlowError(cause)) throw cause;
    return { kind: "failed", cause: markLookupCause(cause) };
  }
}
