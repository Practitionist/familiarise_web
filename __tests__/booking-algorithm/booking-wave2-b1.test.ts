/**
 * Unit tests for Booking Wave 2 B1 backend fixes:
 * - #1688: Co-host busy check at checkout, trials & webhook revival
 * - #1689 / #1691 / #1723: Co-host availability validation, ETag key & CDN suffix matching
 * - #1692: Allocator follow-ups (manual allowPartial, SlotShortageError, requested group-event rejection, reschedule schema guard)
 * - #1690: Cross-midnight session week bucketing, subscription slotEnd boundary & timezone-aware countWeeks
 * - #1693: Unified SCHEDULING_INTERVAL_MS constant
 * - #1743: Subscription renewal schema & error classification
 */

import "./setup";

import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { classifyError } from "@/lib/errors/classification/payment-error-classification";
import {
  availabilityGridEtag,
  ifNoneMatchSatisfied,
  type AvailabilityGridEtagKey,
  type AvailabilityGridMarker,
} from "@/lib/scheduling/availabilityGridMarker";
import { checkoutSchema } from "@/schemas/checkout";
import { allocationRequestSchema } from "@/schemas/slotAllocation/validationSchemas";
import { THIRTY_MIN_MS } from "@/utils/scheduling-engine/intervals";
import { buildConsultantOccupancyWhere } from "@/utils/scheduling-engine/occupancyPolicy";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";
import {
  makeMockPrisma,
  makeSubscription,
  makeSubscriptionPlan,
} from "../fixtures/booking.mockData";

