/**
 * @jest-environment node
 */

/**
 * The cycle window is half-open: its end is the midnight after the seventh
 * zone-day, so the 23:30 atom of the last day is placeable and the next
 * midnight is not. Labels still name the seventh day.
 */
import {
  firstCycleWindow,
  subscriptionCycleHeading,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";
import type { PrismaLike } from "@/lib/prisma";

const KOLKATA = "Asia/Kolkata";
// Mon 2 Mar 2026, 09:00 IST.
const START = new Date("2026-03-02T03:30:00Z");
const NOW = new Date("2026-03-01T00:00:00Z");

describe("the cycle window end", () => {
  it("is the midnight after the seventh zone-day, exclusive", () => {
    const { end } = firstCycleWindow(
      { sessionsPerWeek: 1, durationInMonths: 1 },
      START,
      KOLKATA,
    );
    // Mon 9 Mar 00:00 IST.
    expect(end.toISOString()).toBe("2026-03-08T18:30:00.000Z");
  });

  it("labels the seventh day, not the exclusive midnight", () => {
    const entitlement = subscriptionEntitlement({
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionsTotal: 4,
      sessionsRefunded: 0,
      occurrences: [],
      schedulingPeriodStartsAt: START,
      schedulingTimezone: KOLKATA,
      planEndsAt: null,
      now: NOW,
    });
    expect(
      subscriptionCycleHeading(entitlement, { zone: KOLKATA, locale: "en-GB" }),
    ).toContain("8 Mar");
    expect(
      subscriptionCycleHeading(entitlement, { zone: KOLKATA, locale: "en-GB" }),
    ).not.toContain("9 Mar");
  });
});

describe("SubscriptionValidationService at the cycle boundary", () => {
  function serviceFor() {
    const prisma = {
      subscription: {
        findUnique: async () => ({
          id: "sub-1",
          schedulingPeriodStartsAt: START,
          schedulingTimezone: KOLKATA,
          planEndsAt: null,
          sessionsTotal: 4,
          sessionsRefunded: 0,
          subscriptionPlan: {
            sessionsPerWeek: 1,
            durationInMonths: 1,
            sessionDurationInHours: 0.5,
            totalSessions: 4,
          },
          appointment: { id: "apt-1", occurrences: [] },
        }),
      },
      appointmentOccurrence: { findMany: async () => [] },
    } as unknown as PrismaLike;
    return new SubscriptionValidationService(prisma);
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it("accepts the 23:30 atom on the cycle's last day", async () => {
    // Sun 8 Mar 23:30 IST.
    const result = await serviceFor().validateSubscriptionSlots("sub-1", [
      "2026-03-08T18:00:00.000Z",
    ]);
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("refuses the atom that starts at the exclusive end", async () => {
    // Mon 9 Mar 00:00 IST.
    const result = await serviceFor().validateSubscriptionSlots("sub-1", [
      "2026-03-08T18:30:00.000Z",
    ]);
    expect(result.isValid).toBe(false);
  });
});
