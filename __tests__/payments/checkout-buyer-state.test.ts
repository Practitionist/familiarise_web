/**
 * @jest-environment node
 */

// A domestic buyer-paid checkout carries the buyer's GST state; org-funded and export checkouts need none.

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mintOrder,
  silenceConsole,
} from "../booking/repro/checkout-harness/mocks/setup";

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({ session: { user: { id: "buyer" } } })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  checkoutLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/payments/operations/checkout-replay", () => ({
  replayByIdempotencyKey: jest.fn(async () => null),
}));
jest.mock("../../lib/payments/tax/checkout-context", () => ({
  resolveCheckoutTaxContext: jest.fn(async () => ({ buyerCountry: "IN" })),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  ProgramAssignmentLimitError: class extends Error {},
  recordBookingUtilization: jest.fn(async () => ({
    wasOverage: false,
    engagementsConsumedDelta: 1,
    engagementsUsedAfter: 1,
    cap: null,
    programType: "LICENSED_SEAT",
    consumedPaiseAfter: 0,
    creditBudgetPaise: null,
  })),
  reverseBookingUtilization: jest.fn(),
}));
// The org rail settles earnings inside the checkout tx; that ledger is out of scope here.
jest.mock("../../lib/payments/checkout/commit/ledger", () => ({
  __esModule: true,
  recordSynchronousEarnings: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  ensurePlatformCancellationPolicy: jest.fn(async () => undefined),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/checkout/route";
import { handleCheckout } from "../../lib/payments/checkout";
import { calls, resetDouble } from "../booking/repro/checkout-harness/setup";
import { BUYER_STATE_REQUIRED_MESSAGE } from "../../schemas/checkout";

const plan = {
  id: "wplan-1",
  price: 100_000,
  priceCurrency: "INR",
  maxParticipants: 50,
  refundWindowHours: 24,
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
  },
};
const webinar = {
  id: "web-1",
  status: "SCHEDULED",
  webinarPlan: plan,
  appointment: {
    id: "appt-webinar",
    occurrences: [
      {
        id: "occ-1",
        startsAt: new Date(Date.now() + 72 * 3600_000),
        endsAt: new Date(Date.now() + 73 * 3600_000),
        deletedAt: null,
        completionStatus: "SCHEDULED",
      },
    ],
    participants: [],
  },
};

const licensedOrg = {
  "organization.findUnique": () => ({
    id: "org-1",
    status: "ACTIVE",
    canSponsor: true,
    billingAccount: {
      id: "ba-1",
      fundingSource: "LICENSE",
      creditLimit: null,
      walletBalance: 0,
    },
  }),
  "billingAccount.findFirst": () => ({
    id: "ba-1",
    fundingSource: "LICENSE",
    creditLimit: null,
  }),
  "membership.findUnique": () => ({
    id: "m-1",
    role: "MEMBER",
    status: "ACTIVE",
  }),
  "programAssignment.findFirst": () => ({ id: "pa-1", programId: "prog-1" }),
};

const webinarInput = (extra: Record<string, unknown> = {}) =>
  buildCheckoutInput({
    appointmentType: "WEBINAR",
    planId: "wplan-1",
    eventId: "web-1",
    consumerStateCode: undefined,
    ...extra,
  });

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("https://x.test/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const storedStateCode = () =>
  (
    calls.find((c) => c.path === "payment.create")?.args as {
      data: { consumerStateCode: string | null };
    }
  ).data.consumerStateCode;

beforeEach(() => {
  mintOrder("order_1");
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "webinar.findUnique": () => webinar,
    "webinarPlan.findUnique": () => ({
      consultantProfileId: "cons-profile",
      organizationId: null,
      collaborators: [],
    }),
  });
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

describe("the buyer's GST state at checkout", () => {
  it.each([
    ["missing", undefined, BUYER_STATE_REQUIRED_MESSAGE],
    ["not a real state", "99", "Not a valid GST state code"],
  ])(
    "a domestic buyer-paid checkout with the state %s answers 400 on the field",
    async (_label, consumerStateCode, message) => {
      const res = await post(webinarInput({ consumerStateCode }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: message,
        field: "consumerStateCode",
      });
      expect(calls.some((c) => c.path === "payment.create")).toBe(false);
    },
  );

  it("stores the state the buyer declared", async () => {
    const res = await post(webinarInput({ consumerStateCode: "27" }));
    expect(res.status).toBe(200);
    expect(storedStateCode()).toBe("27");
  });

  it("an org-funded checkout needs no state", async () => {
    resetDouble({
      "user.findUnique": () => buyerRow(),
      "webinar.findUnique": () => webinar,
      "webinarPlan.findUnique": () => ({
        consultantProfileId: "cons-profile",
        organizationId: null,
        collaborators: [],
      }),
      ...licensedOrg,
    });
    const result = await handleCheckout(
      webinarInput({ organizationId: "org-1" }),
      "buyer",
    );
    expect(result).toMatchObject({ success: true, skipPayment: true });
    expect(storedStateCode()).toBeNull();
  });

  it("an export checkout needs no state", async () => {
    const result = await handleCheckout(webinarInput(), "buyer", false, "US");
    expect(result).toMatchObject({ success: true });
    expect(storedStateCode()).toBeNull();
  });
});
