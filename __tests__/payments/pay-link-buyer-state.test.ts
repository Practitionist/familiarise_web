/**
 * @jest-environment node
 */

/**
 * An approval or trial pay-link order records the buyer's GST state before it
 * is paid: a domestic PENDING order with none must declare one, by CAS.
 */

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "user-1" } })),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  cancelPendingLimiter: {},
}));
jest.mock("../../lib/payments/operations/cancel-pending", () => ({
  cancelPendingCheckout: jest.fn(),
}));
jest.mock("../../lib/booking/approve-request", () => ({
  mintApprovalPaymentAfterCommit: jest.fn(),
}));
jest.mock("../../lib/trials/pay-link", () => ({
  remintTrialPayLink: jest.fn(),
}));

const paymentUpdateMany = jest.fn(async () => ({ count: 1 }));
const profileUpdateMany = jest.fn(async () => ({ count: 1 }));
const txFindPayment = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        payment: { updateMany: paymentUpdateMany, findUnique: txFindPayment },
        consulteeProfile: { updateMany: profileUpdateMany },
      }),
    ),
  },
}));

import { NextRequest } from "next/server";

import prisma from "../../lib/prisma";
import { PATCH } from "../../app/api/checkout/pending/[paymentId]/route";

const findPayment = prisma.payment.findUnique as jest.Mock;

function pendingOrder(extra: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    deletedAt: null,
    paymentStatus: "PENDING",
    buyerCountry: "IN",
    consumerStateCode: null,
    user: { consulteeProfile: { billingStateCode: null } },
    ...extra,
  };
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/checkout/pending/pay-1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ paymentId: "pay-1" }) },
  );
}

beforeEach(() => jest.clearAllMocks());

describe("PATCH /api/checkout/pending/[paymentId] (buyer state)", () => {
  it("refuses a domestic order with no state when none is sent", async () => {
    findPayment.mockResolvedValueOnce(pendingOrder());

    const res = await patch({});

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/billing state/i),
      field: "consumerStateCode",
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("writes the state by CAS on a stateless PENDING row and saves it to the profile", async () => {
    findPayment.mockResolvedValueOnce(pendingOrder());

    const res = await patch({ consumerStateCode: "29" });

    expect(res.status).toBe(200);
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", paymentStatus: "PENDING", consumerStateCode: null },
      data: { consumerStateCode: "29" },
    });
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { billingStateCode: "29" },
    });
  });

  it.each([
    ["was cancelled", { paymentStatus: "CANCELLED", consumerStateCode: null }],
    [
      "was paid with no state",
      { paymentStatus: "SUCCEEDED", consumerStateCode: null },
    ],
  ])(
    "refuses with 409 when the CAS loses because the order %s",
    async (_label, now) => {
      findPayment.mockResolvedValueOnce(pendingOrder());
      paymentUpdateMany.mockResolvedValueOnce({ count: 0 });
      txFindPayment.mockResolvedValueOnce(now);

      const res = await patch({ consumerStateCode: "29" });

      expect(res.status).toBe(409);
      expect(profileUpdateMany).not.toHaveBeenCalled();
    },
  );

  it("accepts a lost CAS when a concurrent call already recorded a state on the open order", async () => {
    findPayment.mockResolvedValueOnce(pendingOrder());
    paymentUpdateMany.mockResolvedValueOnce({ count: 0 });
    txFindPayment.mockResolvedValueOnce({
      paymentStatus: "PENDING",
      consumerStateCode: "29",
    });

    const res = await patch({ consumerStateCode: "29" });

    expect(res.status).toBe(200);
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a row that already has a state", { consumerStateCode: "29" }],
    ["an international buyer", { buyerCountry: "GB" }],
  ])("does not ask or write for %s", async (_label, extra) => {
    findPayment.mockResolvedValueOnce(pendingOrder(extra));

    const res = await patch({});

    expect(res.status).toBe(200);
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });
});
