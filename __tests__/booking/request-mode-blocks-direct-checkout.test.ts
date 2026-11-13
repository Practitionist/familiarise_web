/**
 * @jest-environment node
 */

// Invariant: a review-first expert (bookingMode REQUEST) sells no direct 1:1 checkout, on any rail;
// plans, webinars and classes keep selling.

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mockCreatePaymentIntent as createPaymentIntent,
  orgMember,
  silenceConsole,
} from "./repro/checkout-harness/mocks/setup";

import { handleCheckout } from "../../lib/payments/checkout";
import { calls, resetDouble } from "./repro/checkout-harness/setup";
import type { CheckoutInput } from "../../schemas/checkout";

const START = new Date(Date.now() + 72 * 3600_000);
const slot = {
  availabilityWindowWeeklyId: "win-1",
  startsAt: START.toISOString(),
  endsAt: new Date(START.getTime() + 3600_000).toISOString(),
};

function planFor(bookingMode: "REQUEST" | "INSTANT", price = 100_000) {
  return {
    id: "plan-1",
    price,
    priceCurrency: "INR",
    durationInHours: 1,
    archivedAt: null,
    visibility: "PUBLIC",
    status: "PUBLISHED",
    organizationId: null,
    consultantProfileId: "cons-profile",
    consultantProfile: {
      id: "cons-profile",
      userId: "cons-user",
      deletedAt: null,
      verificationStatus: "VERIFIED",
      acceptingRequests: true,
      bookingMode,
      user: { id: "cons-user", timezone: "Asia/Kolkata" },
    },
  };
}

function stage(bookingMode: "REQUEST" | "INSTANT", price?: number, extra = {}) {
  const plan = planFor(bookingMode, price);
  const event = { id: "event-1", status: "SCHEDULED", appointment: null };
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "consultationPlan.findUnique": () => plan,
    "subscriptionPlan.findUnique": () => plan,
    "webinar.findUnique": () => ({ ...event, webinarPlan: plan }),
    "class.findUnique": () => ({ ...event, classPlan: plan }),
    ...extra,
  });
}

const codeOf = (input: CheckoutInput) =>
  handleCheckout(input, "buyer").then(
    () => null,
    (caught: unknown) =>
      caught && typeof caught === "object" && "code" in caught
        ? (caught as { code: unknown; httpStatus?: unknown })
        : { code: null },
  );

beforeEach(() => {
  createPaymentIntent.mockReset();
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

it.each([
  ["paid", undefined, {}, {}],
  ["zero-amount", 0, {}, {}],
  ["organisation-funded", undefined, orgMember(), { organizationId: "org-1" }],
])(
  "a %s 1:1 checkout for a review-first expert is refused 409 before any gateway order",
  async (_label, price, extraDouble, extraInput) => {
    stage("REQUEST", price, extraDouble);
    const refusal = await codeOf(
      buildCheckoutInput({
        appointmentType: "CONSULTATION",
        ...slot,
        ...extraInput,
      }),
    );
    expect(refusal).toMatchObject({
      code: "REQUEST_APPROVAL_REQUIRED",
      httpStatus: 409,
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
  },
);

it.each<[CheckoutInput["appointmentType"], "REQUEST" | "INSTANT", object]>([
  ["CONSULTATION", "INSTANT", slot],
  ["SUBSCRIPTION", "REQUEST", {}],
  ["WEBINAR", "REQUEST", { eventId: "event-1" }],
  ["CLASS", "REQUEST", { eventId: "event-1" }],
])(
  "a %s checkout under %s is not refused for review",
  async (type, mode, extra) => {
    stage(mode);
    const refusal = await codeOf(
      buildCheckoutInput({ appointmentType: type, ...extra }),
    );
    expect(refusal?.code).not.toBe("REQUEST_APPROVAL_REQUIRED");
  },
);

// Each switch is re-read under the lock (before any gateway order) and again in the commit.
describe.each([
  ["review-first", "REQUEST_APPROVAL_REQUIRED", { bookingMode: "REQUEST" }],
  ["pause", "NOT_ACCEPTING_BOOKINGS", { acceptingRequests: false }],
])("the %s switch flipped after pricing", (_label, code, flip) => {
  function stageFlip(when: "lock" | "mint" | "never") {
    const plan = planFor("INSTANT");
    let flipped = false;
    const read = (args: unknown) => {
      const lockRead = (args as { select?: { consultantProfile?: unknown } })
        .select?.consultantProfile;
      if (when === "lock" && lockRead) flipped = true;
      return flipped
        ? { ...plan, consultantProfile: { ...plan.consultantProfile, ...flip } }
        : plan;
    };
    const end = new Date(START.getTime() + 3600_000);
    resetDouble({
      "user.findUnique": () => buyerRow(),
      "consultationPlan.findUnique": read,
      "cancellationPolicy.findUnique": () => ({ id: "platform-policy" }),
      "availabilityWindowCustom.findUnique": () => ({
        consultantProfile: plan.consultantProfile,
      }),
      "consultantProfile.findUnique": () => ({
        scheduleType: "CUSTOM",
        deletedAt: null,
      }),
      "availabilityWindowCustom.findMany": () => [
        { startsAt: START, endsAt: end },
      ],
    });
    createPaymentIntent.mockImplementation(async () => {
      if (when === "mint") flipped = true;
      return { id: "order_flip", client_secret: "s" };
    });
  }
  const consultationsCreated = () =>
    calls.filter((c) => c.path === "consultation.create").length;
  const checkout = () =>
    codeOf(
      buildCheckoutInput({
        appointmentType: "CONSULTATION",
        availabilityWindowCustomId: "row-1",
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      }),
    );

  it("before the lock's re-read is refused before any gateway order", async () => {
    stageFlip("lock");
    expect(await checkout()).toMatchObject({ code, httpStatus: 409 });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(consultationsCreated()).toBe(0);
  });

  it("while the order is minted is refused by the commit, which writes no booking", async () => {
    stageFlip("mint");
    expect(await checkout()).toMatchObject({ code, httpStatus: 409 });
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(consultationsCreated()).toBe(0);
  });

  it("never flipped, the checkout books as before", async () => {
    stageFlip("never");
    expect(await checkout()).toBeNull();
    expect(consultationsCreated()).toBe(1);
  });
});
