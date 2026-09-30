/**
 * @jest-environment node
 */

/**
 * #CASC — CAS-in-WHERE for the REFUNDED earnings transition.
 *
 * The doctrine in this repo is that every money transition repeats its
 * predicate in the WHERE clause. The four REFUNDED writers did not: they read
 * `earnings.status` into JS, passed `assertEarningStatusTransitionLegal` (an
 * assertion — a throw plus Sentry — not a database guard) and then wrote with a
 * bare `update({ where: { id } })`. Two concurrent refund paths for the same row
 * (an app refund racing a lost-dispute webhook, or two cascades) could both read
 * READY, both pass the assertion and both write.
 *
 * Pinned here:
 *  - the WHERE repeats the legal source statuses and the pre-read
 *    `refundedShareAmount`, so a second writer is refused (count 0) and cannot
 *    double-increment
 *  - the cap survives the race: the column never passes `consultantSharePaise`
 *    however two writers interleave
 *  - PAID → REFUNDED still works (forceRefund), and REFUNDED stays terminal
 *
 * The fake below HONOURS the WHERE clause (that is the point): a mock that
 * ignored the predicates would pass regardless of the code under test.
 */

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
  reportSentryException: jest.fn(),
}));

const mockRecordTdsReversal = jest.fn();
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => mockRecordTdsReversal(...a),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

import { applyCappedEarningReversal } from "../../lib/payments/payouts/earning-reversal-cas";
import { refundEarnings } from "../../lib/payments/payouts/earnings-service";
import { EarningStatus } from "@prisma/client";

type Row = {
  id: string;
  status: EarningStatus;
  consultantSharePaise: number;
  refundedShareAmount: number;
  payoutId: string | null;
  consultantProfileId: string;
  paymentId: string;
  cycleOrdinal?: number | null;
};

const row = (over: Partial<Row> = {}): Row => ({
  id: "ce-1",
  status: EarningStatus.READY,
  consultantSharePaise: 8_000,
  refundedShareAmount: 0,
  payoutId: null,
  consultantProfileId: "cp-1",
  paymentId: "pay-1",
  ...over,
});

/** A prisma-ish earnings delegate whose updateMany really evaluates `where`. */
function store(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const updateMany = jest.fn(async (args: any) => {
    const { where, data } = args;
    let count = 0;
    for (const r of byId.values()) {
      if (where.id !== undefined && where.id !== r.id) continue;
      if (where.status !== undefined) {
        const allowed = where.status.in ?? [where.status];
        if (!allowed.includes(r.status)) continue;
      }
      if (
        where.refundedShareAmount !== undefined &&
        where.refundedShareAmount !== r.refundedShareAmount
      ) {
        continue;
      }
      count++;
      Object.assign(r, data);
    }
    return { count };
  });
  const findUnique = jest.fn(async ({ where }: any) => {
    const r = byId.get(where.id);
    if (!r) return null;
    return { status: r.status, refundedShareAmount: r.refundedShareAmount };
  });
  return {
    updateMany,
    findUnique,
    db: { consultantEarnings: { updateMany, findUnique } } as never,
  };
}

/** The WHERE a refusal is decided by, asserted on every call. */
function whereOf(mock: jest.Mock, call = 0) {
  return mock.mock.calls[call][0].where;
}
function dataOf(mock: jest.Mock, call = 0) {
  return mock.mock.calls[call][0].data;
}

