/**
 * @jest-environment node
 */

/**
 * #1584 P1-GW01c — POST /api/organizations/[orgId]/payouts accepted
 * `paymentGateway: "STRIPE" | "CARD"`, and `submitOrgPayout` claims
 * PENDING→PROCESSING before it checks the gateway while the re-drive skips
 * non-RAZORPAY rows, so such a batch stranded in PROCESSING. The door now
 * refuses anything but RAZORPAY with a typed 400 (#1744 tracks the service-
 * side ordering; that file belongs to an open PR and is untouched here).
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
}));
jest.mock("../../lib/auth/billing-admin-gate", () => ({
  requireOrgBillingAdminOrOwner: jest.fn(async () => ({
    org: { canHost: true },
    member: { id: "mem_1" },
  })),
}));
const createOrgPayoutBatch = jest.fn();
jest.mock("../../lib/payments/payouts/org-payout-service", () => ({
  createOrgPayoutBatch: (...a: unknown[]) => createOrgPayoutBatch(...a),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { organizationPayout: { findUnique: jest.fn() } },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/organizations/[orgId]/payouts/route";

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/organizations/org_1/payouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        ...body,
      }),
    }),
    { params: Promise.resolve({ orgId: "org_1" }) },
  );
}

beforeEach(() => jest.clearAllMocks());

describe("org payout batches refuse non-RazorpayX gateways (#1584 P1-GW01c)", () => {
  it("answers 400 GATEWAY_UNSUPPORTED_FOR_PAYOUT for STRIPE and never creates the batch", async () => {
    const res = await post({ paymentGateway: "STRIPE" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("GATEWAY_UNSUPPORTED_FOR_PAYOUT");
    expect(createOrgPayoutBatch).not.toHaveBeenCalled();
  });
});
