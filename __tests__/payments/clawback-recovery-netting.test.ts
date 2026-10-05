/**
 * @jest-environment node
 *
 * A clawback owed by a consultant is netted from their next payout, never
 * below the payout floor, and whatever the payout cannot absorb carries to
 * the one after — all read from and posted to the ledger.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { txDouble } from "../fixtures/tx-double";
import {
  clawbackRecoveredPaise,
  outstandingClawbackPaise,
  recoverClawbackOnPayout,
  recoverablePaise,
} from "@/lib/payments/payouts/clawback-recovery";

type Entry = {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amountPaise: bigint;
};
type Txn = {
  idempotencyKey: string;
  payoutId: string | null;
  entries: Entry[];
};

/** Just enough of the journal for postLedgerTxn and the recovery reads. */
function fakeLedger(seed: Txn[]) {
  const txns = [...seed];
  const pick = (t: Txn, direction?: string) => ({
    idempotencyKey: t.idempotencyKey,
    payoutId: t.payoutId,
    entries: t.entries.filter((e) => !direction || e.direction === direction),
  });
  return txDouble({
    ledgerAccount: { upsert: jest.fn().mockResolvedValue({}) },
    ledgerTransaction: {
      findUnique: jest.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          txns.find((t) => t.idempotencyKey === where.idempotencyKey) ?? null,
      ),
      findMany: jest.fn(
        async (args: {
          where: {
            idempotencyKey: { in?: string[]; startsWith?: string };
            entries?: { some: { accountId: string } };
          };
          select: { entries?: { where?: { direction: string } } };
        }) =>
          txns
            .filter((t) => {
              const k = args.where.idempotencyKey;
              if (k.in && !k.in.includes(t.idempotencyKey)) return false;
              if (k.startsWith && !t.idempotencyKey.startsWith(k.startsWith))
                return false;
              const some = args.where.entries?.some;
              return (
                !some || t.entries.some((e) => e.accountId === some.accountId)
              );
            })
            .map((t) => pick(t, args.select.entries?.where?.direction)),
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            idempotencyKey: string;
            payoutId: string | null;
            entries: { create: Entry[] };
          };
        }) => {
          txns.push({
            idempotencyKey: data.idempotencyKey,
            payoutId: data.payoutId,
            entries: data.entries.create,
          });
          return { id: data.idempotencyKey };
        },
      ),
    },
    ledgerEntry: {
      groupBy: jest.fn(async ({ where }: { where: { accountId: string } }) => {
        const sums = { DEBIT: BigInt(0), CREDIT: BigInt(0) };
        for (const t of txns)
          for (const e of t.entries)
            if (e.accountId === where.accountId)
              sums[e.direction] += e.amountPaise;
        return (["DEBIT", "CREDIT"] as const).map((direction) => ({
          direction,
          _sum: { amountPaise: sums[direction] },
        }));
      }),
    },
    consultantPayout: { findMany: jest.fn().mockResolvedValue([]) },
  });
}

const CP = "cp_1";
const RECEIVABLE = `CONSULTANT_RECEIVABLE|_|${CP}|INR`;
const PAYABLE = `CONSULTANT_PAYABLE|_|${CP}|INR`;
const payee = { rail: "CONSULTANT" as const, consultantProfileId: CP };

it("nets the clawback from the next payout and carries the remainder", async () => {
  // A ₹1,500 refund landed after an earlier payout was paid.
  const db = fakeLedger([
    {
      idempotencyKey: "clawback:rf_1:po_0",
      payoutId: "po_0",
      entries: [
        {
          accountId: RECEIVABLE,
          direction: "DEBIT",
          amountPaise: BigInt(150_000),
        },
        {
          accountId: PAYABLE,
          direction: "CREDIT",
          amountPaise: BigInt(150_000),
        },
      ],
    },
  ]);

  // ₹2,000 releasable keeps the ₹500 floor and 20% withholding room: ₹1,100 can go.
  const first = await recoverClawbackOnPayout(db, {
    payee,
    payoutId: "po_1",
    recoverablePaise: recoverablePaise(200_000, 50_000, false),
  });
  expect(first).toBe(110_000);
  expect(await clawbackRecoveredPaise(db, "po_1")).toBe(110_000);
  expect(await outstandingClawbackPaise(db, payee)).toBe(40_000);

  // The ₹400 remainder comes out of the following payout.
  const second = await recoverClawbackOnPayout(db, {
    payee,
    payoutId: "po_2",
    recoverablePaise: recoverablePaise(200_000, 50_000, false),
  });
  expect(second).toBe(40_000);
  expect(await outstandingClawbackPaise(db, payee)).toBe(0);
});
