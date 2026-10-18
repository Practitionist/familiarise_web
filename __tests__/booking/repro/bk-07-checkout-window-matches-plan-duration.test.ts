/**
 * @jest-environment node
 */

// Invariant: direct checkout refuses a window whose length differs from the plan's duration, before any gateway call.

import "../../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mintOrder,
  mockCreatePaymentIntent as createPaymentIntent,
  silenceConsole,
} from "./checkout-harness/mocks/setup";

jest.mock("../../../utils/scheduling-engine/availabilityCoverage", () => ({
  __esModule: true,
  windowAtoms: () => [],
  findUncoveredAtom: () => null,
  loadPublishedCoverage: async () => ({
    scheduleType: "WEEKLY",
    weeklyRows: [],
    customRows: [],
  }),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { resetDouble } from "./checkout-harness/setup";
import { assertWindowMatchesPlanDuration } from "../../../lib/booking/slot-validation";

const START = new Date(Date.now() + 72 * 60 * 60 * 1000);
const SIX_HOURS_LATER = new Date(START.getTime() + 6 * 60 * 60 * 1000);

beforeEach(() => {
  mintOrder("order_new");
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "consultationPlan.findUnique": () => ({
      id: "plan-1",
      price: 100_000,
      priceCurrency: "INR",
      durationInHours: 1,
      archivedAt: null,
      visibility: "PUBLIC",
      status: "PUBLISHED",
      consultantProfileId: "cons-profile",
      consultantProfile: {
        id: "cons-profile",
        userId: "cons-user",
        deletedAt: null,
        verificationStatus: "VERIFIED",
        user: { id: "cons-user", timezone: "Asia/Kolkata" },
      },
    }),
    "availabilityWindowWeekly.findUnique": () => ({
      consultantProfile: {
        id: "cons-profile",
        userId: "cons-user",
        deletedAt: null,
      },
    }),
  });
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

describe("direct checkout window vs plan duration", () => {
  it("refuses a 6 h window on a 1 h plan with a 400/409 before any gateway call", async () => {
    const input = buildCheckoutInput({
      appointmentType: "CONSULTATION",
      availabilityWindowWeeklyId: "win-1",
      startsAt: START.toISOString(),
      endsAt: SIX_HOURS_LATER.toISOString(),
    });

    const error = await handleCheckout(input, "buyer").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(createPaymentIntent).not.toHaveBeenCalled();
    const httpStatus =
      error instanceof Error && "httpStatus" in error
        ? error.httpStatus
        : undefined;
    expect([400, 409]).toContain(httpStatus);
  });
});

describe("assertWindowMatchesPlanDuration — the one check request, checkout and trials share", () => {
  const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

  it("accepts the plan's own length and refuses any other, typed 400", () => {
    expect(() =>
      assertWindowMatchesPlanDuration({ durationInHours: 1 }, START, at(60)),
    ).not.toThrow();
    expect(() =>
      assertWindowMatchesPlanDuration({ durationInHours: 1 }, START, at(360)),
    ).toThrow(
      expect.objectContaining({
        code: "WINDOW_DURATION_MISMATCH",
        httpStatus: 400,
      }),
    );
  });

  it("reads a trial's minutes, and refuses an unreadable window", () => {
    expect(() =>
      assertWindowMatchesPlanDuration(
        { trialDurationMinutes: 30 },
        START,
        at(30),
      ),
    ).not.toThrow();
    expect(() =>
      assertWindowMatchesPlanDuration({ trialDurationMinutes: 30 }, START, ""),
    ).toThrow(expect.objectContaining({ code: "WINDOW_DURATION_MISMATCH" }));
  });
});
