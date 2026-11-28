/**
 * @jest-environment node
 */

/**
 * `/recover` is an ADMIN, step-up, reasoned door, and it only books the plan,
 * event and appointment type the buyer's Razorpay order was minted for.
 */

import { NextRequest, NextResponse } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

let mockRole = "ADMIN";
let mockSessionCreatedAt = new Date();
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async (surface: string) => {
    const { hasBackofficePermission } = jest.requireActual(
      "../../lib/auth/backoffice-permissions",
    );
    if (!hasBackofficePermission(mockRole, surface)) {
      return { error: NextResponse.json({}, { status: 403 }) };
    }
    return {
      session: {
        user: { id: "admin_1", role: mockRole },
        session: { createdAt: mockSessionCreatedAt },
      },
    };
  }),
}));

const opsLogCreate = jest.fn(async (_a: unknown) => ({ id: "row" }));
const paymentFindUnique = jest.fn();
const paymentCount = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (a: unknown) => paymentFindUnique(a),
      count: (a: unknown) => paymentCount(a),
    },
    opsActionLog: { create: (a: unknown) => opsLogCreate(a) },
  },
}));

const fetchRazorpayOrder = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  fetchRazorpayOrder: (...a: unknown[]) => fetchRazorpayOrder(...a),
}));
const handlePaymentSuccess = jest.fn(async (..._a: unknown[]) => "confirmed");
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: (...a: unknown[]) => handlePaymentSuccess(...a),
  RecoveryAlreadyDoneError: class extends Error {},
  RecoveryRefusedError: class extends Error {},
}));

import { POST } from "@/app/api/payments/[paymentId]/recover/route";

const PLAN = "cjld2cyuq0000t3rmniod1foy";
const OTHER_PLAN = "cjld2cyuq0000t3rmniod1zzz";
const CHECKOUT_NOTES = {
  appointmentId: "pending",
  appointmentType: "CONSULTATION",
  userId: "Xk9aQ2mPz7LrT4bN8vWc3HdY6sFj1GeU",
  planId: PLAN,
  startsAt: "2026-06-12T10:00:00.000Z",
  endsAt: "2026-06-12T10:30:00.000Z",
};

const recover = (metadata: Record<string, string>) =>
  POST(
    new NextRequest("https://x.test/api/payments/pay_1/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata, reason: "notes failed validation" }),
    }),
    { params: Promise.resolve({ paymentId: "pay_1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "ADMIN";
  mockSessionCreatedAt = new Date();
  paymentCount.mockResolvedValue(1);
  paymentFindUnique.mockResolvedValue({
    id: "pay_1",
    paymentIntent: "order_abc",
    paymentGateway: "RAZORPAY",
    paymentStatus: "SUCCEEDED",
    appointmentId: null,
  });
  fetchRazorpayOrder.mockResolvedValue({
    id: "order_abc",
    amount: 50_000,
    currency: "INR",
    status: "paid",
    notes: CHECKOUT_NOTES,
  });
});

it("refuses STAFF", async () => {
  mockRole = "STAFF";
  expect((await recover(CHECKOUT_NOTES)).status).toBe(403);
  expect(handlePaymentSuccess).not.toHaveBeenCalled();
});

it("refuses an ADMIN session that has not re-authenticated", async () => {
  mockSessionCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
  const res = await recover(CHECKOUT_NOTES);
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("REAUTH_REQUIRED");
  expect(handlePaymentSuccess).not.toHaveBeenCalled();
});

it("refuses a plan the buyer did not pay for, before any earnings are written", async () => {
  const res = await recover({ ...CHECKOUT_NOTES, planId: OTHER_PLAN });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("RECOVER_TARGET_MISMATCH");
  expect(handlePaymentSuccess).not.toHaveBeenCalled();
});

it("refuses a capture that was refunded, marked for refund or disputed", async () => {
  paymentCount.mockResolvedValue(0);
  const res = await recover(CHECKOUT_NOTES);
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("PAYMENT_RETURNED");
  expect(handlePaymentSuccess).not.toHaveBeenCalled();
});

it("recovers the paid-for booking and writes an OpsActionLog row", async () => {
  paymentFindUnique
    .mockResolvedValueOnce({
      id: "pay_1",
      paymentIntent: "order_abc",
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      appointmentId: null,
    })
    .mockResolvedValueOnce({
      id: "pay_1",
      appointmentId: "appt_1",
      paymentStatus: "SUCCEEDED",
      appointment: { id: "appt_1" },
    });
  const res = await recover(CHECKOUT_NOTES);
  expect(res.status).toBe(200);
  expect(handlePaymentSuccess).toHaveBeenCalledWith(
    "order_abc",
    CHECKOUT_NOTES,
    undefined,
    undefined,
    { recover: true },
  );
  expect(opsLogCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        surface: "payments.manage",
        action: "payment.recover",
        targetKind: "Payment",
        targetId: "pay_1",
        reason: "notes failed validation",
      }),
    }),
  );
});

it("answers 409 CAPTURE_IN_PROGRESS while another door holds the order's capture lock", async () => {
  handlePaymentSuccess.mockRejectedValueOnce(
    Object.assign(new Error("canceling statement due to lock timeout"), {
      name: "DriverAdapterError",
      cause: { kind: "postgres", code: "55P03", originalCode: "55P03" },
    }),
  );
  const res = await recover(CHECKOUT_NOTES);
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("CAPTURE_IN_PROGRESS");
});
