/**
 * SubscriptionValidationService: the current cycle's half-open window, the
 * rolling cycle cap (`nextBatch`, the only weekly counter), the frozen plan
 * total, and whole-call counting across midnight.
 */

import "./setup";

import { SubscriptionValidationService } from "@/utils/subscriptionValidation";
import {
  makeSubscription,
  makeSubscriptionPlan,
  makeMockPrisma,
  makeConsecutiveSlotISOs,
} from "../fixtures/booking.mockData";

function createService(
  subscriptionOverrides: Record<string, unknown> = {},
  existingAppointments: unknown[] = [],
) {
  const subscription = makeSubscription({
    schedulingTimezone: "UTC",
    ...subscriptionOverrides,
  });
  const mockPrisma = makeMockPrisma(subscription, existingAppointments);
  return new SubscriptionValidationService(mockPrisma);
}

// The window is max(stored start, last held session, now) to the end of the
// seventh day, so the clock sits before the Mon 6 Jan 2025 fixture start.
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the cycle window", () => {
  it("reports the half-open window: Mon 6 Jan to the midnight after Sun 12 Jan", async () => {
    const result = await createService().validateSubscriptionSlots("sub-1", []);
    expect(result.subscriptionPeriod.start.toISOString()).toBe(
      "2025-01-06T00:00:00.000Z",
    );
    expect(result.subscriptionPeriod.end.toISOString()).toBe(
      "2025-01-13T00:00:00.000Z",
    );
  });

  it("accepts a call ending exactly at the window end", async () => {
    const result = await createService().validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-12T23:00:00.000Z", 2),
    );
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("refuses a slot before the window or past its end", async () => {
    const service = createService();
    const before = await service.validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-05T10:00:00.000Z", 2),
    );
    const after = await service.validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-13T00:00:00.000Z", 2),
    );
    expect(before.isValid).toBe(false);
    expect(after.isValid).toBe(false);
    expect(after.errors[0]).toContain("[OUTSIDE_PLAN_WEEK]");
  });

  it("stops at the plan end", async () => {
    const result = await createService({
      planEndsAt: new Date("2025-01-09T00:00:00.000Z"),
    }).validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-10T10:00:00.000Z", 2),
    );
    expect(result.subscriptionPeriod.end.toISOString()).toBe(
      "2025-01-09T00:00:00.000Z",
    );
    expect(result.isValid).toBe(false);
  });
});

describe("the rolling cycle cap", () => {
  it("allows up to sessionsPerWeek calls in a cycle, even across a Sunday", async () => {
    // Sat 11 + Sun 12 Jan sit in two calendar weeks but one cycle.
    const result = await createService().validateSubscriptionSlots("sub-1", [
      ...makeConsecutiveSlotISOs("2025-01-11T10:00:00.000Z", 2),
      ...makeConsecutiveSlotISOs("2025-01-12T10:00:00.000Z", 2),
    ]);
    expect(result.cycleCalls).toBe(2);
    expect(result.cycleCap).toBe(2);
    expect(result.isValid).toBe(true);
  });

  it("refuses more calls than the cycle has room for", async () => {
    const result = await createService().validateSubscriptionSlots("sub-1", [
      ...makeConsecutiveSlotISOs("2025-01-07T10:00:00.000Z", 2),
      ...makeConsecutiveSlotISOs("2025-01-08T10:00:00.000Z", 2),
      ...makeConsecutiveSlotISOs("2025-01-09T10:00:00.000Z", 2),
    ]);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      "[PLAN_WEEK_FULL] This plan week has room for 2 more sessions, but 3 were picked.",
    );
  });

  it("counts a session already held in the cycle against it", async () => {
    const held = {
      id: "apt-1",
      occurrences: [
        {
          id: "occ-held",
          startsAt: new Date("2025-01-07T10:00:00.000Z"),
          endsAt: new Date("2025-01-07T11:00:00.000Z"),
          completionStatus: "SCHEDULED",
          isTentative: false,
          deletedAt: null,
        },
      ],
    };
    const service = createService({ appointment: held }, [held]);
    const result = await service.validateSubscriptionSlots("sub-1", [
      ...makeConsecutiveSlotISOs("2025-01-08T10:00:00.000Z", 2),
      ...makeConsecutiveSlotISOs("2025-01-09T10:00:00.000Z", 2),
    ]);
    expect(result.cycleCap).toBe(1);
    expect(result.isValid).toBe(false);
  });

  it("frees the cycle place of a row being replaced", async () => {
    const held = {
      id: "apt-1",
      occurrences: [
        {
          id: "occ-held",
          startsAt: new Date("2025-01-07T10:00:00.000Z"),
          endsAt: new Date("2025-01-07T11:00:00.000Z"),
          completionStatus: "SCHEDULED",
          isTentative: false,
          deletedAt: null,
        },
      ],
    };
    const service = createService({ appointment: held }, [held]);
    const result = await service.validateSubscriptionSlots(
      "sub-1",
      [
        ...makeConsecutiveSlotISOs("2025-01-08T10:00:00.000Z", 2),
        ...makeConsecutiveSlotISOs("2025-01-09T10:00:00.000Z", 2),
      ],
      [],
      ["occ-held"],
    );
    expect(result.cycleCap).toBe(2);
  });
});

