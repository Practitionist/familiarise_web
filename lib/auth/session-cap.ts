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

/**
 * Rows evicted per enforcement pass. A credential-stuffing victim could
 * hold 100k rows — one pass materializes at most this many ids, so the
 * lambda cannot OOM on the IN list.
 */
const CAP_EVICTION_BATCH = 200;

/**
 * Passes per sign-in. 5 × 200 converges a 1,000-session overflow in the
 * sign-in that triggered enforcement; anything larger keeps converging
 * on later sign-ins (the cap is eventually consistent — see below).
 */
const MAX_CAP_EVICTION_PASSES = 5;

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
  // Bounded passes: one pass deletes at most CAP_EVICTION_BATCH rows, so
  // a stuffing victim's 100k rows cannot OOM the lambda via a giant IN
  // list — and repeating the pass (each its own Serializable transaction)
  // converges a large overflow in the sign-in that triggered enforcement
  // instead of leaving hundreds of sessions behind with no later cap
  // check. Stops early on a short pass; the pass cap bounds total work.
  let evicted = 0;
  for (let pass = 0; pass < MAX_CAP_EVICTION_PASSES; pass++) {
    const { count, full } = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const overflow = await tx.session.findMany({
            where: { userId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: maxSessions,
            take: CAP_EVICTION_BATCH,
            select: { id: true },
          });
          if (overflow.length === 0) return { count: 0, full: false };
          const { count } = await tx.session.deleteMany({
            // Belt-and-suspenders: the `in` list already belongs to this
            // user, but the userId predicate makes a cross-user delete
            // structurally impossible even if the list were ever poisoned.
            where: { id: { in: overflow.map((s) => s.id) }, userId },
          });
          return { count, full: overflow.length === CAP_EVICTION_BATCH };
        },
        { isolationLevel: "Serializable" },
      ),
    );
    evicted += count;
    if (!full) break;
  }
  return { evicted };
}
