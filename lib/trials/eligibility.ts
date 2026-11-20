import type { Prisma, TrialStatus } from "@prisma/client";

/** Statuses that hold the (learner, expert) pair; CANCELLED, which is terminal, frees it.
 *  `trial_one_blocking_per_pair_key` in prisma/sql/check-constraints.sql indexes this same list. */
export const TRIAL_REQUEST_BLOCKING_STATUSES: TrialStatus[] = [
  "AWAITING_PAYMENT", // a paid trial holding its time, pay window open
  "SCHEDULED", // confirmed, upcoming
  "COMPLETED", // trial actually delivered — this is the real one-per-pair rule
  "CONVERTED", // delivered and subscribed
];

/** Terminal outcomes where the learner never received a trial. */
export const TRIAL_REQUEST_FREEING_STATUSES: TrialStatus[] = [
  "CANCELLED", // cancelled by either party, or lapsed unpaid
];

/** The partial unique index that allows one blocking trial per pair. */
export const TRIAL_PAIR_BLOCKING_INDEX = "trial_one_blocking_per_pair_key";

/** The pair's trial that blocks a new request; the index allows at most one. */
export function blockingTrialWhere(pair: {
  consulteeProfileId: string;
  consultantProfileId: string;
}): Prisma.TrialWhereInput {
  return { ...pair, status: { in: TRIAL_REQUEST_BLOCKING_STATUSES } };
}
