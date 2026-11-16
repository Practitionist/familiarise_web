/**
 * @jest-environment node
 */

/**
 * The per-operator support spend: the IST day and the enforced rolling 24
 * hours side by side, the remaining limit on the enforced basis, 30-day sums,
 * holds, and per-payment usage from the same helper the doors use.
 */

interface MockOpsRow {
  actorUserId: string | null;
  action: string;
  after: unknown;
  createdAt: Date;
}

const mockUsers = [
  { id: "staff-1", name: "Asha", role: "STAFF" },
  { id: "staff-2", name: "Bela", role: "STAFF" },
  { id: "admin-1", name: "Chitra", role: "ADMIN" },
];
const mockOpsRows: MockOpsRow[] = [];
const mockRecommendations: {
  id?: string;
  paymentId: string;
  amountPaise: number;
  approved: boolean | null;
}[] = [];
const mockUserFindMany = jest.fn();
const mockRecFindMany = jest.fn();

type OpsWhere = {
  actorUserId?: string | { in: string[] };
  action?: { in: string[] };
  createdAt?: { gte: Date };
};

function matchesOps(row: MockOpsRow, where: OpsWhere) {
  const actor = where.actorUserId;
  if (typeof actor === "string" && row.actorUserId !== actor) return false;
  if (
    actor &&
    typeof actor === "object" &&
    !actor.in.includes(row.actorUserId ?? "")
  )
    return false;
  if (where.action && !where.action.in.includes(row.action)) return false;
  if (where.createdAt && row.createdAt < where.createdAt.gte) return false;
  return true;
}

jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findMany: async (args: {
        where: { id?: string; role?: string | { in: string[] } };
      }) => {
        mockUserFindMany(args);
        const { id, role } = args.where;
        return mockUsers.filter(
          (u) =>
            (id === undefined || u.id === id) &&
            (role === undefined ||
              (typeof role === "string"
                ? u.role === role
                : role.in.includes(u.role))),
        );
      },
      count: async () => mockUsers.length,
    },
    opsActionLog: {
      findMany: async ({ where }: { where: OpsWhere }) =>
        mockOpsRows
          .filter((row) => matchesOps(row, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    },
    refund: { findMany: async () => [] },
    payment: { findMany: async () => [] },
    supportFinancialRecommendation: {
      findMany: async (args: {
        where: {
          paymentId: { in: string[] };
          approved: boolean;
          id?: { not: string };
        };
      }) => {
        mockRecFindMany(args);
        const { paymentId, approved, id } = args.where;
        return mockRecommendations.filter(
          (r) =>
            paymentId.in.includes(r.paymentId) &&
            r.approved === approved &&
            (id === undefined || r.id !== id.not),
        );
      },
    },
  },
}));

import prisma from "../../lib/prisma";
import { istDayStart } from "../../lib/compliance/ist-period";
import { readSupportSpend } from "../../lib/backoffice/support-spend";
import {
  committedSupportPaiseByPayment,
  rollingRefundPaise,
} from "../../lib/support/money-policy";
import {
  STAFF_REFUND_PER_PAYMENT_PAISE,
  STAFF_REFUND_ROLLING_PAISE,
} from "../../lib/support/staff-refund-limits";

// 07:30 IST on 22 Oct; the IST day began at 2026-10-21T18:30Z.
const NOW = new Date("2026-10-22T02:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function row(
  actorUserId: string,
  action: string,
  after: unknown,
  createdAt: Date,
): MockOpsRow {
  return { actorUserId, action, after, createdAt };
}

const refund = (
  actor: string,
  paymentId: string,
  movedPaise: number,
  at: Date,
) =>
  row(
    actor,
    "support.refund.review",
    { status: "SUCCEEDED", approved: true, paymentId, movedPaise },
    at,
  );

beforeEach(() => {
  mockOpsRows.length = 0;
  mockRecommendations.length = 0;
});

const operator = async (userId: string, role = "ADMIN") => {
  const report = await readSupportSpend({
    viewer: { userId: "viewer", role },
    now: NOW,
  });
  const found = report.operators.find((o) => o.userId === userId);
  if (!found) throw new Error(`no row for ${userId}`);
  return found;
};

describe("istDayStart", () => {
  it("starts the day at IST midnight, not UTC midnight", () => {
    expect(istDayStart(NOW).toISOString()).toBe("2026-10-21T18:30:00.000Z");
    expect(
      istDayStart(new Date("2026-10-21T18:29:59.000Z")).toISOString(),
    ).toBe("2026-10-20T18:30:00.000Z");
  });
});

