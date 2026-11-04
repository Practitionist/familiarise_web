/**
 * The card's entitlement facts for an ended plan: a placed session still
 * awaiting its outcome is not "not held", only what was never placed.
 */
import { entitlementSummary } from "@/lib/appointments/presentation-input";
import { subscriptionEntitlement } from "@/lib/booking/entitlement";

const DAY = 24 * 3_600_000;
const START = new Date("2026-01-05T00:00:00.000Z");
const NOW = new Date("2026-03-01T12:00:00.000Z");

const session = (day: number, completionStatus: string) => ({
  startsAt: new Date(START.getTime() + day * DAY),
  endsAt: new Date(START.getTime() + day * DAY + 3_600_000),
  completionStatus,
  isTentative: false,
  deletedAt: null,
});

it("counts only never-placed sessions as not held once the plan ended", () => {
  const e = subscriptionEntitlement({
    sessionsTotal: 4,
    sessionsPerWeek: 1,
    durationInMonths: 1,
    occurrences: [session(1, "COMPLETED"), session(8, "SCHEDULED")],
    schedulingPeriodStartsAt: START,
    schedulingTimezone: "UTC",
    planEndsAt: new Date(START.getTime() + 28 * DAY),
    now: NOW,
  });
  expect(entitlementSummary(e, NOW)).toMatchObject({
    notHeld: 2,
    planEnded: true,
  });
});
