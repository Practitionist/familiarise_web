/**
 * @jest-environment node
 */

// Invariant: a replay on a posted key never rewrites or throws; one that differs from the stored
// journal is reported once per key, and a retryable write conflict is not an unexpected fault.

jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { ledgerAccountId, postLedgerTxn } from "@/lib/payments/ledger/post";
import type { PrismaLike } from "@/lib/prisma";

const cash = { kind: "CASH" as const };
const clearing = { kind: "GATEWAY_CLEARING" as const };
const fee = { kind: "PLATFORM_FEE" as const };

/** The journal already stored under the key: Dr CASH 100 / Cr GATEWAY_CLEARING 100. */
const stored = {
  id: "ltxn_stored",
  entries: [
    {
      accountId: ledgerAccountId(cash),
      direction: "DEBIT",
      amountPaise: BigInt(100),
    },
    {
      accountId: ledgerAccountId(clearing),
      direction: "CREDIT",
      amountPaise: BigInt(100),
    },
  ],
};

function dbWith(over: {
  findUnique?: jest.Mock;
  create?: jest.Mock;
}): PrismaLike & { create: jest.Mock } {
  const create = over.create ?? jest.fn(async () => ({ id: "ltxn_new" }));
  return {
    ledgerAccount: { createMany: jest.fn(async () => ({ count: 0 })) },
    ledgerTransaction: {
      findUnique: over.findUnique ?? jest.fn(async () => stored),
      create,
    },
    create,
  } as unknown as PrismaLike & { create: jest.Mock };
}

const mismatchReports = () =>
  jest
    .mocked(reportSentryMessage)
    .mock.calls.filter(([message]) => message.includes("differs"));

beforeEach(() => jest.clearAllMocks());

it("a replay with the same debit total and accounts is a quiet no-op", async () => {
  const db = dbWith({});

  const result = await postLedgerTxn(db, {
    idempotencyKey: "settlement:same",
    kind: "GATEWAY_SETTLEMENT",
    postings: [
      { account: cash, direction: "DEBIT", amountPaise: 100 },
      { account: clearing, direction: "CREDIT", amountPaise: 100 },
    ],
  });

  expect(result).toEqual({ transactionId: "ltxn_stored", created: false });
  expect(db.create).not.toHaveBeenCalled();
  expect(mismatchReports()).toHaveLength(0);
});

it.each([
  [
    "a different debit total",
    [
      { account: cash, direction: "DEBIT" as const, amountPaise: 150 },
      { account: clearing, direction: "CREDIT" as const, amountPaise: 150 },
    ],
  ],
  [
    "a different account set",
    [
      { account: cash, direction: "DEBIT" as const, amountPaise: 100 },
      { account: fee, direction: "CREDIT" as const, amountPaise: 100 },
    ],
  ],
])(
  "a replay with %s returns created:false, writes nothing and reports the key once",
  async (label, postings) => {
    const db = dbWith({});
    const input = {
      idempotencyKey: `settlement:${label}`,
      kind: "GATEWAY_SETTLEMENT" as const,
      postings,
    };

    const first = await postLedgerTxn(db, input);
    const second = await postLedgerTxn(db, input);

    expect(first).toEqual({ transactionId: "ltxn_stored", created: false });
    expect(second).toEqual(first);
    expect(db.create).not.toHaveBeenCalled();
    expect(mismatchReports()).toHaveLength(1);
    expect(mismatchReports()[0][1]).toMatchObject({
      level: "error",
      extra: expect.objectContaining({
        idempotencyKey: input.idempotencyKey,
        storedDebitPaise: 100,
      }),
    });
    expect(mismatchReports()[0][1].expected).toBeUndefined();
  },
);

it("a retryable write conflict on the insert is rethrown and reported as expected; any other failure is a fault", async () => {
  const conflict = Object.assign(new Error("could not serialize access"), {
    code: "P2034",
  });
  const broken = new Error("connection reset");
  const post = (err: Error) =>
    postLedgerTxn(
      dbWith({
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => {
          throw err;
        }),
      }),
      {
        idempotencyKey: "booking:pay_1",
        kind: "BOOKING",
        postings: [
          { account: cash, direction: "DEBIT", amountPaise: 100 },
          { account: clearing, direction: "CREDIT", amountPaise: 100 },
        ],
      },
    );

  await expect(post(conflict)).rejects.toBe(conflict);
  await expect(post(broken)).rejects.toBe(broken);

  const reports = jest.mocked(reportSentryError).mock.calls;
  expect(reports.find(([err]) => err === conflict)?.[1]).toMatchObject({
    expected: true,
  });
  expect(reports.find(([err]) => err === broken)?.[1].expected).toBeFalsy();
});
