import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

/** One replay after a deadlock: the victim rolled back, and one more attempt fits inside the caller's locks. */
const BOOKING_TX_DEADLOCK_RETRIES = 1;

/**
 * A Read Committed booking transaction (allocation, reschedule, cancel) that
 * is replayed once when Postgres picks it as a deadlock victim (40P01), so a
 * transient lock cycle answers like a normal attempt instead of a 500. The
 * callback must keep its state inside the transaction; it may run twice.
 *
 * `beforeAttempt` runs ahead of every attempt, outside the transaction: a
 * caller renews its locks there, so a replay never writes under a lapsed grant.
 */
export function bookingTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: {
    maxWait?: number;
    timeout?: number;
    beforeAttempt?: () => Promise<void>;
  } = {},
): Promise<T> {
  const { beforeAttempt, ...txOptions } = options;
  return withSerializableRetry(async () => {
    await beforeAttempt?.();
    return prisma.$transaction(fn, txOptions);
  }, BOOKING_TX_DEADLOCK_RETRIES);
}