describe("committedSupportPaiseByPayment", () => {
  it("sums approved remedies per payment across operators", async () => {
    mockRecommendations.push(
      { paymentId: "pay-1", amountPaise: 200_000, approved: true },
      { paymentId: "pay-1", amountPaise: 100_000, approved: true },
      { paymentId: "pay-1", amountPaise: 900_000, approved: false },
      { paymentId: "pay-2", amountPaise: 50_000, approved: true },
    );
    const committed = await committedSupportPaiseByPayment(prisma, [
      "pay-1",
      "pay-2",
      "pay-3",
    ]);
    expect(Object.fromEntries(committed)).toEqual({
      "pay-1": 300_000,
      "pay-2": 50_000,
    });
  });

  it("skips the query when there are no payments", async () => {
    mockRecFindMany.mockClear();
    expect((await committedSupportPaiseByPayment(prisma, [])).size).toBe(0);
    expect(mockRecFindMany).not.toHaveBeenCalled();
  });

  it("leaves out only the excluded recommendation", async () => {
    mockRecommendations.push(
      { id: "rec-1", paymentId: "pay-1", amountPaise: 200_000, approved: true },
      { id: "rec-2", paymentId: "pay-1", amountPaise: 100_000, approved: true },
      { id: "rec-3", paymentId: "pay-1", amountPaise: 900_000, approved: null },
      { id: "rec-4", paymentId: "pay-2", amountPaise: 50_000, approved: true },
    );
    mockRecFindMany.mockClear();
    const committed = await committedSupportPaiseByPayment(
      prisma,
      ["pay-1", "pay-2"],
      { excludeRecommendationId: "rec-1" },
    );
    expect(Object.fromEntries(committed)).toEqual({
      "pay-1": 100_000,
      "pay-2": 50_000,
    });
    expect(mockRecFindMany).toHaveBeenCalledWith({
      where: {
        paymentId: { in: ["pay-1", "pay-2"] },
        approved: true,
        id: { not: "rec-1" },
      },
      select: { paymentId: true, amountPaise: true },
    });
  });

  it("adds no id filter without an exclusion", async () => {
    mockRecFindMany.mockClear();
    await committedSupportPaiseByPayment(prisma, ["pay-1"]);
    await committedSupportPaiseByPayment(prisma, ["pay-1"], {});
    for (const [args] of mockRecFindMany.mock.calls)
      expect(args.where).toEqual({
        paymentId: { in: ["pay-1"] },
        approved: true,
      });
    expect(mockRecFindMany).toHaveBeenCalledTimes(2);
  });
});

