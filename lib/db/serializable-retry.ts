import { Prisma } from "@prisma/client";

import { isDeadlock } from "@/lib/db/pg-errors";

const SERIALIZABLE_MAX_RETRIES = 3;

/**
 * Retries a function that may fail because Postgres rolled its transaction
 * back, with jittered exponential backoff. Postgres reports that outcome under
 * two SQLSTATEs, and both of them are transient here:
 *
 * - 40001 `serialization_failure` — the SSI abort. The driver adapter maps it
 *   to `TransactionWriteConflict`, so Prisma hands it to us already classified
 *   as P2034 and the `instanceof`/`code` check below is the whole test.
 * - 40P01 `deadlock_detected` — a row-lock deadlock, the same class of failure
 *   from the caller's point of view: the victim transaction is aborted, so
 *   replaying it is safe. It gets its own predicate because the adapter
 *   version pinned here has no 40P01 case and rethrows it unmapped, so it never
 *   becomes a P2034 and would otherwise surface as an unmapped 500. PostgreSQL's
 *   own guidance on handling serialization failures says the same thing in
 *   advisory form: it is advisable to retry deadlock failures, which carry
 *   SQLSTATE 40P01.
 *
 * Only these are transient. Anything else (IllegalTransitionError,
 * VERSION_CONFLICT 409s, validation errors) propagates immediately on the first
 * attempt so business rejections are never retried into accidental success.
 */
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = SERIALIZABLE_MAX_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isSerializationFailure =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034";

      if (
        (!isSerializationFailure && !isDeadlock(error)) ||
        attempt === maxRetries
      ) {
        throw error;
      }

      // 50/100/200ms + jitter so two retrying writers don't re-collide in step.
      const backoffMs = 50 * 2 ** attempt + Math.random() * 25;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("withSerializableRetry: exhausted retries");
}
