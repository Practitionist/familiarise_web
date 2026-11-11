/**
 * @jest-environment node
 *
 * Founding-expert fee waiver: the sidecar invariants, the ADMIN grant door
 * (auth, cap, duplicate, unverified expert, success) and capture-time consumption.
 */

import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "../../lib/auth/backoffice-permissions";
import { parseSidecarObjects } from "../../scripts/db/sidecar-objects";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));

let currentUser: { id: string; role: "ADMIN" | "STAFF" } | null = null;
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async (surface: BackofficeSurface) => {
    if (!currentUser) {
      return {
        error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    if (!hasBackofficePermission(currentUser.role, surface)) {
      return {
        error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    return { session: { user: currentUser } };
  }),
}));

const mockTx = {
  $executeRaw: jest.fn().mockResolvedValue(1),
  referralProgramConfig: { findUnique: jest.fn() },
  consultantProfile: { findUnique: jest.fn() },
  consultantFeeWaiver: { count: jest.fn(), create: jest.fn() },
  opsActionLog: { create: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantFeeWaiver: { findMany: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import type { Tx } from "@/lib/prisma";
import {
  consumeFeeWaiver,
  settleB2cPlatformFeePaise,
} from "@/lib/payments/pricing/platform-fee";
import { POST as grant } from "../../app/api/admin/referrals/founding-waivers/route";

const route = { params: Promise.resolve({}) };
const post = (body: Record<string, unknown>) =>
  grant(
    new NextRequest("http://localhost/api/admin/referrals/founding-waivers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    route,
  );
const validBody = {
  consultantProfileId: "cp_1",
  reason: "Founding cohort, first 30 approved",
};
const config = {
  foundingWaiverSessions: 3,
  foundingWaiverDays: 90,
  foundingExpertCap: 30,
  version: 4,
};

describe("founding waiver sidecar", () => {
  it("ties the reason to a null referral and allows one founding waiver per expert", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "prisma/sql/check-constraints.sql"),
      "utf8",
    );
    const { constraints, indexes } = parseSidecarObjects(sql);
    expect(constraints).toContain(
      "consultant_fee_waiver_referral_matches_reason",
    );
    expect(indexes).toContain("consultant_fee_waiver_one_founding_key");
    expect(sql).toContain(
      `CHECK (("reason" = 'FOUNDING_EXPERT') = ("referralId" IS NULL))`,
    );
    expect(sql).toMatch(
      /ON "ConsultantFeeWaiver" \("consultantProfileId"\)\s+WHERE "reason" = 'FOUNDING_EXPERT'/,
    );
  });
});

describe("POST /api/admin/referrals/founding-waivers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = { id: "admin_1", role: "ADMIN" };
    mockTx.referralProgramConfig.findUnique.mockResolvedValue(config);
    mockTx.consultantProfile.findUnique.mockResolvedValue({
      id: "cp_1",
      verificationStatus: "VERIFIED",
    });
    mockTx.consultantFeeWaiver.count.mockResolvedValue(12);
    mockTx.consultantFeeWaiver.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "w_1",
        ...data,
      }),
    );
    mockTx.opsActionLog.create.mockResolvedValue({ id: "ops_1" });
  });

  it("refuses anonymous callers and STAFF", async () => {
    currentUser = null;
    expect((await post(validBody)).status).toBe(401);
    currentUser = { id: "staff_1", role: "STAFF" };
    expect((await post(validBody)).status).toBe(403);
    expect(mockTx.consultantFeeWaiver.create).not.toHaveBeenCalled();
  });

  it("grants count and expiry from config under the config row lock and audits it", async () => {
    const before = Date.now();
    const res = await post(validBody);
    expect(res.status).toBe(201);
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    const { data } = mockTx.consultantFeeWaiver.create.mock.calls[0][0];
    expect(data).toMatchObject({
      consultantProfileId: "cp_1",
      reason: "FOUNDING_EXPERT",
      sessionsRemaining: 3,
      referralId: null,
    });
    const expiry = (data.expiresAt as Date).getTime() - before;
    expect(expiry).toBeGreaterThanOrEqual(90 * 86_400_000);
    expect(expiry).toBeLessThan(90 * 86_400_000 + 60_000);
    expect(await res.json()).toMatchObject({ granted: 13, cap: 30 });
    expect(mockTx.opsActionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "referrals.founding-waiver.grant",
        targetKind: "ConsultantFeeWaiver",
        targetId: "w_1",
        reason: validBody.reason,
      }),
      select: { id: true },
    });
  });

  it("refuses once the cap is reached", async () => {
    mockTx.consultantFeeWaiver.count.mockResolvedValue(30);
    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "FOUNDING_CAP_REACHED",
      granted: 30,
      cap: 30,
    });
    expect(mockTx.consultantFeeWaiver.create).not.toHaveBeenCalled();
  });

  it("maps the one-per-expert unique violation to a typed 409", async () => {
    mockTx.consultantFeeWaiver.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("FOUNDING_WAIVER_EXISTS");
    expect(mockTx.opsActionLog.create).not.toHaveBeenCalled();
  });

  it("refuses an expert who is not verified", async () => {
    mockTx.consultantProfile.findUnique.mockResolvedValue({
      id: "cp_1",
      verificationStatus: "UNDER_REVIEW",
    });
    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_NOT_VERIFIED");
    expect(mockTx.consultantFeeWaiver.create).not.toHaveBeenCalled();
  });
});

