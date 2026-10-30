/**
 * @jest-environment node
 */

/**
 * An expert, admin or host-org cancel always refunds the buyer in full: the org
 * policy API refuses any other figure and the engine ignores an older stored one.
 */
const mockTransaction = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "mem-1", userId: "user-owner" },
  })),
}));

import { PUT } from "@/app/api/organizations/[orgId]/cancellation-policy/route";
import { computeRefundPct } from "@/lib/payments/operations/cancellation-policy";
import { termsFromPolicyRow } from "@/lib/payments/operations/cancellation-policy-store";

const LADDER = [
  { hoursBefore: 24, refundPct: 100 },
  { hoursBefore: 0, refundPct: 0 },
];

function put(body: unknown) {
  return PUT(
    new Request(
      "http://localhost/api/organizations/org-1/cancellation-policy",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    ) as never,
    { params: Promise.resolve({ orgId: "org-1" }) },
  );
}

describe("expert-side cancel refund is pinned to 100%", () => {
  it("the org policy API refuses a consultant-initiated figure below 100", async () => {
    const res = await put({ tiers: LADDER, consultantInitiatedPct: 0 });
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("an older stored row below 100 still refunds an expert cancel in full", () => {
    const terms = termsFromPolicyRow({
      id: "pol-1",
      organizationId: "org-1",
      version: 3,
      consultantInitiatedBps: 0,
      tiers: [
        { hoursBefore: 24, refundBps: 10_000 },
        { hoursBefore: 0, refundBps: 0 },
      ],
    });
    expect(terms.consultantInitiatedPct).toBe(100);
    expect(computeRefundPct(terms, 1, true)).toBe(100);
  });
});
