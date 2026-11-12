import { NextResponse } from "next/server";

import {
  assertPlanPriceWithinBounds,
  isShortPack,
  PlanPriceBelowFloorError,
} from "@/lib/payments/pricing/price-bounds";

/** A plan's price or length terms changed between an edit's read and its write. */
export class StalePlanEditError extends Error {
  readonly code = "PLAN_CHANGED" as const;
  readonly httpStatus = 409;

  constructor() {
    super("This plan was changed by someone else; reload and try again.");
    this.name = "StalePlanEditError";
  }
}

/**
 * The terms an edit would save: an undefined field keeps its stored value, and
 * `changed` is true only when a saved value differs from the stored one.
 */
export function editedTerms<T extends Record<string, unknown>>(
  stored: T,
  edited: { [K in keyof T]?: T[K] },
): { terms: T; changed: boolean } {
  const terms = { ...stored };
  let changed = false;
  for (const key of Object.keys(stored) as (keyof T)[]) {
    const value = edited[key];
    if (value === undefined) continue;
    terms[key] = value;
    changed ||= value !== stored[key];
  }
  return { terms, changed };
}

/** Throws `StalePlanEditError` when the compare-and-set on the read terms matched no row. */
export async function claimPlanTerms(
  claim: Promise<{ count: number }>,
): Promise<void> {
  if ((await claim).count === 0) throw new StalePlanEditError();
}

/** Holds a subscription plan to the pack floor only when it is a short pack. */
export function assertSubscriptionPlanFloor(plan: {
  pricePaise: number;
  sessionDurationInHours: number;
  totalSessions: number;
  durationInWeeks: number | null;
}): void {
  if (!isShortPack(plan.durationInWeeks)) return;
  assertPlanPriceWithinBounds({
    kind: "PACK",
    pricePaise: plan.pricePaise,
    sessionDurationInHours: plan.sessionDurationInHours,
    totalSessions: plan.totalSessions,
  });
}

/** The typed answer for a below-floor or stale plan save; null for any other error. */
export function planEditRefusal(error: unknown): NextResponse | null {
  if (
    error instanceof PlanPriceBelowFloorError ||
    error instanceof StalePlanEditError
  ) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  return null;
}
