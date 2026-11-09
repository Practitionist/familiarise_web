import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

/** One replay after a deadlock: the victim rolled back, and one more attempt fits inside the caller's locks. */
const BOOKING_TX_DEADLOCK_RETRIES = 1;

/**
 * A Read Committed booking transaction (allocation, reschedule, cancel) that
 * is replayed once when Postgres picks it as a deadlock victim (40P01), so a
 * transient lock cycle answers like a normal attempt instead of a 500. The
 * callback must keep its state inside the transaction; it may run twice.
 */
export function bookingTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return withSerializableRetry(
    () => prisma.$transaction(fn, options),
    BOOKING_TX_DEADLOCK_RETRIES,
  );
}
