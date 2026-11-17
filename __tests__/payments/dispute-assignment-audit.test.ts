/** @jest-environment node */
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import { NextRequest, NextResponse } from "next/server";
import prisma from "../../lib/prisma";
import { requireBackofficeSurface } from "../../lib/auth-helpers";
import { PATCH } from "../../app/api/admin/disputes/[disputeId]/route";

const updatedAt = new Date("2026-10-01T00:00:00Z");
const tx = {
  dispute: { findUnique: jest.fn(), updateMany: jest.fn() },
  user: { findFirst: jest.fn() },
  opsActionLog: { create: jest.fn() },
};
const patch = (body: unknown) =>
  PATCH(
    new NextRequest("https://test/api/admin/disputes/d1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ disputeId: "d1" }) },
  );
const assignment = {
  assignedToUserId: "admin-2",
  expectedUpdatedAt: updatedAt.toISOString(),
  reason: "Evidence owner confirmed",
};

beforeEach(() => {
  jest.clearAllMocks();
  (requireBackofficeSurface as jest.Mock).mockResolvedValue({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  });
  (prisma.$transaction as jest.Mock).mockImplementation(
    (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  );
  tx.dispute.findUnique.mockResolvedValue({
    id: "d1",
    assignedToUserId: null,
    updatedAt,
  });
  tx.dispute.updateMany.mockResolvedValue({ count: 1 });
  tx.user.findFirst.mockResolvedValue({ id: "admin-2" });
  tx.opsActionLog.create.mockResolvedValue({ id: "audit-1" });
});

it("assigns an active admin using CAS and writes actor/reason/before/after in the same transaction", async () => {
  expect((await patch(assignment)).status).toBe(200);
  expect(requireBackofficeSurface).toHaveBeenCalledWith("disputes.manage", {
    expectUser: true,
  });
  expect(tx.user.findFirst).toHaveBeenCalledWith({
    where: { id: "admin-2", role: "ADMIN", banned: false },
    select: { id: true },
  });
  expect(tx.dispute.updateMany).toHaveBeenCalledWith({
    where: { id: "d1", assignedToUserId: null, updatedAt },
    data: { assignedToUserId: "admin-2" },
  });
  expect(tx.opsActionLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        actorUserId: "admin-1",
        actorRole: "ADMIN",
        surface: "disputes.manage",
        action: "dispute.assign",
        targetKind: "Dispute",
        targetId: "d1",
        reason: assignment.reason,
        before: { assignedToUserId: null },
        after: { assignedToUserId: "admin-2" },
      }),
    }),
  );
});

it("refuses a stale view without writing an audit success row", async () => {
  tx.dispute.updateMany.mockResolvedValue({ count: 0 });
  expect((await patch(assignment)).status).toBe(409);
  expect(tx.opsActionLog.create).not.toHaveBeenCalled();
});

it("rejects a banned or non-admin assignee before any assignment write", async () => {
  tx.user.findFirst.mockResolvedValue(null);
  expect((await patch(assignment)).status).toBe(400);
  expect(tx.dispute.updateMany).not.toHaveBeenCalled();
});

it("requires a reason before opening the transaction", async () => {
  expect((await patch({ ...assignment, reason: "" })).status).toBe(400);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("preserves a surface authorization or mandatory 2FA refusal", async () => {
  (requireBackofficeSurface as jest.Mock).mockResolvedValue({
    error: NextResponse.json(
      { error: "Set up two-factor authentication" },
      { status: 428 },
    ),
  });
  expect((await patch(assignment)).status).toBe(428);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
