/**
 * @jest-environment node
 */

// #1771 row 7 — the org PUT forwards the account number to RazorpayX and
// never stores it; only the last four digits reach the row.
const upsert = jest.fn(async () => ({
  id: "opa1",
  version: 1,
  status: "PENDING_VERIFICATION",
}));
const tx = {
  organizationPayoutAccount: { findUnique: jest.fn(async () => null), upsert },
  orgAuditLog: { create: jest.fn(async () => ({})) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    organizationPayoutAccount: { findUniqueOrThrow: jest.fn(async () => ({})) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
  requireOrgOwner: jest.fn(async () => ({
    org: { canHost: true, billingEmail: null },
    member: { id: "m1" },
  })),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  getRazorpayPayoutsService: jest.fn(),
  isRazorpayPayoutsConfigured: () => false,
}));

import { NextRequest } from "next/server";
import { PUT } from "@/app/api/organizations/[orgId]/payout-account/route";

it("writes no account number, only the last four", async () => {
  const req = new NextRequest("http://localhost/api", {
    method: "PUT",
    body: JSON.stringify({
      accountHolderName: "Acme Studio",
      accountNumber: "123456789012",
      bankName: "HDFC",
      ifscCode: "HDFC0000001",
    }),
  });
  const res = await PUT(req, { params: Promise.resolve({ orgId: "o1" }) });

  expect(res.status).toBe(200);
  const written = JSON.stringify(upsert.mock.calls);
  expect(written).not.toContain("123456789012");
  expect(written).toContain('"accountNumberLast4":"9012"');
});
