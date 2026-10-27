/**
 * @jest-environment node
 */

// Invariant: one ledger transaction ensures its distinct accounts with one ordered insert on the caller's client.

jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import { ledgerAccountId, postLedgerTxn } from "@/lib/payments/ledger/post";
import type { PrismaLike } from "@/lib/prisma";

it("dedupes repeated accounts into one createMany and keeps each entry on its account", async () => {
  const createMany = jest.fn(async () => ({ count: 2 }));
  const create = jest.fn(async () => ({ id: "ltxn_1" }));
  const db = {
    ledgerAccount: { createMany },
    ledgerTransaction: { findUnique: jest.fn(async () => null), create },
  } as unknown as PrismaLike;
  const wallet = { kind: "WALLET" as const, organizationId: "org_1" };
  const cash = { kind: "CASH" as const };

  await postLedgerTxn(db, {
    idempotencyKey: "k1",
    kind: "BOOKING",
    postings: [
      { account: wallet, direction: "DEBIT", amountPaise: 100 },
      { account: cash, direction: "CREDIT", amountPaise: 60 },
      { account: cash, direction: "CREDIT", amountPaise: 40 },
    ],
  });

  expect(createMany).toHaveBeenCalledTimes(1);
  expect(createMany).toHaveBeenCalledWith({
    data: [ledgerAccountId(cash), ledgerAccountId(wallet)].map((id) =>
      expect.objectContaining({ id, currency: "INR" }),
    ),
    skipDuplicates: true,
  });
  const entries = (
    create.mock.calls[0] as unknown as [
      { data: { entries: { create: { accountId: string }[] } } },
    ]
  )[0].data.entries.create;
  expect(entries.map((e) => e.accountId)).toEqual([
    ledgerAccountId(wallet),
    ledgerAccountId(cash),
    ledgerAccountId(cash),
  ]);
});
