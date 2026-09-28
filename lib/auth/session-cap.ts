import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

/**
 * Maximum concurrent auth sessions per user (#1856).
 *
 * Generous on purpose: phone + laptop + tablet + a shared family device
 * is normal on a mentoring marketplace. The cap is a hygiene bound on the
 * `sessions` table and a backstop against credential-stuffing session
 * minting — it is NOT a security gate (brute-force is `authLimiter`'s
 * job in middleware). Raising it is a product decision, lowering it
 * below ~5 will annoy real users.
 */
export const MAX_CONCURRENT_SESSIONS = 10;

export interface SessionCapResult {
  /** Sessions deleted to bring the user back under the cap. */
  evicted: number;
}

/**
 * Evict the user's oldest sessions beyond `maxSessions`, keeping the
 * newest. Called from `databaseHooks.session.create.after`, where the
 * just-created session is already committed — and being the newest, is
 * always kept.
 *
 * Concurrency: two simultaneous sign-ins both run this. The composite
 * `orderBy` is a TOTAL order — `createdAt` alone has millisecond
 * resolution and two sign-ins in the same millisecond tie, which would
 * let the loser's delete remove the winner's session. The Serializable
 * transaction (via the shared `withSerializableRetry`, P2034 only)
 * serializes the two writers so the cap holds exactly.
 *
 * Shape of the result: `deleteMany` with an `in` list (never `delete`,
 * never `skip` on the delete itself) so a concurrent second enforcement
 * is a 0-count delete, not a throw.
 */
export async function enforceSessionCapForUser(
  userId: string,
  maxSessions: number = MAX_CONCURRENT_SESSIONS,
): Promise<SessionCapResult> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Bounded pass: a credential-stuffing victim could hold 100k
        // rows, and materializing all of them (plus a 100k-entry IN)
        // would OOM the lambda. One bounded pass per sign-in converges
        // because the cap is documented eventually-consistent.
        const overflow = await tx.session.findMany({
          where: { userId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: maxSessions,
          take: 200,
          select: { id: true },
        });
        if (overflow.length === 0) return { evicted: 0 };
        const { count } = await tx.session.deleteMany({
          // Belt-and-suspenders: the `in` list already belongs to this
          // user, but the userId predicate makes a cross-user delete
          // structurally impossible even if the list were ever poisoned.
          where: { id: { in: overflow.map((s) => s.id) }, userId },
        });
        return { evicted: count };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}
