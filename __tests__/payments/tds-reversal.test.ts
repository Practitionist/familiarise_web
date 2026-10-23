/**
 * @jest-environment node
 */

/**
 * #813 review follow-up — pins recordTdsReversal's three safety properties:
 * integer-floor proportion (no float drift, tiny slices round DOWN to zero),
 * the dedup/cap against double-reversal on a second cascade, and the
 * filed-aware (FY, quarter) policy. Pure unit test over a stubbed tx — the
 * helper's reads/writes are the only prisma surface it touches.
 */

import {
  recordTdsReversal,
  getIndianFinancialYear,
  getIndianFYQuarter,
} from "@/lib/payments/tax/tds-service";

type Row = Record<string, unknown>;

function makeTx(
  original: Row | null,
  priorReversals: Row[] = [],
  earning: Row | null = null,
) {
  const created: Row[] = [];
  const adjustments: Row[] = [];
  const tx = {
    tDSRecord: {
      findFirst: jest.fn(async () => original),
      findMany: jest.fn(async () => priorReversals),
      create: jest.fn(async ({ data }: { data: Row }) => {
        created.push(data);
        return { id: "tdsr_new", ...data };
      }),
    },
    consultantEarnings: { findUnique: jest.fn(async () => earning) },
    // #778 §D — every reversal also emits the TdsAdjustment filing artifact.
    tdsAdjustment: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        adjustments.push(data);
        return { id: "tdsadj_new", ...data };
      }),
    },
  };
  return { tx: tx as never, created, adjustments };
}

const ORIGINAL = {
  id: "tdsr_1",
  payoutId: "po_1",
  consultantProfileId: "cp_1",
  financialYear: "2025-26",
  quarter: 2,
  cumulativeAmountCredited: 100_000,
  tdsDeducted: 1_000,
  tdsRateBps: 1000,
  tdsSection: "194J",
  isReversal: false,
  reportedInForm26Q: false,
};

const PARAMS = {
  payoutId: "po_1",
  consultantProfileId: "cp_1",
  earningsId: "earn_1",
  refundAmountPaise: 10_000,
  paymentAmountPaise: 10_000,
};

describe("recordTdsReversal", () => {
  it("full refund reverses the full withholding, copying FY+quarter from an unfiled original", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL });
    const result = await recordTdsReversal(tx, PARAMS);

    expect(result).not.toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tdsDeducted: -1_000,
      isReversal: true,
      // unfiled original → corrected in place: original's FY/quarter pair
      financialYear: "2025-26",
      quarter: 2,
      tdsSection: "194J",
      payoutId: "po_1",
      earningsId: "earn_1",
    });
  });

  it("stamps the CURRENT IST FY+quarter when the original is already filed in 26Q", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL, reportedInForm26Q: true });
    await recordTdsReversal(tx, PARAMS);

    expect(created).toHaveLength(1);
    // filed original → adjust-against-future-liability: both fields from now
    expect(created[0].financialYear).toBe(getIndianFinancialYear());
    expect(created[0].quarter).toBe(getIndianFYQuarter());
  });

  it("caps a second cascade at zero — no double reversal after a full reversal exists", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL }, [{ tdsDeducted: -1_000 }]);
    const result = await recordTdsReversal(tx, PARAMS);

    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("caps accumulated partial reversals at the original withholding", async () => {
    // 600 already reversed; a 70% refund wants floor(700) but only 400 remains.
    const { tx, created } = makeTx({ ...ORIGINAL }, [{ tdsDeducted: -600 }]);
    await recordTdsReversal(tx, {
      ...PARAMS,
      refundAmountPaise: 7_000,
    });

    expect(created).toHaveLength(1);
    expect(created[0].tdsDeducted).toBe(-400);
  });

  it("floors tiny slices to zero instead of float-rounding up (3334/10000 of 1 paisa)", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL, tdsDeducted: 1 });
    const result = await recordTdsReversal(tx, {
      ...PARAMS,
      refundAmountPaise: 3_334,
    });

    // Math.round(0.3334) would have created a 0-paise record path; floor no-ops.
    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("reverses only the refunded booking's own 0.1 %, leaving a year-to-date catch-up withheld", async () => {
    // Crossing payout withheld ₹510 on ₹5,10,000; its ₹20,000 booking is fully refunded.
    const { tx, created } = makeTx(
      { ...ORIGINAL, tdsDeducted: 51_000, tdsRateBps: 10, tdsSection: "194O" },
      [],
      { grossAmount: 2_000_000 },
    );
    await recordTdsReversal(tx, PARAMS);

    expect(created[0].tdsDeducted).toBe(-2_000);
  });

  it("no-ops when there is no original withholding", async () => {
    const { tx, created } = makeTx(null);
    const result = await recordTdsReversal(tx, PARAMS);

    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe("two reversals on one payout in one quarter", () => {
  it("both commit, and the one reversal row the unique key allows sums them", async () => {
    // A stateful tx that enforces (consultant, FY, quarter, payout, isReversal).
    const rows: Row[] = [{ ...ORIGINAL, challanNumber: null }];
    const adjustments: Row[] = [];
    const key = (r: Row) =>
      [
        r.consultantProfileId,
        r.financialYear,
        r.quarter,
        r.payoutId,
        r.isReversal,
      ].join("|");
    const tx = {
      tDSRecord: {
        findFirst: jest.fn(async () => rows.find((r) => !r.isReversal) ?? null),
        findMany: jest.fn(async () => rows.filter((r) => r.isReversal)),
        create: jest.fn(async ({ data }: { data: Row }) => {
          if (rows.some((r) => key(r) === key(data))) {
            throw Object.assign(new Error("Unique constraint failed"), {
              code: "P2002",
            });
          }
          const row = {
            id: `tdsr_${rows.length + 1}`,
            reportedInForm26Q: false,
            challanNumber: null,
            ...data,
          };
          rows.push(row);
          return row;
        }),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: Row;
            data: { tdsDeducted: { decrement: number } };
          }) => {
            const row = rows.find(
              (r) =>
                r.id === where.id &&
                r.tdsDeducted === where.tdsDeducted &&
                r.reportedInForm26Q === false,
            );
            if (!row) return { count: 0 };
            row.tdsDeducted =
              (row.tdsDeducted as number) - data.tdsDeducted.decrement;
            return { count: 1 };
          },
        ),
      },
      consultantEarnings: { findUnique: jest.fn(async () => null) },
      tdsAdjustment: {
        create: jest.fn(async ({ data }: { data: Row }) => {
          adjustments.push(data);
          return data;
        }),
      },
    } as never;

    // Two bookings of the one payout refunded: 30 % then 20 % of the withholding.
    await recordTdsReversal(tx, {
      ...PARAMS,
      refundAmountPaise: 3_000,
      refundId: "rf_1",
    });
    await recordTdsReversal(tx, {
      ...PARAMS,
      refundAmountPaise: 2_000,
      refundId: "rf_2",
    });

    const reversals = rows.filter((r) => r.isReversal);
    expect(reversals).toHaveLength(1);
    expect(reversals[0].tdsDeducted).toBe(-500);
    expect(
      adjustments.map((a) => [a.refundId, a.amountPaise, a.tdsRecordId]),
    ).toEqual([
      ["rf_1", -300, reversals[0].id],
      ["rf_2", -200, reversals[0].id],
    ]);
  });
});
