/**
 * @jest-environment node
 */

/**
 * #1775 C-7 — a paid trial is charged at request: the POST creates a
 * placeholder appointment (no sessions) and mints the order against it after
 * the commit; a free trial creates neither.
 */

const createIntent = jest.fn(async () => ({
  paymentIntentId: "order_1",
  paymentId: "pay_1",
  checkoutUrl: "order_1",
}));
jest.mock("../../lib/payments/operations/approval-payment", () => ({
  createApprovalPaymentIntent: (...a: unknown[]) => createIntent(...(a as [])),
}));
jest.mock("../../lib/trials/pay-link", () => ({
  persistTrialPayLink: jest.fn(async () => "/checkout/pay/pay_1"),
}));
jest.mock("../../lib/booking/participants", () => ({
  recordParticipants: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: {
      user: { id: "u-buyer", role: "CONSULTEE", consulteeProfileId: "cp-b" },
    },
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  trialRequestLimiter: {},
}));
jest.mock("../../lib/activity/log-activity", () => ({
  logTrialRequested: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({ notifyTrialRequested: jest.fn() }));

const plan = { trialPriceInPaise: 0 };
const appointmentCreate = jest.fn(async () => ({ id: "apt-1" }));
jest.mock("../../lib/prisma", () => {
  const tx = {
    appointment: {
      create: (...a: unknown[]) => appointmentCreate(...(a as [])),
    },
    trial: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "trial-1",
        status: "PENDING",
        appointmentId: data.appointmentId,
        consulteeProfile: { user: { name: "B" } },
        consultantProfile: { user: { id: "u-expert", name: "E" } },
      })),
    },
  };
  return {
    __esModule: true,
    default: {
      trial: { findUnique: jest.fn(async () => null) },
      subscriptionPlan: {
        findUnique: jest.fn(async () => ({
          id: "plan-1",
          title: "Mentorship",
          consultantProfileId: "cp-e",
          trialEnabled: true,
          trialPriceInPaise: plan.trialPriceInPaise,
          consultantProfile: { user: { id: "u-expert" } },
        })),
      },
      consulteeProfile: {
        findUnique: jest.fn(async () => ({
          user: { id: "u-buyer", name: "B", image: null },
        })),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/trials/route";

const post = () =>
  POST(
    new NextRequest("http://localhost/api/trials", {
      method: "POST",
      body: JSON.stringify({
        consulteeProfileId: "cp-b",
        consultantProfileId: "cp-e",
        subscriptionPlanId: "plan-1",
      }),
    }),
  );

beforeEach(() => jest.clearAllMocks());

it("a paid trial gets a session-less placeholder and an order minted against it", async () => {
  plan.trialPriceInPaise = 50_000;
  const res = await post();
  expect(res.status).toBe(201);
  expect(appointmentCreate).toHaveBeenCalledWith({
    data: { appointmentType: "TRIAL" },
    select: { id: true },
  });
  expect(createIntent).toHaveBeenCalledWith(
    expect.objectContaining({ trialId: "trial-1", appointmentId: "apt-1" }),
  );
  expect((await res.json()).checkoutUrl).toBe("/checkout/plans/trial/trial-1");
});

it("a free trial creates neither", async () => {
  plan.trialPriceInPaise = 0;
  await post();
  expect(appointmentCreate).not.toHaveBeenCalled();
  expect(createIntent).not.toHaveBeenCalled();
});

// #1775 C-10 — accept requires the capture; a paid trial's session goes on
// the request-time placeholder and nothing is minted on accept.
describe("trial accept", () => {
  const route = jest
    .requireActual<typeof import("fs")>("fs")
    .readFileSync(`${process.cwd()}/app/api/trials/[trialId]/route.ts`, "utf8");

  it("refuses an unpaid paid trial with TRIAL_UNPAID", () => {
    const guard = route.split('"TRIAL_UNPAID"')[0].slice(-400);
    expect(guard).toContain("paidTrial &&");
    expect(route).toContain("existingTrial.appointmentId !== null;");
    expect(guard).toContain("existingTrial.paymentId === null");
  });

  it("places the session on the existing appointment and never mints", () => {
    const accept = route.split("async function acceptPaidTrial(")[1];
    expect(accept).toContain("tx.appointmentOccurrence.create({");
    expect(accept).toContain("data: { appointmentId, ...session }");
    expect(route).toContain("whereAnd: { paymentId: { not: null } }");
    expect(route).not.toContain("createApprovalPaymentIntent");
  });
});
