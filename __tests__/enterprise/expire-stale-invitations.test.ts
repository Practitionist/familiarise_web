/**
 * @jest-environment node
 */

/**
 * Pin the stale-invitation cleanup contract (part of cleanup-auth-tokens):
 *
 *   - Only rows with `status = PENDING` AND `expiresAt < now` get
 *     flipped to 'expired'. Already-expired, accepted, or revoked rows
 *     are left alone.
 *   - Each flip emits one `OrgAuditLog(MEMBER / INVITE_EXPIRED)` row
 *     with the original invite metadata in `details` so a MAINTAINER
 *     scanning the audit log sees what lapsed without needing to dig
 *     into worker logs.
 *   - The flip is a conditional updateMany on PENDING + lapsed, so a row
 *     accepted between the scan and the update is left alone.
 *   - Idempotent: a run with no stale rows expires nothing and writes no
 *     audit rows.
 *   - Runs inside the daily `cleanupAuthTokens()` sweep.
 */

jest.mock("../../lib/prisma", () => {
  const candidates: Array<{
    id: string;
    organizationId: string;
    email: string;
    role: string;
    expiresAt: Date;
  }> = [];
  return {
    __esModule: true,
    default: {
      verification: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      session: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      idempotencyRecord: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      invitation: {
        findMany: jest.fn().mockResolvedValue(candidates),
        updateMany: jest.fn(),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    },
  };
});

import prisma from "@/lib/prisma";
import { cleanupAuthTokens } from "@/lib/auth/cleanup-auth-tokens";

const mockedPrisma = prisma as unknown as {
  invitation: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};

function wireTxShim() {
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      invitation: mockedPrisma.invitation,
      orgAuditLog: mockedPrisma.orgAuditLog,
    };
    return (fn as (tx: unknown) => unknown)(tx);
  });
}

describe("stale invitation expiry in cleanupAuthTokens", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireTxShim();
  });

  it("expires nothing when no candidates exist (idempotent no-op)", async () => {
    mockedPrisma.invitation.findMany.mockResolvedValue([]);
    const result = await cleanupAuthTokens();
    expect(result).toMatchObject({
      success: true,
      staleInvitationsExpired: 0,
      errors: [],
    });
    expect(mockedPrisma.invitation.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.orgAuditLog.create).not.toHaveBeenCalled();
  });

  it("flips pending+past invites to expired and emits an INVITE_EXPIRED audit row", async () => {
    const candidate = {
      id: "inv-1",
      organizationId: "org-1",
      email: "alice@acme.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([candidate]);
    mockedPrisma.invitation.updateMany.mockResolvedValue({ count: 1 });

    const result = await cleanupAuthTokens();
    expect(result.staleInvitationsExpired).toBe(1);
    expect(mockedPrisma.invitation.updateMany).toHaveBeenCalledWith({
      where: {
        id: candidate.id,
        status: "PENDING",
        expiresAt: { lt: expect.any(Date) },
      },
      data: { status: "EXPIRED" },
    });
    expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        category: "MEMBER",
        action: "INVITE_EXPIRED",
        details: expect.objectContaining({
          email: "alice@acme.com",
          role: "LEARNER",
        }),
      }),
    });
  });

  it("skips invites that flipped to 'accepted' between the scan and the update", async () => {
    const candidate = {
      id: "inv-2",
      organizationId: "org-1",
      email: "bob@acme.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([candidate]);
    // The conditional update matches nothing once the row is no longer PENDING.
    mockedPrisma.invitation.updateMany.mockResolvedValue({ count: 0 });

    const result = await cleanupAuthTokens();
    expect(result.staleInvitationsExpired).toBe(0);
    expect(mockedPrisma.orgAuditLog.create).not.toHaveBeenCalled();
  });

  it("collects errors per-row without aborting the whole sweep", async () => {
    const a = {
      id: "inv-a",
      organizationId: "org-1",
      email: "a@x.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    const b = {
      id: "inv-b",
      organizationId: "org-2",
      email: "b@x.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([a, b]);

    // First update throws, second succeeds — the sweep should still
    // report the second row as expired.
    mockedPrisma.invitation.updateMany
      .mockRejectedValueOnce(new Error("DB blip"))
      .mockResolvedValueOnce({ count: 1 });

    const result = await cleanupAuthTokens();
    expect(result.staleInvitationsExpired).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.success).toBe(false);
  });

  it("runs stale invitation expiry as part of cleanupAuthTokens", async () => {
    const candidate = {
      id: "inv-folded",
      organizationId: "org-1",
      email: "folded@acme.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([candidate]);
    mockedPrisma.invitation.updateMany.mockResolvedValue({ count: 1 });

    const result = await cleanupAuthTokens();
    expect(result.success).toBe(true);
    expect(result.staleInvitationsExpired).toBe(1);
    expect(result.totalCleaned).toBe(2 + 3 + 1 + 1);
  });
});
