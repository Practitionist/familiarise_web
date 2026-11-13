/**
 * @jest-environment node
 */

// A domestic buyer-paid checkout carries the buyer's GST state; org-funded, export and free checkouts need none.

import { runAsRegisteredPlatform } from "../fixtures/gst-registered";
import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  eventPlanLookup,
  mintOrder,
  orgMember,
  silenceConsole,
  webinar,
} from "../booking/repro/checkout-harness/mocks/setup";

// The org rail settles earnings inside the checkout tx; that ledger is out of scope here.
jest.mock("../../lib/payments/checkout/commit/ledger", () => ({
  __esModule: true,
  recordSynchronousEarnings: jest.fn(async () => undefined),
}));

import { ZodError } from "zod";
import { handleCheckout } from "../../lib/payments/checkout";
import { calls, resetDouble } from "../booking/repro/checkout-harness/setup";
import { BUYER_STATE_REQUIRED_MESSAGE } from "../../schemas/checkout";

const webinarInput = (extra: Record<string, unknown> = {}) =>
  buildCheckoutInput({
    appointmentType: "WEBINAR",
    planId: "wplan-1",
    eventId: "web-1",
    consumerStateCode: undefined,
    ...extra,
  });

const storedStateCode = () =>
  (
    calls.find((c) => c.path === "payment.create")?.args as {
      data: { consumerStateCode: string | null };
    }
  ).data.consumerStateCode;

const buyerPaidWebinar = {
  "user.findUnique": () => buyerRow(),
  "webinar.findUnique": () => webinar,
  "webinarPlan.findUnique": eventPlanLookup,
  "cancellationPolicy.findUnique": () => ({ id: "policy-1" }),
};

beforeEach(() => {
  mintOrder("order_1");
  resetDouble(buyerPaidWebinar);
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

describe("the buyer's GST state at checkout", () => {
  it("a domestic buyer-paid checkout without one is refused on the field, before any write", async () => {
    const error = await handleCheckout(webinarInput(), "buyer").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues[0]).toMatchObject({
      path: ["consumerStateCode"],
      message: BUYER_STATE_REQUIRED_MESSAGE,
    });
    expect(calls.some((c) => c.path === "payment.create")).toBe(false);
  });

  it("stores the state the buyer declared", async () => {
    await handleCheckout(webinarInput({ consumerStateCode: "27" }), "buyer");
    expect(storedStateCode()).toBe("27");
  });

  it("an org-funded checkout needs no state", async () => {
    resetDouble({
      ...buyerPaidWebinar,
      ...orgMember("LICENSE"),
      "programAssignment.findUniqueOrThrow": () => ({
        program: { type: "LICENSED_SEAT", licensedSeatConfig: null },
      }),
    });
    const result = await handleCheckout(
      webinarInput({ organizationId: "org-1" }),
      "buyer",
    );
    expect(result).toMatchObject({ success: true, skipPayment: true });
    expect(storedStateCode()).toBeNull();
  });

  it("a free domestic checkout needs no state: no consumer invoice is issued for it", async () => {
    resetDouble({
      ...buyerPaidWebinar,
      "webinar.findUnique": () => ({
        ...webinar,
        webinarPlan: { ...webinar.webinarPlan, price: 0 },
      }),
    });
    const result = await handleCheckout(webinarInput(), "buyer");
    expect(result).toMatchObject({ success: true, isZeroAmountPayment: true });
    expect(storedStateCode()).toBeNull();
  });

  it("an export checkout needs no state", async () => {
    const result = await handleCheckout(webinarInput(), "buyer", false, "US");
    expect(result).toMatchObject({ success: true });
    expect(storedStateCode()).toBeNull();
  });
});

// Org-funded rails and GST on surcharges exist only for a GST-registered platform.
runAsRegisteredPlatform();
