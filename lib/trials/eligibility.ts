import type { Prisma, TrialStatus } from "@prisma/client";

/**
 * Trial statuses that hold the (learner, expert) pair and block a new request.
 * `trial_one_blocking_per_pair_key` (prisma/sql/check-constraints.sql) allows one
 * row per pair over this same list; CANCELLED is terminal and frees the pair.
 */
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

/**
 * Paid-trial payment window: 24h from acceptance, clamped to the session start.
 * A slot three hours out must not stay payable past the slot itself.
 */
export const TRIAL_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function computeTrialPaymentDueAt(
  acceptedAt: Date,
  sessionStartsAt: Date | null | undefined,
): Date {
  const window = new Date(acceptedAt.getTime() + TRIAL_PAYMENT_WINDOW_MS);
  if (sessionStartsAt && sessionStartsAt < window) return sessionStartsAt;
  return window;
}
