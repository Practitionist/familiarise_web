/**
 * @jest-environment node
 */

/**
 * A confirmed top-up first settles the org's open shortfall receivable and
 * credits the wallet only with the rest, in one balanced journal, so the cached
 * balance equals balance(WALLET). Invoice accruals stay with their invoices.
 * Runs the real confirmTopUp and postLedgerTxn over an in-memory ledger.
 */

import { confirmTopUp } from "@/lib/api/organizations/wallet";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import type { Db } from "@/lib/prisma";
import { txDouble } from "../fixtures/tx-double";
import { memLedgerJournals } from "../fixtures/mem-ledger-journals";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const ORG = "org-iitm";
const RECEIVABLE = `ORG_RECEIVABLE|${ORG}|_|INR`;
const WALLET = `WALLET|${ORG}|_|INR`;

type Entry = {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amountPaise: bigint;
};
type Txn = { idempotencyKey: string; entries: { create: Entry[] } };
type EntryWhere = {
  account: { kind: string; organizationId: string };
  transaction: { OR: { idempotencyKey: { startsWith: string } }[] };
};

async function makeWorld(topUpPaise: number) {
  const txns: Txn[] = [];
  const account = { walletBalance: 0 as number | null, ownerOrgId: ORG };
  const tx = {
    ...memLedgerJournals(txns),
    ledgerEntry: {
      findMany: jest.fn(async ({ where }: { where: EntryWhere }) =>
        txns
          .filter((t) =>
            where.transaction.OR.some((o) =>
              t.idempotencyKey.startsWith(o.idempotencyKey.startsWith),
            ),
          )
          .flatMap((t) => t.entries.create)
          .filter((e) => e.accountId === RECEIVABLE),
      ),
    },
    walletTopUp: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({
        billingAccountId: "ba-iitm",
        amountPaise: topUpPaise,
      })),
    },
    billingAccount: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(
        async ({
          data,
        }: {
          data: { walletBalance: { increment: number } };
        }) => {
          account.walletBalance =
            (account.walletBalance ?? 0) + data.walletBalance.increment;
          return { ...account, currency: "INR" };
        },
      ),
      findUniqueOrThrow: jest.fn(async () => account),
    },
    systemEvent: { findFirst: jest.fn(async () => null) },
    organization: {
      findUnique: jest.fn(async () => ({ status: "ACTIVE", deletedAt: null })),
    },
  };
  // An abandoned member overage the wallet could not restore, and an invoice accrual.
  const receivable = (
    key: string,
    paise: number,
    credit: "DISCOUNT" | "PLATFORM_FEE",
  ) =>
    postLedgerTxn(txDouble(tx), {
      idempotencyKey: key,
      kind: "OVERAGE_MEMBER",
      postings: [
        {
          account: { kind: "ORG_RECEIVABLE", organizationId: ORG },
          direction: "DEBIT",
          amountPaise: paise,
        },
        {
          account: { kind: credit },
          direction: "CREDIT",
          amountPaise: paise,
        },
      ],
    });
  await receivable("overage-restore:ev-1", 25_000, "DISCOUNT");
  await receivable("booking:pay-invoiced", 40_000, "PLATFORM_FEE");

  const db = {
    walletTopUp: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
  const confirm = () =>
    confirmTopUp(db, {
      providerOrderId: "we_1",
      providerPaymentId: "pay_1",
      amountPaise: topUpPaise,
    });
  const net = (accountId: string) =>
    txns
      .flatMap((t) => t.entries.create)
      .filter((e) => e.accountId === accountId)
      .reduce(
        (s, e) =>
          s + (e.direction === "CREDIT" ? 1 : -1) * Number(e.amountPaise),
        0,
      );
  return { account, confirm, net, tx };
}

describe("a top-up settles the org's open receivable first", () => {
  it("₹1,000 against ₹250 owed credits the wallet ₹750", async () => {
    const world = await makeWorld(100_000);

    const result = await world.confirm();

    expect(result).toEqual({
      confirmed: true,
      balanceAfter: 75_000,
      receivableSettledPaise: 25_000,
    });
    expect(world.account.walletBalance).toBe(75_000);
    expect(world.net(WALLET)).toBe(75_000);
    expect(world.net(RECEIVABLE)).toBe(-40_000);
  });

  it("a late capture on an abandoned (FAILED) top-up is credited like a pending one", async () => {
    const world = await makeWorld(100_000);
    world.tx.walletTopUp.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await world.confirm();

    expect(world.tx.walletTopUp.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { providerOrderId: "we_1", status: "FAILED" },
      }),
    );
    expect(result).toEqual({
      confirmed: true,
      balanceAfter: 75_000,
      receivableSettledPaise: 25_000,
    });
    expect(world.net(WALLET)).toBe(75_000);
  });

  it("a top-up smaller than the receivable leaves the wallet at zero", async () => {
    const world = await makeWorld(20_000);

    const result = await world.confirm();

    expect(result.receivableSettledPaise).toBe(20_000);
    expect(world.account.walletBalance).toBe(0);
    expect(world.net(WALLET)).toBe(0);
    expect(world.net(RECEIVABLE)).toBe(-45_000);
  });
});