describe("capped earning reversal — CAS-in-WHERE (#CASC)", () => {
  it("writes an absolute capped value, never an increment", async () => {
    const r = row();
    const { db, updateMany } = store([r]);

    const out = await applyCappedEarningReversal(db, { ...r }, 5_000);

    expect(out).toMatchObject({
      reversedPaise: 5_000,
      refundedShareAmount: 5_000,
      fullyRefunded: false,
      lostRace: false,
    });
    expect(dataOf(updateMany)).toEqual({ refundedShareAmount: 5_000 });
    expect(r.refundedShareAmount).toBe(5_000);
    expect(r.status).toBe(EarningStatus.READY);
  });

  it("repeats the legal source statuses and the pre-read value in the WHERE", async () => {
    const r = row();
    const { db, updateMany } = store([r]);

    await applyCappedEarningReversal(db, { ...r }, 8_000);

    const where = whereOf(updateMany);
    expect(where.id).toBe("ce-1");
    expect(where.refundedShareAmount).toBe(0);
    // REFUNDED is terminal, so it is never a legal source.
    expect(where.status.in).toEqual(
      expect.arrayContaining(["READY", "PAID", "PENDING", "HELD", "BATCHED"]),
    );
    expect(where.status.in).not.toContain(EarningStatus.REFUNDED);
    // A full reversal is the only thing that moves the status.
    expect(dataOf(updateMany)).toEqual({
      refundedShareAmount: 8_000,
      status: EarningStatus.REFUNDED,
    });
  });

  it("refuses a second concurrent writer instead of double-incrementing", async () => {
    const r = row();
    const { db, updateMany } = store([r]);
    // Both writers read the same state before either writes.
    const writerA = { ...r };
    const writerB = { ...r };

    const a = await applyCappedEarningReversal(db, writerA, 8_000);
    const b = await applyCappedEarningReversal(db, writerB, 8_000);

    expect(a.reversedPaise).toBe(8_000);
    expect(b.reversedPaise).toBe(0);
    expect(b.lostRace).toBe(true);
    expect(b.fullyRefunded).toBe(true);
    // The refusal is a real conditional write that matched nothing.
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(whereOf(updateMany, 1).refundedShareAmount).toBe(0);
    // One reversal total, capped at the share — not 16_000.
    expect(r.refundedShareAmount).toBe(8_000);
    expect(r.refundedShareAmount).toBeLessThanOrEqual(r.consultantSharePaise);
  });

  it("keeps the cap when two partial reversals race", async () => {
    const r = row();
    const { db } = store([r]);

    await applyCappedEarningReversal(db, { ...r }, 5_000);
    const b = await applyCappedEarningReversal(db, { ...r }, 5_000);

    // The loser re-reads and takes only the residual: 5_000 + min(5_000, 3_000).
    expect(b).toMatchObject({ reversedPaise: 3_000, fullyRefunded: true, lostRace: true });
    expect(r.refundedShareAmount).toBe(8_000);
    expect(r.refundedShareAmount).toBeLessThanOrEqual(r.consultantSharePaise);
    expect(r.status).toBe(EarningStatus.REFUNDED);
  });

  it("never lets a reversal pass the share, even after a refusal", async () => {
    const r = row({ consultantSharePaise: 3_000, refundedShareAmount: 1_000 });
    const { db, updateMany } = store([r]);

    const out = await applyCappedEarningReversal(db, { ...r }, 3_000);

    // Capped to the 2_000 still reversible, so the request is not honoured whole.
    expect(out.reversedPaise).toBe(2_000);
    expect(r.refundedShareAmount).toBe(3_000);
    expect(updateMany.mock.calls[0][0].data.refundedShareAmount).toBe(3_000);
  });

  it("REFUNDED is terminal: a second reversal of a reversed row writes nothing", async () => {
    const r = row({
      status: EarningStatus.REFUNDED,
      refundedShareAmount: 8_000,
    });
    const { db, updateMany } = store([r]);

    const out = await applyCappedEarningReversal(db, { ...r }, 8_000);

    expect(out).toMatchObject({
      reversedPaise: 0,
      refundedShareAmount: 8_000,
      fullyRefunded: true,
      lostRace: true,
    });
    // Refused by the status predicate, not by the cap.
    expect(whereOf(updateMany).status.in).not.toContain(EarningStatus.REFUNDED);
    expect(r.refundedShareAmount).toBe(8_000);
  });

  it("gives up (and says so) rather than claiming a write that never landed", async () => {
    const r = row();
    const { db, updateMany, findUnique } = store([r]);
    // The row keeps showing room, but the conditional write never matches: the
    // worst case is two refusals, and the result must be a reported no-op.
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockImplementation(async () => ({
      status: r.status,
      refundedShareAmount: r.refundedShareAmount,
    }));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const out = await applyCappedEarningReversal(db, { ...r }, 1_000);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      reversedPaise: 0,
      refundedShareAmount: 0,
      fullyRefunded: false,
      lostRace: true,
    });
    expect(r.refundedShareAmount).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refused twice"));
    warn.mockRestore();
  });

  it("treats a deleted row as a lost race, not a crash", async () => {
    const { db, updateMany, findUnique } = store([]);
    findUnique.mockResolvedValueOnce(null as never);

    const out = await applyCappedEarningReversal(
      db,
      row(),
      1_000,
    );

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ reversedPaise: 0, lostRace: true });
  });
});

