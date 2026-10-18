/**
 * @jest-environment node
 */

// Invariant: a paused expert (acceptingRequests false) takes no new direct booking of any product.

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mockCreatePaymentIntent as createPaymentIntent,
  silenceConsole,
} from "./repro/checkout-harness/mocks/setup";

import { handleCheckout } from "../../lib/payments/checkout";
import { resetDouble } from "./repro/checkout-harness/setup";
import type { CheckoutInput } from "../../schemas/checkout";

const pausedProfile = {
  id: "cons-profile",
  userId: "cons-user",
  deletedAt: null,
  verificationStatus: "VERIFIED",
  acceptingRequests: false,
  user: { id: "cons-user", timezone: "Asia/Kolkata" },
};
const plan = {
  id: "plan-1",
  price: 100_000,
  priceCurrency: "INR",
  durationInHours: 1,
  archivedAt: null,
  visibility: "PUBLIC",
  status: "PUBLISHED",
  organizationId: null,
  consultantProfileId: "cons-profile",
  consultantProfile: pausedProfile,
};
const event = { id: "event-1", status: "SCHEDULED", appointment: null };
const START = new Date(Date.now() + 72 * 3600_000);

const cases: Array<[CheckoutInput["appointmentType"], Partial<CheckoutInput>]> =
  [
    [
      "CONSULTATION",
      {
        availabilityWindowWeeklyId: "win-1",
        startsAt: START.toISOString(),
        endsAt: new Date(START.getTime() + 3600_000).toISOString(),
      },
    ],
    ["SUBSCRIPTION", {}],
    ["WEBINAR", { eventId: "event-1" }],
    ["CLASS", { eventId: "event-1" }],
  ];

beforeEach(() => {
  createPaymentIntent.mockReset();
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "consultationPlan.findUnique": () => plan,
    "subscriptionPlan.findUnique": () => plan,
    "webinar.findUnique": () => ({ ...event, webinarPlan: plan }),
    "class.findUnique": () => ({ ...event, classPlan: plan }),
  });
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

it.each(cases)(
  "%s checkout refuses with 409 NOT_ACCEPTING_BOOKINGS before any gateway call",
  async (appointmentType, extra) => {
    const input = buildCheckoutInput({ appointmentType, ...extra });

    const error = await handleCheckout(input, "buyer").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      httpStatus: 409,
      code: "NOT_ACCEPTING_BOOKINGS",
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
  },
);
