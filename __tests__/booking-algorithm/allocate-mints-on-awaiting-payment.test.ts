/**
 * @jest-environment node
 */

/**
 * #1775 B-9 — the allocate handler mints the pay order when the service
 * landed the request in APPROVED_PENDING_PAYMENT, and never when it landed
 * in APPROVED; the shared mint block reuses a link that is already live on
 * the row instead of minting a second order (a re-allocation of an
 * awaiting-payment booking).
 */

const allocate = jest.fn();
jest.mock("../../utils/scheduling-engine/SchedulingService", () => ({
  SchedulingService: { allocate: (...a: unknown[]) => allocate(...a) },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "u-consultant", role: "CONSULTANT" } },
  }),
  authorizeEventAccess: async () => null,
  isEventConsultant: async () => true,
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));
const mintAfterCommit = jest.fn();
jest.mock("../../lib/booking/approve-request", () => ({
  mintApprovalPaymentAfterCommit: (...a: unknown[]) => mintAfterCommit(...a),
}));
const recordSystemError = jest.fn().mockResolvedValue(undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => recordSystemError(...a),
}));

import { NextRequest } from "next/server";
import { handleAllocate } from "../../lib/scheduling/allocate-route";

const C_ID = "clzzzzzzz000consultation1";
const post = () =>
  handleAllocate(
    new NextRequest("http://localhost/x", {
      method: "PATCH",
      body: JSON.stringify({ isAuto: false, useRequestedSlots: true }),
      headers: { "content-type": "application/json" },
    }),
    "consultation",
    C_ID,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mintAfterCommit.mockResolvedValue({
    status: "minted",
    paymentUrl: "https://rzp.io/l/abc",
    paymentAmount: 236_197,
    paymentCurrency: "INR",
  });
});

describe("handleAllocate (#1775 B-9)", () => {
  it("awaiting_payment → one mint before the response, awaitingPayment: true", async () => {
    allocate.mockResolvedValue({
      success: true,
      outcome: "awaiting_payment",
      appointments: [],
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ awaitingPayment: true });
    expect(mintAfterCommit).toHaveBeenCalledTimes(1);
    expect(mintAfterCommit).toHaveBeenCalledWith({
      kind: "consultation",
      id: C_ID,
    });
    expect(recordSystemError).not.toHaveBeenCalled();
  });

  it("approved (paid) → no mint, awaitingPayment: false", async () => {
    allocate.mockResolvedValue({
      success: true,
      outcome: "approved",
      appointments: [],
    });
    const res = await post();
    expect(await res.json()).toMatchObject({ awaitingPayment: false });
    expect(mintAfterCommit).not.toHaveBeenCalled();
  });

  it("a failed mint is recorded and answered as a typed 502, never a 200 (#1775 C-1)", async () => {
    allocate.mockResolvedValue({
      success: true,
      outcome: "awaiting_payment",
      appointments: [],
    });
    mintAfterCommit.mockResolvedValue({
      status: "mint_failed",
      error: new Error("gateway down"),
    });
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      errorCode: "PAYMENT_LINK_FAILED",
    });
    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT" }),
    );
  });
});

describe("mintApprovalPaymentAfterCommit — a live link is reused (#1775 B-9)", () => {
  it("re-allocation of APPROVED_PENDING_PAYMENT with a live link mints nothing", async () => {
    jest.resetModules();
    const findUnique = jest.fn().mockResolvedValue({
      id: C_ID,
      status: "APPROVED_PENDING_PAYMENT",
      pendingPaymentUrl: "https://rzp.io/l/live",
      requestNotes: null,
      consultationPlan: { id: "plan-1", consultantProfile: { user: {} } },
      requestedBy: { user: { id: "u-buyer", name: "Buyer", email: "b@t" } },
      appointment: { id: "a-1", organizationId: null, occurrences: [] },
    });
    jest.doMock("../../lib/prisma", () => ({
      __esModule: true,
      default: {
        consultation: { findUnique, updateMany: jest.fn() },
        subscription: { findUnique: jest.fn(), updateMany: jest.fn() },
      },
    }));
    const createApprovalPaymentIntent = jest.fn();
    jest.doMock("../../lib/payments/operations/approval-payment", () => ({
      ApprovalWindowLapsedError: class extends Error {},
      createApprovalPaymentIntent: (...a: unknown[]) =>
        createApprovalPaymentIntent(...a),
    }));
    const { mintApprovalPaymentAfterCommit } = jest.requireActual<
      typeof import("../../lib/booking/approve-request")
    >("../../lib/booking/approve-request");
    const out = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: C_ID,
    });
    expect(out).toEqual({
      status: "already_live",
      paymentUrl: "https://rzp.io/l/live",
    });
    expect(createApprovalPaymentIntent).not.toHaveBeenCalled();
  });
});
