/**
 * @jest-environment node
 */

/**
 * Staff read disputes without the evidence body, the billing details inside it
 * or internal notes; only a `disputes.manage` viewer gets evidence and the
 * payer's email, and only on the detail route.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => ({ id: "d1" })),
      count: jest.fn(async () => 0),
    },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { requirePrivilegedAuth } from "../../lib/auth-helpers";
import { GET as listDisputes } from "../../app/api/admin/disputes/route";
import { GET as readDispute } from "../../app/api/admin/disputes/[disputeId]/route";

const asRole = (role: "STAFF" | "ADMIN") =>
  (requirePrivilegedAuth as jest.Mock).mockResolvedValue({
    session: { user: { id: `${role}-1`, role } },
  });

beforeEach(() => jest.clearAllMocks());

describe("dispute views by role", () => {
  it.each(["STAFF", "ADMIN"] as const)(
    "list rows never select evidence or internal notes (%s)",
    async (role) => {
      asRole(role);
      await listDisputes(
        new NextRequest("http://localhost/api/admin/disputes?status=WON"),
      );
      const { select } = (prisma.dispute.findMany as jest.Mock).mock
        .calls[0][0];
      expect(select).not.toHaveProperty("evidence");
      expect(select).not.toHaveProperty("internalNotes");
      expect(select).toMatchObject({
        status: true,
        amountPaise: true,
        dueBy: true,
        evidenceSubmittedAt: true,
      });
    },
  );

  it("detail gives staff the submitted date but not the evidence or the payer's email", async () => {
    asRole("STAFF");
    await readDispute(
      new NextRequest("http://localhost/api/admin/disputes/d1"),
      {
        params: Promise.resolve({ disputeId: "d1" }),
      },
    );
    const { select } = (prisma.dispute.findUnique as jest.Mock).mock
      .calls[0][0];
    expect(select).not.toHaveProperty("evidence");
    expect(select).not.toHaveProperty("internalNotes");
    expect(select.evidenceSubmittedAt).toBe(true);
    expect(select.payment.select.user.select).not.toHaveProperty("email");
  });

  it("detail gives an admin the evidence and the payer's email", async () => {
    asRole("ADMIN");
    await readDispute(
      new NextRequest("http://localhost/api/admin/disputes/d1"),
      {
        params: Promise.resolve({ disputeId: "d1" }),
      },
    );
    const { select } = (prisma.dispute.findUnique as jest.Mock).mock
      .calls[0][0];
    expect(select.evidence).toBe(true);
    expect(select).not.toHaveProperty("internalNotes");
    expect(select.payment.select.user.select.email).toBe(true);
  });
});