describe("refundEarnings — PAID branch is guarded, not unguarded", () => {
  function harness(earnings: Row[]) {
    const s = store(earnings);
    return {
      ...s,
      refundEarningsTx: {
        consultantEarnings: {
          findMany: jest.fn(async () => earnings.map((r) => ({ ...r }))),
          updateMany: s.updateMany,
          findUnique: s.findUnique,
        },
        organizationEarnings: { findMany: jest.fn(async () => []) },
      } as never,
    };
  }

  it("PAID + forceRefund still transitions to REFUNDED and files the TDS reversal", async () => {
    const r = row({ status: EarningStatus.PAID, payoutId: "po-1" });
    const { db, updateMany } = harness([r]);

    await refundEarnings("pay-1", { forceRefund: true, tx: db });

    expect(dataOf(updateMany)).toEqual({
      refundedShareAmount: 8_000,
      status: EarningStatus.REFUNDED,
    });
    expect(whereOf(updateMany).status.in).toContain(EarningStatus.PAID);
    expect(r.status).toBe(EarningStatus.REFUNDED);
    expect(mockRecordTdsReversal).toHaveBeenCalledTimes(1);
    expect(mockRecordTdsReversal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payoutId: "po-1", earningsId: "ce-1" }),
    );
  });

  it("PAID without forceRefund still writes nothing", async () => {
    const r = row({ status: EarningStatus.PAID, payoutId: "po-1" });
    const { db, updateMany } = harness([r]);

    await refundEarnings("pay-1", { tx: db });

    expect(updateMany).not.toHaveBeenCalled();
    expect(mockRecordTdsReversal).not.toHaveBeenCalled();
    expect(r.status).toBe(EarningStatus.PAID);
  });

  it("skips a row a concurrent writer already took to REFUNDED", async () => {
    const r = row({ status: EarningStatus.REFUNDED, refundedShareAmount: 8_000 });
    const { db, updateMany } = harness([r]);

    await refundEarnings("pay-1", { forceRefund: true, tx: db });

    expect(updateMany).not.toHaveBeenCalled();
    expect(mockRecordTdsReversal).not.toHaveBeenCalled();
    expect(r.refundedShareAmount).toBe(8_000);
  });

  it("a second cascade over the same READY row cannot re-reverse it", async () => {
    const r = row();
    const { db, updateMany } = harness([r]);

    await refundEarnings("pay-1", { tx: db });
    expect(r.refundedShareAmount).toBe(8_000);
    // The webhook redelivers, but findMany now hands back the terminal row.
    (db as any).consultantEarnings.findMany.mockImplementation(async () => [
      { ...r },
    ]);
    await refundEarnings("pay-1", { tx: db });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(r.refundedShareAmount).toBe(8_000);
    expect(r.status).toBe(EarningStatus.REFUNDED);
  });
});
