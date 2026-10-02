/**
 * @jest-environment node
 */

/**
 * #1846 — the Org › Payouts routing endpoint lets a Billing admin change
 * where an expert is paid, and refuses a Maintainer, who can manage members
 * but holds no finance right.
 */

jest.mock("../../lib/prisma", () => {
  const membership = { findFirst: jest.fn(), updateMany: jest.fn() };
  const orgAuditLog = { create: jest.fn().mockResolvedValue({}) };
  return {
    __esModule: true,
    default: {
      membership,
      orgAuditLog,
      $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
        fn({ membership, orgAuditLog }),
      ),
    },
  };
});
jest.mock("../../lib/auth-helpers", () => ({ requireOrgAccess: jest.fn() }));

import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { PATCH } from "@/app/api/organizations/[orgId]/expert-payout-routing/route";

const db = prisma as unknown as {
  membership: { findFirst: jest.Mock; updateMany: jest.Mock };
  orgAuditLog: { create: jest.Mock };
};

function patchAs(role: string) {
  (requireOrgAccess as jest.Mock).mockResolvedValue({
    member: { id: "m-actor", role },
  });
  const req = new Request(
    "http://localhost/api/organizations/org-1/expert-payout-routing",
    {
      method: "PATCH",
      body: JSON.stringify({
        membershipId: "m-expert",
        payoutRecipient: "ORGANIZATION",
      }),
    },
  );
  return PATCH(req as unknown as NextRequest, {
    params: Promise.resolve({ orgId: "org-1" }),
  });
}

describe("PATCH expert-payout-routing — finance gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.membership.findFirst.mockResolvedValue({
      id: "m-expert",
      payoutRecipient: "SELF",
    });
    db.membership.updateMany.mockResolvedValue({ count: 1 });
  });

  it("lets a BILLING_ADMIN change it and writes the PAYOUT audit row", async () => {
    const res = await patchAs("BILLING_ADMIN");
    expect(res.status).toBe(200);
    expect(db.orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: "PAYOUT",
        targetMembershipId: "m-expert",
        details: { from: "SELF", to: "ORGANIZATION", viaRoleChange: false },
      }),
    });
  });

  it("refuses a MAINTAINER before touching the row", async () => {
    const res = await patchAs("MAINTAINER");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PAYOUT_RECIPIENT_REQUIRES_FINANCE");
    expect(db.membership.updateMany).not.toHaveBeenCalled();
  });
});
