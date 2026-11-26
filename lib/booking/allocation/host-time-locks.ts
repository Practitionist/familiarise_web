// Postgres arbitrates an expert's time: every writer that makes it busy takes
// transaction-scoped advisory try-locks on the same (profile, half-hour) atoms
// the Redis slot batch names, before anything else in its write transaction.

import type { Tx } from "@/lib/prisma";
import {
  parseSlotKey,
  slotBatchKeys,
  type SlotBatchEntry,
} from "@/utils/appointmentlock";

/** A half-hour of one profile's calendar that another open transaction is writing. */
export interface HeldHostTime {
  consultantProfileId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * One `pg_try_advisory_xact_lock` per atom of `entries`, walked in the slot
 * batch's sorted key order and stopped at the first atom another transaction
 * holds, so of two overlapping writers one always gets through. Never waits: a
 * held atom throws `refusal(held)`, the door's own slot-taken answer. The locks
 * end with the transaction, so the conflict re-check the writer runs next reads
 * what every earlier writer of these atoms committed.
 */
export async function lockHostTimeInTx(
  tx: Pick<Tx, "$queryRaw">,
  entries: readonly SlotBatchEntry[],
  refusal: (held: HeldHostTime) => Error,
): Promise<void> {
  if (entries.length === 0) return;
  const keys = slotBatchKeys(entries);
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
  const held = parseSlotKey(keys[Number(first.i) - 1] ?? "");
  throw refusal(
    held ?? {
      consultantProfileId: entries[0].consultantProfileId,
      startsAt: new Date(entries[0].startsAt),
      endsAt: new Date(entries[0].endsAt),
    },
  );
}
