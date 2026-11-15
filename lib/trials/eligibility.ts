import type { TrialStatus } from "@prisma/client";

/**
 * Which existing trial statuses block a fresh trial request.
 *
 * `Trial` is `@@unique([consulteeProfileId, consultantProfileId])`, so
 * exactly one row can exist per learner–consultant pair. Only trials that are
 * live or already delivered block a re-request; never paying is not using a trial. The
 * terminal-without-delivery outcomes below free the pair, and the old row is
 * deleted when the new request is made (the unique constraint leaves no other
 * option).
 *
 * This is deliberately permissive: a learner can hold a time, let it lapse unpaid
 * and ask again. Moving CANCELLED into the blocking set makes a trial one-shot.
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

export function blocksNewTrialRequest(status: TrialStatus): boolean {
  return TRIAL_REQUEST_BLOCKING_STATUSES.includes(status);
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