describe("readSupportSpend", () => {
  describe("money edge cases", () => {
    const cancel = (after: Record<string, unknown>, at = ago(2)) =>
      row(
        "staff-1",
        "appointment.cancel.platform",
        { status: "SUCCEEDED", ...after },
        at,
      );

    it("does not count a refund that moved nothing", async () => {
      mockOpsRows.push(
        refund("staff-1", "pay-1", 0, ago(1)),
        refund("staff-1", "pay-2", 10_000, ago(2)),
      );
      const staff = await operator("staff-1");
      expect(staff.refunds.count30d).toBe(1);
      expect(staff.refunds.rolling30dPaise).toBe(10_000);
    });

    it("gives a platform cancel that moved nothing no payment usage", async () => {
      mockOpsRows.push(
        cancel({
          paymentIds: ["pay-1"],
          movedPaise: 0,
          charges: [{ paymentId: "pay-1", newPaise: 0 }],
        }),
        cancel({ paymentIds: ["pay-2"], movedPaise: 0 }),
      );
      const staff = await operator("staff-1");
      expect(staff.payments).toEqual([]);
      expect(staff.refunds.count30d).toBe(0);
      expect(staff.refunds.platformCancel30dPaise).toBe(0);
    });

    it("skips a platform-cancel charge of 0 on a group cancel", async () => {
      mockOpsRows.push(
        cancel({
          paymentIds: ["pay-1", "pay-2"],
          movedPaise: 250_000,
          charges: [
            { paymentId: "pay-1", newPaise: 250_000 },
            { paymentId: "pay-2", newPaise: 0 },
          ],
        }),
      );
      const staff = await operator("staff-1");
      expect(staff.payments.map((p) => p.paymentId)).toEqual(["pay-1"]);
      expect(staff.payments[0].platformCancelPaise).toBe(250_000);
    });

    it("reads a negative movedPaise as zero, as the door does", async () => {
      mockOpsRows.push(
        refund("staff-1", "pay-1", -50_000, ago(1)),
        cancel({ paymentIds: ["pay-2"], movedPaise: -20_000 }),
      );
      const staff = await operator("staff-1");
      expect(staff.refunds).toMatchObject({
        istDayPaise: 0,
        rolling24hPaise: 0,
        rolling30dPaise: 0,
        count30d: 0,
        platformCancel30dPaise: 0,
      });
      expect(staff.refunds.rolling24hPaise).toBe(
        await rollingRefundPaise(prisma, "staff-1", NOW),
      );
      expect(staff.remainingDailyCapPaise).toBe(STAFF_REFUND_ROLLING_PAISE);
      expect(
        staff.payments.find((p) => p.paymentId === "pay-2"),
      ).toBeUndefined();
    });

    it("sums several partial refunds on one payment", async () => {
      mockRecommendations.push(
        { paymentId: "pay-1", amountPaise: 100_000, approved: true },
        { paymentId: "pay-1", amountPaise: 120_000, approved: true },
        { paymentId: "pay-1", amountPaise: 130_000, approved: true },
      );
      mockOpsRows.push(
        refund("staff-1", "pay-1", 100_000, ago(1)),
        refund("staff-1", "pay-1", 120_000, ago(30)),
        refund("staff-1", "pay-1", 130_000, ago(24 * 10)),
      );
      const staff = await operator("staff-1");
      expect(staff.refunds.rolling24hPaise).toBe(100_000);
      expect(staff.refunds.rolling30dPaise).toBe(350_000);
      expect(staff.refunds.count30d).toBe(3);
      expect(staff.payments).toEqual([
        {
          paymentId: "pay-1",
          target: null,
          supportCommittedPaise: 350_000,
          platformCancelPaise: 0,
          remainingPerPaymentPaise: STAFF_REFUND_PER_PAYMENT_PAISE - 350_000,
          holdsApplied: 0,
        },
      ]);
    });
  });

  it("reports the IST calendar day and the enforced rolling 24 hours separately", async () => {
    mockOpsRows.push(
      // 15:30 IST yesterday: inside the last 24 hours, outside today.
      refund("staff-1", "pay-1", 100_000, ago(16)),
      // 01:30 IST today.
      refund("staff-1", "pay-2", 50_000, ago(6)),
    );
    const staff = await operator("staff-1");
    expect(staff.refunds.istDayPaise).toBe(50_000);
    expect(staff.refunds.rolling24hPaise).toBe(150_000);
    expect(staff.refunds.rolling24hPaise).toBe(
      await rollingRefundPaise(prisma, "staff-1", NOW),
    );
  });

  it("counts platform cancels toward the daily limit, like the door", async () => {
    mockOpsRows.push(
      refund("staff-1", "pay-1", 400_000, ago(2)),
      row(
        "staff-1",
        "appointment.cancel.platform",
        {
          status: "SUCCEEDED",
          paymentIds: ["pay-9"],
          movedPaise: 300_000,
          charges: [{ paymentId: "pay-9", newPaise: 300_000 }],
        },
        ago(3),
      ),
    );
    const staff = await operator("staff-1");
    expect(staff.refunds.rolling24hPaise).toBe(700_000);
    expect(staff.refunds.rolling24hPaise).toBe(
      await rollingRefundPaise(prisma, "staff-1", NOW),
    );
    expect(staff.remainingDailyCapPaise).toBe(
      STAFF_REFUND_ROLLING_PAISE - 700_000,
    );
    expect(staff.refunds.platformCancel30dPaise).toBe(300_000);
  });

  it("sums 30 days, ignores failed attempts and clamps the remaining limit at 0", async () => {
    mockOpsRows.push(
      refund("staff-1", "pay-1", STAFF_REFUND_ROLLING_PAISE + 10_000, ago(1)),
      refund("staff-1", "pay-2", 200_000, ago(24 * 20)),
      refund("staff-1", "pay-3", 999_999, ago(24 * 31)),
      row(
        "staff-1",
        "support.refund.review",
        { status: "FAILED", code: "STAFF_DAILY_LIMIT" },
        ago(1),
      ),
    );
    const staff = await operator("staff-1");
    expect(staff.refunds.rolling30dPaise).toBe(
      STAFF_REFUND_ROLLING_PAISE + 210_000,
    );
    expect(staff.refunds.count30d).toBe(2);
    expect(staff.remainingDailyCapPaise).toBe(0);
    expect(staff.payments.map((p) => p.paymentId)).toEqual(["pay-1", "pay-2"]);
  });

  it("shows no daily or per-payment limit for an admin operator", async () => {
    mockOpsRows.push(refund("admin-1", "pay-1", 2_000_000, ago(1)));
    const admin = await operator("admin-1");
    expect(admin.capped).toBe(false);
    expect(admin.remainingDailyCapPaise).toBeNull();
    expect(admin.payments[0].remainingPerPaymentPaise).toBeNull();
  });

  it("gives a staff viewer only their own row, and an admin every operator", async () => {
    mockOpsRows.push(
      refund("staff-1", "pay-1", 100_000, ago(1)),
      refund("staff-2", "pay-2", 200_000, ago(1)),
    );
    const own = await readSupportSpend({
      viewer: { userId: "staff-1", role: "STAFF" },
      now: NOW,
    });
    expect(mockUserFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "staff-1", role: "STAFF" } }),
    );
    expect(own.operators.map((o) => o.userId)).toEqual(["staff-1"]);

    const all = await readSupportSpend({
      viewer: { userId: "admin-1", role: "ADMIN" },
      now: NOW,
    });
    const ids = all.operators.map((o) => o.userId);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(
      expect.arrayContaining(["admin-1", "staff-1", "staff-2"]),
    );
  });

  it("reports per-payment usage: support remedies counted, platform cancels shown apart", async () => {
    mockRecommendations.push(
      { paymentId: "pay-1", amountPaise: 300_000, approved: true },
      { paymentId: "pay-1", amountPaise: 150_000, approved: true },
    );
    mockOpsRows.push(
      refund("staff-1", "pay-1", 300_000, ago(30)),
      row(
        "staff-1",
        "appointment.cancel.platform",
        {
          status: "SUCCEEDED",
          paymentIds: ["pay-1", "pay-4"],
          movedPaise: 500_000,
          charges: [
            { paymentId: "pay-1", newPaise: 400_000 },
            { paymentId: "pay-4", newPaise: 100_000 },
          ],
        },
        ago(40),
      ),
      // An older row without the split: one payment is attributable.
      row(
        "staff-1",
        "appointment.cancel.platform",
        { status: "SUCCEEDED", paymentIds: ["pay-5"], movedPaise: 70_000 },
        ago(50),
      ),
      // An older group cancel without the split stays unattributed.
      row(
        "staff-1",
        "appointment.cancel.platform",
        {
          status: "SUCCEEDED",
          paymentIds: ["pay-6", "pay-7"],
          movedPaise: 90_000,
        },
        ago(60),
      ),
    );
    const staff = await operator("staff-1");
    const byId = Object.fromEntries(
      staff.payments.map((p) => [p.paymentId, p]),
    );
    expect(byId["pay-1"]).toEqual({
      paymentId: "pay-1",
      target: null,
      supportCommittedPaise: 450_000,
      platformCancelPaise: 400_000,
      remainingPerPaymentPaise: STAFF_REFUND_PER_PAYMENT_PAISE - 450_000,
      holdsApplied: 0,
    });
    expect(byId["pay-4"].platformCancelPaise).toBe(100_000);
    expect(byId["pay-5"].platformCancelPaise).toBe(70_000);
    expect(byId["pay-6"]).toBeUndefined();
    expect(staff.refunds.platformCancelUnsplit30dPaise).toBe(90_000);
    expect(staff.refunds.platformCancel30dPaise).toBe(660_000);
  });

  it("counts holds, sums heldPaise where logged and skips replays", async () => {
    const hold = (action: string, after: Record<string, unknown>, at: Date) =>
      row("staff-1", action, { caseId: "c", holdId: "h", ...after }, at);
    mockOpsRows.push(
      hold(
        "support.hold.apply",
        { paymentId: "pay-1", replayed: false, heldPaise: 120_000 },
        ago(2),
      ),
      hold(
        "support.hold.apply",
        { paymentId: "pay-2", replayed: false },
        ago(24 * 5),
      ),
      hold(
        "support.hold.apply",
        { paymentId: "pay-1", replayed: true, heldPaise: 0 },
        ago(1),
      ),
      hold(
        "support.hold.release",
        { paymentId: "pay-2", replayed: false, heldPaise: 0 },
        ago(3),
      ),
    );
    const staff = await operator("staff-1");
    expect(staff.holds).toEqual({
      appliedIstDay: 1,
      applied30d: 2,
      released30d: 1,
      heldPaise30d: 120_000,
      appliedWithoutAmount30d: 1,
    });
    expect(
      staff.payments.find((p) => p.paymentId === "pay-1")?.holdsApplied,
    ).toBe(1);
    expect(staff.refunds.rolling30dPaise).toBe(0);
  });

  it("hands out audit filters for the drill-through and the enforced caps", async () => {
    const report = await readSupportSpend({
      viewer: { userId: "staff-1", role: "STAFF" },
      now: NOW,
    });
    const since = new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString();
    expect(report.windows.rolling30dStart).toBe(since);
    expect(report.operators[0].audit).toEqual({
      supportRefunds: {
        actorUserId: "staff-1",
        action: "support.refund.review",
        since,
      },
      platformCancels: {
        actorUserId: "staff-1",
        action: "appointment.cancel.platform",
        since,
      },
      holdsApplied: {
        actorUserId: "staff-1",
        action: "support.hold.apply",
        since,
      },
    });
    expect(report.caps).toEqual({
      perPaymentPaise: STAFF_REFUND_PER_PAYMENT_PAISE,
      rolling24hPaise: STAFF_REFUND_ROLLING_PAISE,
    });
  });
});
