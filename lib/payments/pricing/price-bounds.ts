/**
 * Per-format price floors and suggested defaults, in paise. Floors bind 1:1
 * plans and packs when a plan is created or edited; no format has a maximum.
 */

const RUPEE_PAISE = 100;
const BPS = 10_000;

/** 1:1 length buckets: the first bucket whose `maxMinutes` covers the session applies. */
const SESSION_BUCKETS = [
  { maxMinutes: 30, minPaise: 49_900, defaultPaise: 79_900 },
  { maxMinutes: 45, minPaise: 79_900, defaultPaise: 119_900 },
  { maxMinutes: 60, minPaise: 99_900, defaultPaise: 149_900 },
] as const;

/** Past 60 minutes both prices pro-rate these hourly rates by the minute, rounded up to the rupee. */
const LONG_SESSION_HOURLY = {
  minPaise: 99_900,
  defaultPaise: 149_900,
} as const;

/** A pack's per-session price may sit at most this far below the single-session floor. */
export const MAX_PACK_DISCOUNT_BPS = 2_500;

/** Only a weeks plan of at most this many weeks is a pack; longer and month-based plans are unfloored. */
export const PACK_MAX_WEEKS = 4;

/** Whether a subscription plan of this length is a short pack held to the pack floor. */
export function isShortPack(durationInWeeks: number | null): boolean {
  return durationInWeeks !== null && durationInWeeks <= PACK_MAX_WEEKS;
}

/** Suggestions for the listing UI until each format launches; nothing enforces them. */
export const SUGGESTED_DEFAULT_PRICE_PAISE = {
  WEBINAR_SEAT: 14_900,
  CLASS_ENROLMENT: 49_900,
  SUBSCRIPTION_MONTH: 49_900,
  DIGITAL_PRODUCT: 9_900,
  REPLAY: 9_900,
} as const;

/** `numerator / denominator` paise, rounded up to a whole rupee. */
function ceilToRupee(numerator: number, denominator: number): number {
  return Math.ceil(numerator / (denominator * RUPEE_PAISE)) * RUPEE_PAISE;
}

function assertPositiveMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new RangeError(`A session length must be positive, got ${minutes}`);
  }
}

function sessionPrice(
  minutes: number,
  pick: "minPaise" | "defaultPaise",
): number {
  assertPositiveMinutes(minutes);
  const bucket = SESSION_BUCKETS.find((b) => minutes <= b.maxMinutes);
  return bucket
    ? bucket[pick]
    : ceilToRupee(LONG_SESSION_HOURLY[pick] * minutes, 60);
}

/** The lowest price a 1:1 session of this many minutes may be listed at. */
export function minPriceForSession(minutes: number): number {
  return sessionPrice(minutes, "minPaise");
}

/** The suggested listing price for a 1:1 session of this many minutes. */
export function defaultPriceForSession(minutes: number): number {
  return sessionPrice(minutes, "defaultPaise");
}

/** The lowest total price for a pack: the single-session floor less the largest pack discount, per session. */
export function minPriceForPack(
  sessionMinutes: number,
  totalSessions: number,
): number {
  if (!Number.isSafeInteger(totalSessions) || totalSessions <= 0) {
    throw new RangeError(
      `A pack must hold a positive whole number of sessions, got ${totalSessions}`,
    );
  }
  return ceilToRupee(
    minPriceForSession(sessionMinutes) *
      totalSessions *
      (BPS - MAX_PACK_DISCOUNT_BPS),
    BPS,
  );
}

/** A plan saved below its price floor; the message is shown to the expert as written. */
export class PlanPriceBelowFloorError extends Error {
  readonly code = "PLAN_PRICE_BELOW_FLOOR" as const;
  readonly httpStatus = 400;

  constructor(
    readonly minPaise: number,
    message: string,
  ) {
    super(message);
    this.name = "PlanPriceBelowFloorError";
  }
}

export type PlanPriceInput =
  | { kind: "SESSION"; pricePaise: number; durationInHours: number }
  | {
      kind: "PACK";
      pricePaise: number;
      sessionDurationInHours: number;
      totalSessions: number;
    };

const rupees = (paise: number) =>
  `₹${(paise / RUPEE_PAISE).toLocaleString("en-IN")}`;

/** Throws `PlanPriceBelowFloorError` when a 1:1 plan or pack is priced under its floor. */
export function assertPlanPriceWithinBounds(plan: PlanPriceInput): void {
  if (plan.kind === "SESSION") {
    const minutes = Math.round(plan.durationInHours * 60);
    const minPaise = minPriceForSession(minutes);
    if (plan.pricePaise < minPaise) {
      throw new PlanPriceBelowFloorError(
        minPaise,
        `A ${minutes}-minute session must be priced at ${rupees(minPaise)} or more.`,
      );
    }
    return;
  }
  const minutes = Math.round(plan.sessionDurationInHours * 60);
  const minPaise = minPriceForPack(minutes, plan.totalSessions);
  if (plan.pricePaise < minPaise) {
    throw new PlanPriceBelowFloorError(
      minPaise,
      `A plan of ${plan.totalSessions} ${minutes}-minute sessions must be priced at ${rupees(minPaise)} or more.`,
    );
  }
}
