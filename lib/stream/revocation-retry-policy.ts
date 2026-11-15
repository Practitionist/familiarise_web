import type { Prisma, StreamRevocationKind } from "@prisma/client";

/** Attempts on the normal backoff; a capped kind gives up here. */
export const REVOCATION_ATTEMPT_CAP = 6;

/** Giving up on these leaves someone access they lost, so past the cap they retry daily instead. */
export const UNCAPPED_REVOCATION_KINDS = [
  "SEAT_ACCESS_REVOKE",
  "REFUND_ACCESS_REVOKE",
  "ERASURE_REVOKE",
] as const satisfies readonly StreamRevocationKind[];

export const PAST_CAP_RETRY_MS = 24 * 60 * 60_000;

export function isUncappedRevocationKind(kind: StreamRevocationKind): boolean {
  return (UNCAPPED_REVOCATION_KINDS as readonly string[]).includes(kind);
}

/** Owed revocations still retrying past the cap: someone keeps access the database already took away. */
export const PAST_CAP_REVOCATION_WHERE = {
  status: { in: ["PENDING", "FAILED"] },
  kind: { in: [...UNCAPPED_REVOCATION_KINDS] },
  attempts: { gte: REVOCATION_ATTEMPT_CAP },
} satisfies Prisma.StreamRevocationRetryWhereInput;
