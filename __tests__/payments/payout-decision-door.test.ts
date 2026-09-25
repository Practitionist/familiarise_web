/**
 * @jest-environment node
 */

/**
 * #1771 K-4 — approving a payout needs a reason like rejecting one does, and
 * a decision writes one OpsActionLog row naming the decision.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));
const approvePayout = jest.fn(async () => {});
jest.mock("../../lib/payments/payouts", () => ({
  approvePayout: (...a: unknown[]) => approvePayout(...(a as [])),
  rejectPayout: jest.fn(),
  getPayoutById: jest.fn(),
}));
const create = jest.fn(async (_a: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findUnique: jest.fn(async () => ({
        status: "PENDING",
        kind: "INSTANT",
        amount: 900000,
      })),
    },
    opsActionLog: { create: (a: unknown) => create(a) },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/payouts/[id]/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api/admin/payouts/po_1", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "po_1" } as never) },
  );

beforeEach(() => jest.clearAllMocks());

it("refuses an approval without a reason before touching the payout", async () => {
  const res = await post({ action: "approve" });
  expect(res.status).toBe(400);
  expect(approvePayout).not.toHaveBeenCalled();
});

it("approves with a reason and logs payout.approve once", async () => {
  const res = await post({ action: "approve", reason: "verified bank proof" });
  expect(res.status).toBe(200);
  expect(approvePayout).toHaveBeenCalledWith("po_1", "admin_1");
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toMatchObject({
    data: { action: "payout.approve", targetId: "po_1", actorRole: "ADMIN" },
  });
});
