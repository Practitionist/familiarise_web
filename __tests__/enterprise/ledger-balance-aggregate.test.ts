/**
 * @jest-environment node
 */

/**
 * Account balances are aggregated from the journal, never stored: a posting
 * writes no shared per-account row (CASH, GST_PAYABLE), so concurrent
 * confirmations cannot serialize on one. Pins both halves on an in-memory db.
 */

import {
  postLedgerTxn,
  ledgerBalancePaise,
  ledgerAccountId,
  type Posting,
} from "@/lib/payments/ledger/post";

type Entry = { accountId: string; direction: string; amountPaise: bigint };

function journalDb() {
  const entries: Entry[] = [];
  return {
    entries,
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(
        async ({ data }: { data: { entries: { create: Entry[] } } }) => {
          entries.push(...data.entries.create);
          return { id: `txn-${entries.length}` };
        },
      ),
    },
    ledgerAccount: { upsert: jest.fn().mockResolvedValue({}) },
    ledgerAccountBalance: { upsert: jest.fn(), findUnique: jest.fn() },
    ledgerEntry: {
      groupBy: jest.fn(async ({ where }: { where: { accountId: string } }) =>
        ["DEBIT", "CREDIT"].map((direction) => ({
          direction,
          _sum: {
            amountPaise: entries
              .filter(
                (e) =>
                  e.accountId === where.accountId && e.direction === direction,
              )
              .reduce((s, e) => s + e.amountPaise, BigInt(0)),
          },
        })),
      ),
    },
  };
}

const booking: Posting[] = [
  { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 118_000 },
  {
    account: { kind: "PLATFORM_FEE" },
    direction: "CREDIT",
    amountPaise: 20_000,
  },
  {
    account: { kind: "CONSULTANT_PAYABLE", consultantProfileId: "cp1" },
    direction: "CREDIT",
    amountPaise: 80_000,
  },
  {
    account: { kind: "GST_PAYABLE" },
    direction: "CREDIT",
    amountPaise: 18_000,
  },
];
const refund: Posting[] = [
  { account: { kind: "GST_PAYABLE" }, direction: "DEBIT", amountPaise: 9_000 },
  {
    account: { kind: "PLATFORM_FEE" },
    direction: "DEBIT",
    amountPaise: 50_000,
  },
  { account: { kind: "CASH" }, direction: "CREDIT", amountPaise: 59_000 },
];

describe("ledger balances — aggregated, never stored", () => {
  it("posting touches no system account's snapshot row, and both balance readings agree", async () => {
    const db = journalDb();
    await postLedgerTxn(db as never, {
      idempotencyKey: "booking:p1",
      kind: "BOOKING",
      postings: booking,
    });
    await postLedgerTxn(db as never, {
      idempotencyKey: "refund:r1",
      kind: "REFUND",
      postings: refund,
    });

    expect(db.ledgerAccountBalance.upsert).not.toHaveBeenCalled();

    for (const kind of ["CASH", "GST_PAYABLE", "PLATFORM_FEE"] as const) {
      const fromPostings = [...booking, ...refund]
        .filter((p) => ledgerAccountId(p.account) === ledgerAccountId({ kind }))
        .reduce(
          (s, p) =>
            s + (p.direction === "DEBIT" ? p.amountPaise : -p.amountPaise),
          0,
        );
      expect(await ledgerBalancePaise(db as never, { kind })).toBe(
        fromPostings,
      );
    }
    expect(db.ledgerAccountBalance.findUnique).not.toHaveBeenCalled();
  });
});