describe("founding waiver consumption", () => {
  type Row = {
    id: string;
    reason: string;
    sessionsRemaining: number;
    expiresAt: Date;
  };
  const NOW = new Date("2026-11-11T00:00:00Z");
  const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

  /** Applies the live-waiver filter and expiry order the way Postgres would. */
  const txWith = (rows: Row[], payment: Record<string, unknown>) => {
    const live = (r: Row) => r.sessionsRemaining > 0 && r.expiresAt > NOW;
    const updateMany = jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id && live(r));
      if (row) row.sessionsRemaining -= 1;
      return { count: row ? 1 : 0 };
    });
    const findFirst = jest.fn(async () => {
      const sorted = rows
        .filter(live)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
      return sorted[0] ? { id: sorted[0].id } : null;
    });
    const db = {
      consultantFeeWaiver: { findFirst, updateMany },
      payment: {
        findUnique: async () => ({
          amount: 118_000,
          originalAmount: 100_000,
          taxAmount: 18_000,
          discountCodeId: null,
          welcomeDiscountPaise: null,
          legs: [],
          ...payment,
        }),
        updateMany: async () => ({ count: 1 }),
      },
      expertCustomerRelationship: { findUnique: async () => null },
      platformFeeSchedule: { findFirst: async () => null },
    };
    return { tx: db as unknown as Tx, findFirst, updateMany };
  };

  it("spends the earliest-expiring waiver first, founding or referral", async () => {
    const rows: Row[] = [
      {
        id: "w_ref",
        reason: "REFERRED_EXPERT",
        sessionsRemaining: 3,
        expiresAt: day(60),
      },
      {
        id: "w_founding",
        reason: "FOUNDING_EXPERT",
        sessionsRemaining: 1,
        expiresAt: day(30),
      },
    ];
    const { tx } = txWith(rows, {});
    expect(await consumeFeeWaiver(tx, "cp_1", "pay_1", NOW)).toBe(true);
    expect(await consumeFeeWaiver(tx, "cp_1", "pay_2", NOW)).toBe(true);
    expect(rows.map((r) => r.sessionsRemaining)).toEqual([2, 0]);
  });

  it("never spends a founding waiver on an order that carries promo", async () => {
    const rows: Row[] = [
      {
        id: "w_founding",
        reason: "FOUNDING_EXPERT",
        sessionsRemaining: 3,
        expiresAt: day(30),
      },
    ];
    const { tx, updateMany } = txWith(rows, { welcomeDiscountPaise: 10_000 });
    expect(await consumeFeeWaiver(tx, "cp_1", "pay_1", NOW)).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("leaves waivers untouched where the settle disallows them", async () => {
    const rows: Row[] = [
      {
        id: "w_founding",
        reason: "FOUNDING_EXPERT",
        sessionsRemaining: 3,
        expiresAt: day(30),
      },
    ];
    const { tx, findFirst } = txWith(rows, {});
    const fee = await settleB2cPlatformFeePaise(
      tx,
      {
        id: "pay_1",
        userId: "buyer",
        platformFeeBps: 2000,
        attributionSource: "MARKETPLACE",
      },
      "cp_1",
      100_000,
      { allowWaiver: false },
    );
    expect(fee).toBe(20_000);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