describe("#1693 — Unified SCHEDULING_INTERVAL_MS", () => {
  it("exports THIRTY_MIN_MS equal to SCHEDULING_INTERVAL_MS (30 minutes)", () => {
    expect(SCHEDULING_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(THIRTY_MIN_MS).toBe(SCHEDULING_INTERVAL_MS);
  });
});

describe("#1688 — buildConsultantOccupancyWhere includes co-host commitments", () => {
  it("includes collaborator filters when consultantProfileId is provided", () => {
    const now = new Date("2025-06-01T12:00:00.000Z");
    const where = buildConsultantOccupancyWhere(
      "consultant-profile-1",
      "consultant-user-1",
      now,
    ) as { AND: Array<{ OR?: Array<Record<string, unknown>> }> };

    expect(Array.isArray(where.AND)).toBe(true);
    const reachesConsultant = where.AND[1]?.OR ?? [];
    // 1 participant branch + 1 primary host OR branch + 1 cohost commitment OR branch = 3
    expect(reachesConsultant.length).toBe(3);
    const cohostOr =
      (reachesConsultant[2] as { OR?: Array<Record<string, unknown>> })?.OR ??
      [];
    expect(cohostOr.length).toBe(2);
    expect(
      cohostOr.some(
        (branch) =>
          branch.webinar &&
          typeof branch.webinar === "object" &&
          "webinarPlan" in branch.webinar,
      ),
    ).toBe(true);
    expect(
      cohostOr.some(
        (branch) =>
          branch.class &&
          typeof branch.class === "object" &&
          "classPlan" in branch.class,
      ),
    ).toBe(true);
  });
});

describe("#1689 & #1723 — Availability grid ETag key and CDN suffix matching", () => {
  it("distinguishes ETag keys by webinarId and classId (#1689)", () => {
    const marker: AvailabilityGridMarker = {
      profileUpdatedAt: new Date("2027-06-01T00:00:00.000Z"),
      availabilityUpdatedAt: new Date("2027-06-01T00:00:00.000Z"),
      availabilityRowCount: 4,
      slotsUpdatedAt: new Date("2027-06-01T00:00:00.000Z"),
      slotRowCount: 2,
      collaboratorsUpdatedAt: null,
      paymentsUpdatedAt: null,
      requestsUpdatedAt: null,
      nextHoldExpiry: null,
    };

    const baseKey: AvailabilityGridEtagKey = {
      consultantId: "cp-1",
      startIso: "2027-06-01T00:00:00.000Z",
      endIso: "2027-06-08T00:00:00.000Z",
      timezone: "Asia/Kolkata",
      includeAppointmentDetails: false,
      consulteeUserId: null,
    };

    const hostOnlyEtag = availabilityGridEtag(marker, baseKey);
    const webinarEtag = availabilityGridEtag(marker, {
      ...baseKey,
      webinarId: "web-1",
    });
    const classEtag = availabilityGridEtag(marker, {
      ...baseKey,
      classId: "cls-1",
    });

    expect(webinarEtag).not.toBe(hostOnlyEtag);
    expect(classEtag).not.toBe(hostOnlyEtag);
    expect(webinarEtag).not.toBe(classEtag);
  });

  it("matches weak ETags and CDN encoding suffixes (#1723)", () => {
    const current = 'W/"ag1:cp-1:100:200:UTC:0:1:2:3::"';

    expect(ifNoneMatchSatisfied(current, current)).toBe(true);
    // Strong version without W/
    expect(
      ifNoneMatchSatisfied('"ag1:cp-1:100:200:UTC:0:1:2:3::"', current),
    ).toBe(true);
    // CDN gzip / br / df suffixes inside quotes
    expect(
      ifNoneMatchSatisfied('W/"ag1:cp-1:100:200:UTC:0:1:2:3::-gzip"', current),
    ).toBe(true);
    expect(
      ifNoneMatchSatisfied('"ag1:cp-1:100:200:UTC:0:1:2:3::-br"', current),
    ).toBe(true);
    expect(
      ifNoneMatchSatisfied('"ag1:cp-1:100:200:UTC:0:1:2:3::-df"', current),
    ).toBe(true);
    // Comma-separated list with matching token
    expect(
      ifNoneMatchSatisfied(
        '"other-etag", W/"ag1:cp-1:100:200:UTC:0:1:2:3::-gzip"',
        current,
      ),
    ).toBe(true);
    // Non-matching ETag
    expect(
      ifNoneMatchSatisfied('W/"ag1:cp-1:100:200:UTC:0:1:2:999::"', current),
    ).toBe(false);
  });
});

describe("#1689 — ScheduleValidationService checks ACCEPTED co-hosts", () => {
  it("flags [COLLABORATOR_SCHEDULE] and [COLLABORATOR_CONFLICT] when co-host is unavailable or busy", async () => {
    const mockPrisma = {
      webinar: {
        findUnique: jest.fn().mockResolvedValue({
          webinarPlan: {
            collaborators: [
              {
                consultantProfileId: "cohost-cp-1",
                consultantProfile: {
                  user: { id: "cohost-u-1", name: "Dr. CoHost", timezone: "UTC" },
                  scheduleType: "CUSTOM",
                  availabilityWindowsWeekly: [],
                  // Co-host has no custom availability covering 10:00-11:00
                  availabilityWindowsCustom: [
                    {
                      id: "custom-1",
                      startsAt: new Date("2027-06-01T14:00:00.000Z"),
                      endsAt: new Date("2027-06-01T16:00:00.000Z"),
                    },
                  ],
                },
              },
            ],
          },
        }),
      },
      appointment: {
        findMany: jest
          .fn()
          // 1st call (schedule check fails before co-host conflict): primary host conflicts -> none
          .mockResolvedValueOnce([])
          // 2nd call (with overrideAvailabilityWindow: true): primary host conflicts -> none
          .mockResolvedValueOnce([])
          // 3rd call (with overrideAvailabilityWindow: true): co-host conflicts -> has conflict at 10:00
          .mockResolvedValueOnce([
            {
              id: "cohost-apt-1",
              occurrences: [
                {
                  startsAt: new Date("2027-06-01T10:00:00.000Z"),
                  endsAt: new Date("2027-06-01T10:30:00.000Z"),
                },
              ],
              consultation: {
                consultationPlan: { title: "1:1 Consultation" },
                requestedBy: { user: { id: "u-9", name: "Alice" } },
              },
              subscription: null,
              webinar: null,
              class: null,
            },
          ]),
      },
    } as unknown as ConstructorParameters<typeof ScheduleValidationService>[0];

    const validator = new ScheduleValidationService(mockPrisma);
    const hostData = {
      userId: "host-u-1",
      scheduleType: "CUSTOM" as const,
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        {
          id: "host-c-1",
          startsAt: new Date("2027-06-01T09:00:00.000Z"),
          endsAt: new Date("2027-06-01T12:00:00.000Z"),
        },
      ],
      timezone: "UTC",
    };
    const proposed = [
      new Date("2027-06-01T10:00:00.000Z"),
      new Date("2027-06-01T10:30:00.000Z"),
    ];

    const scheduleRes = await validator.validate(
      "webinar",
      "web-1",
      proposed,
      hostData,
      { durationInHours: 1, schedulingTimezone: "UTC" },
    );

    expect(scheduleRes.isValid).toBe(false);
    expect(
      scheduleRes.errors.some((e) => e.includes("[COLLABORATOR_SCHEDULE]")),
    ).toBe(true);

    const conflictRes = await validator.validate(
      "webinar",
      "web-1",
      proposed,
      hostData,
      { durationInHours: 1, schedulingTimezone: "UTC" },
      [],
      { overrideAvailabilityWindow: true },
    );

    expect(conflictRes.isValid).toBe(false);
    expect(
      conflictRes.errors.some((e) => e.includes("[COLLABORATOR_CONFLICT]")),
    ).toBe(true);
  });
});

