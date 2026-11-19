/**
 * A 1:1 session, request or trial starts at most 90 days ahead. Every door a
 * buyer or an expert places a 1:1 through refuses a later start with the same
 * sentence; a subscription's plan weeks follow their own period rule.
 */

import "../booking-algorithm/setup";

import { ScheduleType } from "@prisma/client";
import type { SafeParseReturnType } from "zod";

import { isSlotStillOffered } from "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow";
import { refusalCopyFor } from "@/lib/booking/allocation/refusal-copy";
import { MAX_BOOKING_HORIZON_MS } from "@/lib/booking/lead-time";
import { isTerminalSlotRefusal } from "@/lib/errors/classification/payment-error-classification";
import { getErrorToast } from "@/lib/errors/mapping/payment-error-toast-map";
import {
  SLOT_TOO_FAR_MESSAGE,
  slotStartRefusal,
} from "@/lib/payments/utils/slot-validation";
import { checkoutSchema } from "@/schemas/checkout";
import { RequestForApprovalSchema } from "@/schemas/slots";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";

const HALF_HOUR = 30 * 60_000;
const NOW = new Date("2026-11-19T06:00:00.000Z");
const atHorizon = new Date(NOW.getTime() + MAX_BOOKING_HORIZON_MS);
const pastHorizon = new Date(atHorizon.getTime() + HALF_HOUR);
const window = (start: Date) => ({
  startsAt: start.toISOString(),
  endsAt: new Date(start.getTime() + HALF_HOUR).toISOString(),
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe("slotStartRefusal", () => {
  it("refuses a start 90 days and 30 minutes ahead, and accepts one exactly 90 days ahead", () => {
    expect(slotStartRefusal(pastHorizon, NOW)).toEqual({
      code: "SLOT_TOO_FAR",
      message: "Bookings open up to 90 days ahead. Pick an earlier time.",
    });
    expect(slotStartRefusal(atHorizon, NOW)).toBeNull();
  });

  it("is a refusal the buyer can act on: back to the grid, with its own title", () => {
    expect(isTerminalSlotRefusal("SLOT_TOO_FAR")).toBe(true);
    expect(
      getErrorToast("AVAILABILITY_ERROR", undefined, "SLOT_TOO_FAR").title,
    ).toBe("That time is too far ahead");
  });
});

describe("the buyer's doors", () => {
  const issueCodes = (result: SafeParseReturnType<unknown, unknown>) =>
    result.success
      ? []
      : result.error.issues.map((issue) =>
          issue.code === "custom" ? issue.params?.code : undefined,
        );

  it("request-for-approval refuses a start past the horizon", () => {
    const body = (start: Date) => ({
      consultantProfileId: "cp-1",
      consultationPlanId: "plan-1",
      availabilityWindowWeeklyId: "w-1",
      ...window(start),
    });
    expect(
      issueCodes(RequestForApprovalSchema.safeParse(body(pastHorizon))),
    ).toEqual(["SLOT_TOO_FAR"]);
    expect(RequestForApprovalSchema.safeParse(body(atHorizon)).success).toBe(
      true,
    );
  });

  it("a consultation checkout refuses it; a plan's first session does not", () => {
    const body = (appointmentType: string, start: Date) => ({
      appointmentType,
      planId: "plan-1",
      availabilityWindowWeeklyId: "w-1",
      ...window(start),
    });
    expect(
      issueCodes(checkoutSchema.safeParse(body("CONSULTATION", pastHorizon))),
    ).toEqual(["SLOT_TOO_FAR"]);
    expect(
      checkoutSchema.safeParse(body("CONSULTATION", atHorizon)).success,
    ).toBe(true);
    expect(
      checkoutSchema.safeParse(body("SUBSCRIPTION", pastHorizon)).success,
    ).toBe(true);
  });

  it("checkout's re-ask of the grid treats a cell past the horizon as not offered", async () => {
    const cell = (beyondHorizon: boolean) => ({
      ok: true,
      json: async () => ({
        data: {
          day: [
            {
              startsAt: pastHorizon.toISOString(),
              bookingStatus: "available",
              ...(beyondHorizon ? { beyondHorizon: true } : {}),
            },
          ],
        },
      }),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    const end = new Date(pastHorizon.getTime() + HALF_HOUR);

    fetchMock.mockResolvedValueOnce(cell(true));
    await expect(isSlotStillOffered("cp-1", pastHorizon, end)).resolves.toBe(
      false,
    );
    fetchMock.mockResolvedValueOnce(cell(false));
    await expect(isSlotStillOffered("cp-1", pastHorizon, end)).resolves.toBe(
      true,
    );
  });
});

describe("the allocator's validator", () => {
  const validate = (eventType: "consultation" | "subscription", start: Date) =>
    new ScheduleValidationService({
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      appointmentOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
      subscription: { findUnique: jest.fn().mockResolvedValue(null) },
    } as never).validate(
      eventType,
      "event-1",
      [start],
      {
        userId: "u-1",
        scheduleType: ScheduleType.CUSTOM,
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: [],
      },
      { durationInHours: 0.5 },
      [],
      { overrideAvailabilityWindow: true, consultantProfileId: "cp-1" },
    );

  it("refuses a consultation time past the horizon with the buyer's sentence", async () => {
    const result = await validate("consultation", pastHorizon);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/^\[TOO_FAR\]/);
    expect(refusalCopyFor(result.errors)).toBe(SLOT_TOO_FAR_MESSAGE);

    expect((await validate("consultation", atHorizon)).isValid).toBe(true);
  });

  it("never refuses a subscription time for the horizon", async () => {
    const result = await validate("subscription", pastHorizon);
    expect(result.errors.some((e) => e.startsWith("[TOO_FAR]"))).toBe(false);
  });
});
