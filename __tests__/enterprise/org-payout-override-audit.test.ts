/**
 * @jest-environment node
 */

/**
 * #1584 P1-AU01 — a manual PENDING → APPROVED move on an org payout was
 * logged as PAYOUT_INITIATED, the action the cron writes when it actually
 * sends money, so the audit timeline showed two initiations for one payout.
 * Pins that the override route writes PAYOUT_STATUS_OVERRIDDEN.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "mem_1", role: "OWNER" },
    session: { session: { createdAt: new Date() } },
    org: { slug: "acme" },
  })),
}));

const auditCreate = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        organizationPayout: {
          findFirst: async () => ({ id: "po_1", status: "PENDING" }),
          updateMany: async () => ({ count: 1 }),
          findUniqueOrThrow: async () => ({ id: "po_1", status: "APPROVED" }),
        },
        organizationEarnings: { updateMany: async () => ({ count: 0 }) },
        // No PAYOUT_INITIATED actor: a cron-built batch has no human creator,
        // so the two-person rule (#1851 decision 4) does not apply.
        orgAuditLog: { create: auditCreate, findFirst: async () => null },
      }),
  },
}));

import { NextRequest } from "next/server";

import { PATCH } from "../../app/api/organizations/[orgId]/payouts/[payoutId]/route";

describe("PATCH /api/organizations/[orgId]/payouts/[payoutId]", () => {
  it("logs a manual APPROVED move as PAYOUT_STATUS_OVERRIDDEN", async () => {
    const req = new NextRequest(
      "https://x.test/api/organizations/org_1/payouts/po_1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "APPROVED" }),
      },
    );

    const res = await PATCH(req, {
      params: Promise.resolve({ orgId: "org_1", payoutId: "po_1" }),
    });

    expect(res.status).toBe(200);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      category: "PAYOUT",
      action: "PAYOUT_STATUS_OVERRIDDEN",
    });
  });
});
