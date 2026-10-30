/**
 * @jest-environment node
 */

/**
 * Nothing in checkout compared the booking user against the plan's owner.
 *
 * That matters because `ConsultantProfile` and `ConsulteeProfile` are
 * independent 1:1s off `User` and deliberately not mutually exclusive — the
 * roles doc says so outright, and ADR 18 keeps the B2B/B2C boundary open. So a
 * LEARNER in a sponsoring organization may also sell on the marketplace, and
 * could book their OWN plan against the org's credit pool: the sponsor's money
 * leaves the budget and arrives in their own payout account.
 *
 * The same-org EXPERT+LEARNER block in `lib/enterprise/role-transitions.ts`
 * does not reach this. It governs one Membership row; this needs only a
 * ConsulteeProfile and a plan. `ProgramConsultantAllowlist` would have caught
 * it, but under ADR 18's open network it is empty by default.
 *
 * The guard lives inside `revalidateInsideLock` — the same place ADR 18 chose
 * for allowlist enforcement — because that is where the plan's owner is
 * already loaded and the distributed lock closes the check-then-book race.
 */

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mintOrder,
  mockCreatePaymentIntent as createPaymentIntent,
  orgMember,
  silenceConsole,
  webinar,
} from "../booking/repro/checkout-harness/mocks/setup";

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
}));
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  ensurePlatformCancellationPolicy: jest.fn(async () => undefined),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import { handleCheckout } from "../../lib/payments/checkout";
import { calls, resetDouble } from "../booking/repro/checkout-harness/setup";
import type { Overrides } from "../booking/repro/checkout-harness/setup";

/** The buyer, who may also hold a consultant profile of their own. */
const buyer = (consultantProfileId: string | null) => ({
  ...buyerRow(),
  consultantProfile: consultantProfileId ? { id: consultantProfileId } : null,
});
/** The in-lock plan lookup: its owner and its PENDING/ACCEPTED collaborators. */
const lookup = (owner: string | null, collaborators: string[] = []) => ({
  consultantProfileId: owner,
  organizationId: null,
  collaborators: collaborators.map((consultantProfileId) => ({
    consultantProfileId,
  })),
});
function setup(
  buyerProfile: string | null,
  planLookup: ReturnType<typeof lookup>,
  extra: Overrides = {},
) {
  resetDouble({
    "user.findUnique": () => buyer(buyerProfile),
    "webinar.findUnique": () => webinar,
    "webinarPlan.findUnique": () => planLookup,
    ...extra,
  });
}

const checkout = (organizationId?: string) =>
  handleCheckout(
    buildCheckoutInput({
      appointmentType: "WEBINAR",
      planId: "wplan-1",
      eventId: "web-1",
      ...(organizationId ? { organizationId } : {}),
    }),
    "buyer",
  ).then(
    () => null,
    (caught: unknown) => caught,
  );

const called = (path: string) => calls.some((call) => call.path === path);

beforeEach(() => {
  mintOrder("order_1");
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

describe("a user cannot book their own plan", () => {
  it("refuses a seat whose event is not on the plan named, so a foreign planId cannot dodge the guard", async () => {
    // The seller names someone else's plan for their own event.
    setup("cons-profile", lookup("someone-else"), {
      "webinar.count": () => 0,
    });
    expect(await checkout()).toMatchObject({
      httpStatus: 409,
      code: "PLAN_EVENT_MISMATCH",
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    const match = calls.find((call) => call.path === "webinar.count");
    expect(match?.args).toEqual({
      where: { id: "web-1", webinarPlanId: "wplan-1" },
    });
  });

  it("refuses the plan's owner with a typed 409 before any gateway order", async () => {
    setup("cons-profile", lookup("cons-profile"));
    expect(await checkout()).toMatchObject({
      httpStatus: 409,
      code: "SELF_BOOKING",
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    // The in-lock read loads the profile it compares, or the guard reads undefined.
    const userReads = calls.filter((call) => call.path === "user.findUnique");
    expect(userReads.at(-1)?.args).toMatchObject({
      include: { consultantProfile: { select: { id: true } } },
    });
  });

  it("refuses a PENDING or ACCEPTED collaborator, even on a plan with no owner", async () => {
    setup("buyer-cp", lookup(null, ["buyer-cp"]));
    expect(await checkout()).toMatchObject({ code: "SELF_BOOKING" });
    const planRead = calls.find(
      (call) => call.path === "webinarPlan.findUnique",
    );
    expect(planRead?.args).toMatchObject({
      select: {
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
    });
  });

  it("runs before the ADR-18 panel and exclusivity checks, on every paid path", async () => {
    setup("cons-profile", lookup("cons-profile"), orgMember());
    expect(await checkout("org-1")).toMatchObject({ code: "SELF_BOOKING" });
    expect(called("programConsultantAllowlist.findMany")).toBe(false);
    expect(called("membership.findFirst")).toBe(false);
  });

  it("still allows a plan owned by someone else, through the panel check", async () => {
    setup("other-cp", lookup("cons-profile"), orgMember());
    expect(await checkout("org-1")).toBeNull();
    expect(called("programConsultantAllowlist.findMany")).toBe(true);
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  });
});
