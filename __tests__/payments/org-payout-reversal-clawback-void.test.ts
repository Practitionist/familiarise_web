/**
 * @jest-environment node
 *
 * A bank-returned org payout voids the still-unrecovered part of the clawbacks
 * raised on it, so the org's next payout does not net that refund a second time.
 */

type Entry = {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amountPaise: bigint;
};
type Txn = {
  id: string;
  idempotencyKey: string;
  kind: string;
  payoutId: string | null;
  entries: Entry[];
};
type KeyFilter = { in?: string[]; startsWith?: string };
type EntryWhere = {
  accountId: string;
  direction?: string;
  transaction?: { OR: { idempotencyKey: KeyFilter }[] };
};

const ledger: Txn[] = [];
const keyMatches = (key: string, f: KeyFilter) =>
  (!f.in || f.in.includes(key)) &&
  (!f.startsWith || key.startsWith(f.startsWith));
const accountOf = (id: string) => {
  const [kind, org, cp] = id.split("|");
  return {
    kind,
    organizationId: org === "_" ? null : org,
    consultantProfileId: cp === "_" ? null : cp,
  };
};
const entriesWhere = (w: EntryWhere) =>
  ledger.flatMap((t) =>
    (w.transaction?.OR ?? [{ idempotencyKey: {} }]).some((o) =>
      keyMatches(t.idempotencyKey, o.idempotencyKey),
    )
      ? t.entries
          .filter(
            (e) =>
              e.accountId === w.accountId &&
              (!w.direction || e.direction === w.direction),
          )
          .map((e) => ({ ...e, transactionId: t.id }))
      : [],
  );

const db = {
  organizationPayout: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: jest.fn(async () => ({
      id: "op_0",
      organizationId: "org_1",
      netPayoutPaise: 100_000,
      amountPaise: 99_900,
      tdsAmountPaise: 100,
      currency: "INR",
      organization: { name: "Org" },
    })),
  },
  organizationEarnings: { updateMany: jest.fn(async () => ({ count: 1 })) },
  orgAuditLog: { create: jest.fn(async () => ({})) },
  ledgerAccount: { createMany: jest.fn(async () => ({ count: 0 })) },
  ledgerTransaction: {
    findUnique: jest.fn(
      async ({ where }: { where: { idempotencyKey: string } }) =>
        ledger.find((t) => t.idempotencyKey === where.idempotencyKey) ?? null,
    ),
    findMany: jest.fn(
      async (args: {
        where: { payoutId?: string; idempotencyKey: KeyFilter };
        select: { entries?: { where?: { direction: string } } };
      }) =>
        ledger
          .filter(
            (t) =>
              (!args.where.payoutId || t.payoutId === args.where.payoutId) &&
              keyMatches(t.idempotencyKey, args.where.idempotencyKey),
          )
          .map((t) => ({
            ...t,
            entries: t.entries
              .filter(
                (e) =>
                  !args.select.entries?.where ||
                  e.direction === args.select.entries.where.direction,
              )
              .map((e) => ({ ...e, account: accountOf(e.accountId) })),
          })),
    ),
    create: jest.fn(
      async ({
        data,
      }: {
        data: Omit<Txn, "id" | "entries"> & { entries: { create: Entry[] } };
      }) => {
        const id = `tx_${ledger.length}`;
        ledger.push({ ...data, id, entries: data.entries.create });
        return { id };
      },
    ),
  },
  ledgerEntry: {
    findMany: jest.fn(async ({ where }: { where: EntryWhere }) =>
      entriesWhere(where),
    ),
    groupBy: jest.fn(async ({ where }: { where: EntryWhere }) =>
      (["DEBIT", "CREDIT"] as const).map((direction) => ({
        direction,
        _sum: {
          amountPaise: entriesWhere({ ...where, direction }).reduce(
            (s, e) => s + e.amountPaise,
            BigInt(0),
          ),
        },
      })),
    ),
  },
  $transaction: jest.fn(
    async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db),
  ),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));
const recordSystemEventSafe = jest.fn(async (_e: unknown) => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
  recordSystemEventSafe: (e: unknown) => recordSystemEventSafe(e),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  ...jest.requireActual("../../lib/payments/tax/tds-service"),
  recordOrgTdsReversal: jest.fn(async () => undefined),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgPayoutFailed: jest.fn(async () => []),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  getRazorpayPayoutsService: jest.fn(),
}));

import { markOrgPayoutReversed } from "@/lib/payments/payouts/org-payout-service";
import {
  outstandingClawbackPaise,
  recoverClawbackOnPayout,
} from "@/lib/payments/payouts/clawback-recovery";

const ORG_RECEIVABLE = "ORG_RECEIVABLE|org_1|_|INR";
const ORG_PAYABLE = "ORG_PAYABLE|org_1|_|INR";
const payee = { rail: "ORG" as const, organizationId: "org_1" };
const journal = (
  idempotencyKey: string,
  payoutId: string,
  dr: string,
  cr: string,
  paise: number,
) =>
  ledger.push({
    id: `tx_${ledger.length}`,
    idempotencyKey,
    kind: "ORG_PAYOUT",
    payoutId,
    entries: [
      { accountId: dr, direction: "DEBIT", amountPaise: BigInt(paise) },
      { accountId: cr, direction: "CREDIT", amountPaise: BigInt(paise) },
    ],
  });

beforeEach(() => {
  jest.clearAllMocks();
  ledger.length = 0;
  // op_0 completed; a ₹400 refund on one of its earnings raised a clawback on it.
  journal("clawback:rf_1:op_0", "op_0", ORG_RECEIVABLE, ORG_PAYABLE, 40_000);
});

it("voids the whole clawback when nothing recovered it, so the next payout nets nothing", async () => {
  await markOrgPayoutReversed("op_0", "bank returned funds");

  expect(ledger.map((t) => t.idempotencyKey)).toContain(
    "clawback-void:clawback:rf_1:op_0",
  );
  expect(await outstandingClawbackPaise(db as never, payee)).toBe(0);
  await expect(
    recoverClawbackOnPayout(db as never, {
      payee,
      payoutId: "op_2",
      recoverablePaise: 100_000,
    }),
  ).resolves.toBe(0);
  expect(recordSystemEventSafe).not.toHaveBeenCalled();
});

it("voids only the remainder once a later payout recovered part of it, and alerts", async () => {
  // op_1 already netted ₹250 of the ₹400 before the bank returned op_0.
  journal(
    "clawback-recovery:op_1",
    "op_1",
    ORG_PAYABLE,
    ORG_RECEIVABLE,
    25_000,
  );

  await markOrgPayoutReversed("op_0", "bank returned funds");

  const voided = ledger.find((t) =>
    t.idempotencyKey.startsWith("clawback-void:"),
  );
  expect(voided?.entries.map((e) => Number(e.amountPaise))).toEqual([
    15_000, 15_000,
  ]);
  expect(await outstandingClawbackPaise(db as never, payee)).toBe(0);
  expect(recordSystemEventSafe).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: "org_1",
      message: expect.stringContaining(
        "PAYOUT_REVERSED_CLAWBACK_ALREADY_RECOVERED",
      ),
      context: expect.objectContaining({
        voidedPaise: 15_000,
        alreadyRecoveredPaise: 25_000,
      }),
    }),
  );
});