describe("#1690 — Cross-midnight session bucketing and timezone-aware countWeeks", () => {
  it("ScheduleValidationService buckets a class session crossing midnight Saturday->Sunday into Saturday's week", async () => {
    const mockPrisma = {
      class: { findUnique: jest.fn().mockResolvedValue(null) },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      appointmentOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as ConstructorParameters<typeof ScheduleValidationService>[0];

    const validator = new ScheduleValidationService(mockPrisma);
    // In UTC: Saturday 2027-06-05 23:30 to Sunday 2027-06-06 00:30 (2 consecutive 30-min atoms)
    const result = await validator.validate(
      "class",
      "cls-1",
      [
        new Date("2027-06-05T23:30:00.000Z"),
        new Date("2027-06-06T00:00:00.000Z"),
      ],
      {
        userId: "host-u-1",
        scheduleType: "CUSTOM",
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: [
          {
            id: "c-1",
            startsAt: new Date("2027-06-05T22:00:00.000Z"),
            endsAt: new Date("2027-06-06T02:00:00.000Z"),
          },
        ],
        timezone: "UTC",
      },
      {
        sessionDurationInHours: 1,
        sessionsPerWeek: 1,
        totalSessions: 1,
        schedulingPeriodStartsAt: new Date("2027-06-01T00:00:00.000Z"),
        schedulingPeriodEndsAt: new Date("2027-06-14T23:59:59.000Z"),
        schedulingTimezone: "UTC",
      },
    );

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("SubscriptionValidationService counts an overnight call crossing midnight as 1 call and rejects slots extending past windowEnd", async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

      const sub = makeSubscription({
        schedulingTimezone: "UTC",
        schedulingPeriodStartsAt: new Date("2025-01-05T00:00:00.000Z"),
        schedulingPeriodEndsAt: new Date("2025-02-02T00:00:00.000Z"),
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
        }),
      });
      const mockPrisma = makeMockPrisma(sub, []);
      const service = new SubscriptionValidationService(mockPrisma);

      // 1-hour call crossing midnight Mon Jan 6 23:30 UTC -> Tue Jan 7 00:30 UTC
      const overnightRes = await service.validateSubscriptionSlots("sub-1", [
        "2025-01-06T23:30:00.000Z",
        "2025-01-07T00:00:00.000Z",
      ]);
      expect(overnightRes.isValid).toBe(true);
      expect(overnightRes.totalCallsScheduled).toBe(1);

      // Slot starting right at windowEnd (so slotEnd > windowEnd) is rejected
      const endWindowIso = overnightRes.subscriptionPeriod.end.toISOString();
      const pastEndRes = await service.validateSubscriptionSlots("sub-1", [
        endWindowIso,
      ]);
      expect(pastEndRes.isValid).toBe(false);
      expect(
        pastEndRes.errors.some((e) =>
          e.includes("outside subscription period"),
        ),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("ScheduleCalculationService.countWeeks respects optional timeZone parameter", () => {
    // Saturday 2025-01-04 20:00 UTC is Sunday 2025-01-05 01:30 in Asia/Kolkata.
    // Along with Monday 2025-01-06 10:00 UTC:
    // - In UTC: Sat Jan 4 (week of Dec 29) to Mon Jan 6 (week of Jan 5) = 2 weeks
    // - In Asia/Kolkata: Sun Jan 5 (week of Jan 5) to Mon Jan 6 (week of Jan 5) = 1 week
    const start = new Date("2025-01-04T20:00:00.000Z");
    const end = new Date("2025-01-06T10:00:00.000Z");

    expect(ScheduleCalculationService.countWeeks(start, end, "UTC")).toBe(2);
    expect(
      ScheduleCalculationService.countWeeks(start, end, "Asia/Kolkata"),
    ).toBe(1);
  });
});

describe("#1692 — Reschedule schema guard", () => {
  it("requires expectedTentativeSlotCount when isReschedule is true", () => {
    const invalid = allocationRequestSchema.safeParse({
      isAuto: true,
      isReschedule: true,
    });
    expect(invalid.success).toBe(false);

    const validReschedule = allocationRequestSchema.safeParse({
      isAuto: true,
      isReschedule: true,
      expectedTentativeSlotCount: 2,
    });
    expect(validReschedule.success).toBe(true);

    const validFresh = allocationRequestSchema.safeParse({
      isAuto: true,
      isReschedule: false,
    });
    expect(validFresh.success).toBe(true);
  });
});

describe("#1743 — Subscription renewal schema and error classification", () => {
  it("accepts optional renewsSubscriptionId in checkoutSchema", () => {
    const parsed = checkoutSchema.safeParse({
      appointmentType: "SUBSCRIPTION",
      planId: "plan-1",
      paymentGateway: "RAZORPAY",
      renewsSubscriptionId: "prior-sub-123",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.renewsSubscriptionId : null).toBe(
      "prior-sub-123",
    );
  });

  it("classifies ALREADY_RENEWED as 409 and INVALID_RENEWAL_SOURCE as 400", () => {
    const alreadyRenewedErr = Object.assign(
      new Error("This subscription has already been renewed"),
      { code: "ALREADY_RENEWED" },
    );
    const invalidSourceErr = Object.assign(
      new Error("Invalid renewal source"),
      { code: "INVALID_RENEWAL_SOURCE" },
    );

    expect(classifyError(alreadyRenewedErr).httpStatus).toBe(409);
    expect(classifyError(invalidSourceErr).httpStatus).toBe(400);
  });
});
