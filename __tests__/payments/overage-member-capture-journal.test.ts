/**
 * @jest-environment node
 */

/**
 * A member-paid overage capture reverses the platform's DISCOUNT carve for the
 * base and books the surcharge as PLATFORM_FEE; refunding it nets every account
 * to zero. Runs the real capture handler, the real refund cascade and the real
 * postLedgerTxn over an in-memory ledger.
 */

import { handleOverageMemberSuccess } from "@/lib/payments/webhooks/overage-handlers";
import { applyRefundCascade } from "@/lib/payments/operations/refund";
import { txDouble } from "../fixtures/tx-double";
import { memLedgerJournals } from "../fixtures/mem-ledger-journals";

const mockTx: Record<string, unknown> = {};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  },
}));
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(async () => 1),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  releaseOverageHeldParentEarnings: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoiceBestEffort: jest.fn(async () => ({})),
  mintConsumerCreditNote: jest.fn(async () => null),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const SIDE = "side-1";
const BASE = 100_000;
const SURCHARGE = 25_000;
const TAX = 4_500;
const AMOUNT = BASE + SURCHARGE + TAX;

type Entry = {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amountPaise: bigint;
};
type Txn = {
  idempotencyKey: string;
  kind: string;
  paymentId: string | null;
  entries: { create: Entry[] };
};
type EntryWhere = {
  account: { kind: { in?: string[]; not?: string } };
  transaction: { paymentId: string; OR?: { idempotencyKey?: string }[] };
};

function makeWorld() {
  const txns: Txn[] = [];
  const refunds: { id: string; amountPaise: number; status: string }[] = [];
  const side = {
    id: SIDE,
    amount: AMOUNT,
    originalAmount: BASE + SURCHARGE,
    taxAmount: TAX,
    organizationId: "org-iitm",
    paymentStatus: "PENDING",
    parentPaymentId: "parent-1",
    billingAccountId: null,
    billableToOrgInvoiceId: null,
    appointmentId: null,
    paymentIntent: "order_1",
    createdAt: new Date(),
  };
  const legs = [{ id: "leg-1", source: "CARD", amountPaise: AMOUNT }];
  const entryRows = (where: EntryWhere) =>
    txns
      .filter((t) => t.paymentId === where.transaction.paymentId)
      .filter(
        (t) =>
          !where.transaction.OR ||
          t.kind === "REFUND" ||
          t.idempotencyKey === where.transaction.OR[0].idempotencyKey,
      )
      .flatMap((t) =>
        t.entries.create.map((e) => {
          const [kind, org] = e.accountId.split("|");
          return {
            ...e,
            account: { kind, organizationId: org === "_" ? null : org },
            transaction: { kind: t.kind },
          };
        }),
      )
      .filter((e) =>
        where.account.kind.in
          ? where.account.kind.in.includes(e.account.kind)
          : e.account.kind !== where.account.kind.not,
      );
  Object.assign(mockTx, {
    ...memLedgerJournals(txns),
    ledgerEntry: {
      findMany: jest.fn(async ({ where }: { where: EntryWhere }) =>
        entryRows(where),
      ),
    },
    payment: {
      findUnique: jest.fn(async () => side),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({
        ...side,
        legs,
        earnings: [],
        organizationEarnings: [],
        bookingUtilization: null,
        appointment: null,
        refunds,
        disputes: [],
      })),
    },
    paymentLeg: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => legs),
      upsert: jest.fn(async () => ({})),
    },
    overageEvent: {
      findFirst: jest.fn(async () => ({ basePaise: BASE })),
      findMany: jest.fn(async () => []),
    },
    refund: { updateMany: jest.fn(async () => ({ count: 1 })) },
    recordingPurchase: { updateMany: jest.fn(async () => ({ count: 0 })) },
    digitalProductPurchase: { findUnique: jest.fn(async () => null) },
    organizationInvoice: { findUnique: jest.fn(async () => null) },
    creditNote: { findUnique: jest.fn(async () => null) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
  });

  const refund = async (id: string, amountPaise: number) => {
    refunds.push({ id, amountPaise, status: "SUCCEEDED" });
    await applyRefundCascade(txDouble(mockTx), {
      paymentId: SIDE,
      refundId: id,
      amountPaise,
      reason: "member asked",
    });
  };
  const nets = () => {
    const out: Record<string, number> = {};
    for (const e of txns.flatMap((t) => t.entries.create)) {
      const kind = e.accountId.split("|")[0];
      out[kind] =
        (out[kind] ?? 0) +
        (e.direction === "DEBIT" ? 1 : -1) * Number(e.amountPaise);
    }
    return out;
  };
  return { refund, nets };
}

const zeroed = (nets: Record<string, number>) =>
  Object.fromEntries(Object.keys(nets).map((k) => [k, 0]));

describe("member-paid overage capture", () => {
  it.each([
    ["a full refund", [AMOUNT]],
    ["a 40% then 60% refund", [51_800, AMOUNT - 51_800]],
  ])(
    "credits DISCOUNT(base) + PLATFORM_FEE(surcharge), and %s nets every account to zero",
    async (_, parts) => {
      const world = makeWorld();
      await handleOverageMemberSuccess("order_1", AMOUNT, "pay_1");

      expect(world.nets()).toEqual({
        GATEWAY_CLEARING: AMOUNT,
        DISCOUNT: -BASE,
        PLATFORM_FEE: -SURCHARGE,
        GST_PAYABLE: -TAX,
      });

      for (const [i, paise] of parts.entries()) {
        await world.refund(`rf-${i}`, paise);
      }
      expect(world.nets()).toEqual(zeroed(world.nets()));
    },
  );
});
