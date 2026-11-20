/**
 * The `BookingStatusHistory.reason` the expiry sweep writes when a paid plan
 * expires because no session was placed in time. Prisma-free: the status
 * derivation reads it on the client.
 */
export const UNPLACED_PLAN_REASON = "UNALLOCATED_48H";
