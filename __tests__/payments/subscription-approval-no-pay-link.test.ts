/**
 * @jest-environment node
 */

// Invariant: a subscription is paid at purchase, so no approval, allocation,
// allocation replay or pay page ever mints it a pay link.

import "../booking-algorithm/setup";

const mockCreateApprovalPaymentIntent = jest.fn();
jest.mock("../../lib/payments/operations/approval-payment", () => ({
  ...jest.requireActual("../../lib/payments/operations/approval-payment"),
  createApprovalPaymentIntent: (...a: unknown[]) =>
    mockCreateApprovalPaymentIntent(...a),
}));
const mockPaymentRow = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentRow(...a),
      findFirst: jest.fn(async () => null),
    },
  },
}));

import { updateEventStatus } from "../../lib/booking/allocation/event-data";
import { replayOutcome } from "../../lib/booking/allocation/idempotency";
import { resolvePayPage } from "../../lib/payments/pay-page";
import type { EventConfig } from "../../utils/scheduling-engine/types";
import type { PrismaLike, Tx } from "../../lib/prisma";

const unpaid = { code: "SUBSCRIPTION_UNPAID", httpStatus: 409 };

afterEach(() => mockCreateApprovalPaymentIntent.mockReset());

it("allocating an unpaid plan is refused and never parks it awaiting payment", async () => {
  const updateMany = jest.fn(async () => ({ count: 0 }));
  const tx = {
    subscription: {
      findUnique: jest.fn(async () => ({
        status: "PENDING",
        appointment: null,
      })),
      updateMany,
      count: jest.fn(async () => 1),
    },
    bookingStatusHistory: { create: jest.fn() },
  } as unknown as Tx;

  await expect(
    updateEventStatus(
      tx,
      "subscription",
      "sub-1",
      new Date(),
      {} as EventConfig,
    ),
  ).rejects.toMatchObject(unpaid);
  const targets = updateMany.mock.calls.map(
    (call) =>
      (call as unknown as [{ data: { status: string } }])[0].data.status,
  );
  expect(targets).toEqual(["APPROVED"]);
  expect(mockCreateApprovalPaymentIntent).not.toHaveBeenCalled();
});

it("replaying the allocation of a legacy unpaid plan answers the same refusal", async () => {
  const db = {
    subscription: {
      findUnique: jest.fn(async () => ({ status: "APPROVED_PENDING_PAYMENT" })),
    },
  } as unknown as PrismaLike;
  await expect(
    replayOutcome("subscription", "sub-1", db),
  ).rejects.toMatchObject(unpaid);
});

it("the pay page never re-mints a lapsed subscription order", async () => {
  mockPaymentRow.mockResolvedValue({
    id: "pay-1",
    userId: "buyer",
    deletedAt: null,
    paymentStatus: "EXPIRED",
    paymentGateway: "RAZORPAY",
    paymentIntent: "order_1",
    expiresAt: new Date(Date.now() - 60_000),
    appointmentId: "appt-1",
    user: { consulteeProfile: { id: "cp-buyer", billingStateCode: null } },
    appointment: {
      consultation: null,
      trial: null,
      subscription: {
        id: "sub-1",
        status: "APPROVED_PENDING_PAYMENT",
        pendingPaymentUrl: null,
        subscriptionPlan: {
          consultantProfile: {
            verificationStatus: "VERIFIED",
            deletedAt: null,
          },
        },
      },
    },
  });
  await expect(resolvePayPage("pay-1", "buyer")).resolves.toMatchObject({
    kind: "unpayable",
  });
  expect(mockCreateApprovalPaymentIntent).not.toHaveBeenCalled();
});
