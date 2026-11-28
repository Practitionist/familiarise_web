// Postgres arbitrates an expert's time: every writer that makes it busy takes
// transaction-scoped advisory try-locks on the same (profile, half-hour) atoms
// the Redis slot batch names, before anything else in its write transaction.
// A 1:1 writer takes the learner's own (user, half-hour) atoms with them.

import type { Tx } from "@/lib/prisma";
import {
  byCodeUnit,
  learnerTimeKeys,
  parseLearnerTimeKey,
  parseSlotKey,
  slotBatchKeys,
  type LearnerTimeEntry,
  type SlotBatchEntry,
} from "@/utils/appointmentlock";

/**
 * A half-hour another open transaction is writing: on an expert's calendar
 * (`consultantProfileId`), or a learner's own time in a 1:1 (`learnerUserId`).
 */
export interface HeldHostTime {
  consultantProfileId: string | null;
  learnerUserId: string | null;
  startsAt: Date;
  endsAt: Date;
}

function heldTimeOf(key: string): HeldHostTime | null {
  const slot = parseSlotKey(key);
  if (slot) return { ...slot, learnerUserId: null };
  const learner = parseLearnerTimeKey(key);
  return learner
    ? {
        consultantProfileId: null,
        learnerUserId: learner.userId,
        startsAt: learner.startsAt,
        endsAt: learner.endsAt,
      }
    : null;
}

/**
 * One `pg_try_advisory_xact_lock` per atom of `entries` and `learnerTimes`,
 * walked in one sorted key order and stopped at the first atom another
 * transaction holds, so of two overlapping writers one always gets through.
 * Never waits: a held atom throws `refusal(held)`, the door's own slot-taken
 * answer. The locks end with the transaction, so a Read Committed writer's
 * re-check reads what every earlier writer of these atoms committed; a
 * Serializable writer's snapshot is fixed as this statement starts, so its
 * re-check can miss a commit that lands inside the statement.
 * Only a 1:1 writer passes `learnerTimes`: group seats may clash by design.
 */
export async function lockHostTimeInTx(
  tx: Pick<Tx, "$queryRaw">,
  entries: readonly SlotBatchEntry[],
  refusal: (held: HeldHostTime) => Error,
  learnerTimes: readonly LearnerTimeEntry[] = [],
): Promise<void> {
  const keys = [
    ...(entries.length > 0 ? slotBatchKeys(entries) : []),
    ...learnerTimeKeys(learnerTimes),
  ].sort(byCodeUnit);
  if (keys.length === 0) return;
  const refused = await tx.$queryRaw<Array<{ i: number }>>`
    WITH RECURSIVE atoms AS (SELECT ${keys}::text[] AS keys),
    walk(i, locked) AS (
      SELECT 1, pg_try_advisory_xact_lock(hashtextextended(atoms.keys[1], 42))
      FROM atoms
      UNION ALL
      SELECT walk.i + 1,
             pg_try_advisory_xact_lock(hashtextextended(atoms.keys[walk.i + 1], 42))
      FROM walk, atoms
      WHERE walk.locked AND walk.i < cardinality(atoms.keys)
    )
    SELECT i FROM walk WHERE NOT locked`;
  const [first] = refused;
  if (!first) return;
  const [fallback] = entries;
  throw refusal(
    heldTimeOf(keys[Number(first.i) - 1] ?? "") ?? {
      consultantProfileId: fallback?.consultantProfileId ?? null,
      learnerUserId: null,
      startsAt: new Date(fallback?.startsAt ?? Number.NaN),
      endsAt: new Date(fallback?.endsAt ?? Number.NaN),
    },
  );
}