describe("an open reschedule keeps the allocator's cycle anchor", () => {
  const occurrence = (
    id: string,
    day: number,
    status: "SCHEDULED" | "RESCHEDULED",
  ) => ({
    id,
    startsAt: new Date(Date.UTC(2025, 0, day, 10)),
    endsAt: new Date(Date.UTC(2025, 0, day, 11)),
    completionStatus: status,
    // A released row is a tentative hold awaiting its replacement.
    isTentative: status === "RESCHEDULED",
    deletedAt: null,
  });
  const serviceWith = (
    occurrences: ReturnType<typeof occurrence>[],
    overrides: Record<string, unknown> = {},
  ) => {
    const appointment = { id: "apt-1", occurrences };
    return createService({ appointment, ...overrides }, [appointment]);
  };

  it("accepts Jan 8 for a released Jan 7 while Jan 9 stays booked", async () => {
    const result = await serviceWith([
      occurrence("occ-7", 7, "RESCHEDULED"),
      occurrence("occ-9", 9, "SCHEDULED"),
    ]).validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-08T10:00:00.000Z", 2),
      [],
      // The validate route excludes the subscription's tentative rows.
      ["occ-7"],
    );
    expect(result.errors).toEqual([]);
    expect(result.subscriptionPeriod.start.toISOString()).toBe(
      "2025-01-06T00:00:00.000Z",
    );
    expect(result.cycleCap).toBe(1);
  });

  it("anchors the same way with several released sessions", async () => {
    const result = await serviceWith(
      [
        occurrence("occ-7", 7, "RESCHEDULED"),
        occurrence("occ-8", 8, "RESCHEDULED"),
        occurrence("occ-10", 10, "SCHEDULED"),
      ],
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 3,
          totalSessions: 12,
        }),
      },
    ).validateSubscriptionSlots(
      "sub-1",
      [
        ...makeConsecutiveSlotISOs("2025-01-08T14:00:00.000Z", 2),
        ...makeConsecutiveSlotISOs("2025-01-09T10:00:00.000Z", 2),
      ],
      [],
      ["occ-7", "occ-8"],
    );
    expect(result.errors).toEqual([]);
    expect(result.cycleCalls).toBe(2);
    expect(result.cycleCap).toBe(2);
  });

  it("still stops at the plan end during a reschedule", async () => {
    const service = serviceWith(
      [
        occurrence("occ-7", 7, "RESCHEDULED"),
        occurrence("occ-9", 9, "SCHEDULED"),
      ],
      { planEndsAt: new Date("2025-01-10T00:00:00.000Z") },
    );
    const inside = await service.validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-08T10:00:00.000Z", 2),
      [],
      ["occ-7"],
    );
    expect(inside.errors).toEqual([]);
    expect(inside.subscriptionPeriod.end.toISOString()).toBe(
      "2025-01-10T00:00:00.000Z",
    );
    const past = await service.validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-10T10:00:00.000Z", 2),
      [],
      ["occ-7"],
    );
    expect(past.isValid).toBe(false);
    expect(past.errors[0]).toContain("[OUTSIDE_PLAN_WEEK]");
  });

  it("still frees the place of a replaced confirmed row", async () => {
    const result = await serviceWith([
      occurrence("occ-7", 7, "SCHEDULED"),
      occurrence("occ-9", 9, "SCHEDULED"),
    ]).validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-10T10:00:00.000Z", 2),
      [],
      ["occ-7"],
    );
    expect(result.cycleCap).toBe(1);
  });
});

describe("the plan total and call counting", () => {
  it("refuses a proposal that would pass the frozen total", async () => {
    const held = {
      id: "apt-old",
      occurrences: [
        {
          id: "occ-done",
          startsAt: new Date("2024-12-01T10:00:00.000Z"),
          endsAt: new Date("2024-12-01T11:00:00.000Z"),
          completionStatus: "COMPLETED",
          isTentative: false,
          deletedAt: null,
        },
      ],
    };
    const result = await createService({
      sessionsTotal: 1,
      appointment: held,
    }).validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-07T10:00:00.000Z", 2),
    );
    expect(result.totalCallsScheduled).toBe(2);
    expect(result.maxTotalCalls).toBe(1);
    expect(result.isValid).toBe(false);
  });

  it("a full plan with one voided session accepts one replacement", async () => {
    const row = (id: string, day: string, completionStatus: string) => ({
      id,
      startsAt: new Date(`${day}T10:00:00.000Z`),
      endsAt: new Date(`${day}T11:00:00.000Z`),
      completionStatus,
      isTentative: false,
      deletedAt: null,
    });
    const wrapper = {
      id: "apt-1",
      occurrences: [
        row("occ-voided", "2025-01-07", "VOIDED"),
        row("occ-held", "2025-01-08", "SCHEDULED"),
      ],
    };
    const service = createService({ sessionsTotal: 2, appointment: wrapper }, [
      wrapper,
    ]);

    const replacement = await service.validateSubscriptionSlots(
      "sub-1",
      makeConsecutiveSlotISOs("2025-01-09T10:00:00.000Z", 2),
    );
    expect(replacement.errors).toEqual([]);
    expect(replacement.totalCallsScheduled).toBe(2);

    const twoMore = await service.validateSubscriptionSlots("sub-1", [
      ...makeConsecutiveSlotISOs("2025-01-09T10:00:00.000Z", 2),
      ...makeConsecutiveSlotISOs("2025-01-10T10:00:00.000Z", 2),
    ]);
    expect(twoMore.isValid).toBe(false);
  });

  it("counts an overnight call as one", async () => {
    const result = await createService({
      subscriptionPlan: makeSubscriptionPlan({ sessionDurationInHours: 1 }),
    }).validateSubscriptionSlots("sub-1", [
      "2025-01-07T23:30:00.000Z",
      "2025-01-08T00:00:00.000Z",
    ]);
    expect(result.cycleCalls).toBe(1);
    expect(result.isValid).toBe(true);
  });

  it("does not count an incomplete call", async () => {
    const result = await createService().validateSubscriptionSlots("sub-1", [
      "2025-01-07T10:00:00.000Z",
    ]);
    expect(result.cycleCalls).toBe(0);
  });
});
