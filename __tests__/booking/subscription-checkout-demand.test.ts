/**
 * @jest-environment node
 */

// Invariant: a plan checkout is refused for a full expert before any gateway
// order exists, the commit re-checks under the same per-expert lock, and two
// buyers of one expert serialise from the check through the commit.

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mintOrder,
  mockCreatePaymentIntent as createPaymentIntent,
  silenceConsole,
} from "./repro/checkout-harness/mocks/setup";

jest.mock("../../lib/payments/checkout/subscription-demand", () => ({
  ...jest.requireActual("../../lib/payments/checkout/subscription-demand"),
  assertSubscriptionDemandRoom: jest.fn(),
}));

import { handleCheckout } from "../../lib/payments/checkout";
import { assertSubscriptionDemandRoom } from "../../lib/payments/checkout/subscription-demand";
import { resetDouble } from "./repro/checkout-harness/setup";
import { lockRequestCap, unlockRequestCap } from "../../utils/appointmentlock";

const demandRoom = assertSubscriptionDemandRoom as jest.Mock;
const START = new Date(Date.now() + 9 * 24 * 3600_000);
const plan = {
  id: "plan-1",
  price: 300_000,
  priceCurrency: "INR",
  sessionsPerWeek: 3,
  sessionDurationInHours: 1,
  totalSessions: 12,
  durationInMonths: 1,
  durationInWeeks: null,
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
    user: { id: "cons-user", timezone: "Asia/Kolkata" },
  },
};
const refusal = (code: string) =>
  Object.assign(new Error(`refused: ${code}`), { httpStatus: 409, code });
/** The rows a subscription checkout reads on the in-memory double. */
const rows = {
  "user.findUnique": () => buyerRow(),
  "subscriptionPlan.findUnique": () => plan,
  "cancellationPolicy.findUnique": () => ({ id: "platform-policy" }),
};
const checkout = (userId = "buyer") =>
  handleCheckout(
    buildCheckoutInput({
      appointmentType: "SUBSCRIPTION",
      schedulingPeriodStartsAt: START.toISOString(),
    }),
    userId,
  ).then(
    () => null,
    (caught: unknown) => caught,
  );

beforeEach(() => {
  mintOrder("order_1");
  demandRoom.mockReset();
  resetDouble(rows);
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

it.each(["PLAN_CLIENTS_FULL", "NOT_PLACEABLE"])(
  "a %s refusal reaches the buyer before any gateway order",
  async (code) => {
    demandRoom.mockRejectedValueOnce(refusal(code));
    expect(await checkout()).toMatchObject({ httpStatus: 409, code });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(demandRoom).toHaveBeenCalledTimes(1);
  },
);

it("the commit still refuses a sale that landed after the pre-check", async () => {
  demandRoom
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(refusal("PLAN_CLIENTS_FULL"));
  expect(await checkout()).toMatchObject({ code: "PLAN_CLIENTS_FULL" });
  expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  expect(demandRoom).toHaveBeenCalledTimes(2);
});

it("a second buyer of the same expert is checked only after the first commits", async () => {
  // A one-holder request-cap key that waits, like the Redis lock.
  let holder: Promise<void> | null = null;
  let release: () => void = () => {};
  (lockRequestCap as jest.Mock).mockImplementation(async () => {
    while (holder) await holder;
    holder = new Promise<void>((done) => {
      release = () => {
        holder = null;
        done();
      };
    });
    return { key: "request-cap:cons-profile" };
  });
  (unlockRequestCap as jest.Mock).mockImplementation(async () => release());

  // One client slot left: the first committed hold fills it.
  let committedHolds = 0;
  let resumeFirstCommit: () => void = () => {};
  const firstCommitPaused = new Promise<void>((resume) => {
    resumeFirstCommit = resume;
  });
  const order: string[] = [];
  demandRoom.mockImplementation(async () => {
    order.push(`check:${committedHolds}`);
    if (committedHolds >= 1) throw refusal("PLAN_CLIENTS_FULL");
  });
  resetDouble({
    ...rows,
    "subscription.create": async (args) => {
      order.push("commit");
      if (committedHolds === 0) await firstCommitPaused;
      committedHolds += 1;
      return {
        id: `sub-${committedHolds}`,
        ...(args as { data: object }).data,
      };
    },
  });

  const first = checkout("buyer-1");
  const second = checkout("buyer-2");
  await new Promise((tick) => setTimeout(tick, 50));
  // The second buyer has not reached its check while the first holds the key.
  expect(order).toEqual(["check:0", "check:0", "commit"]);
  resumeFirstCommit();

  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
  expect(secondOutcome).toMatchObject({ code: "PLAN_CLIENTS_FULL" });
  expect(order.slice(3)).toEqual(["check:1"]);
  expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  // The first buyer's checkout succeeded: `checkout` resolves null on success.
  expect(firstOutcome).toBeNull();
});
