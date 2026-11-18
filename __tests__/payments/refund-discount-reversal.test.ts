/**
 * @jest-environment node
 */

/**
 * A refund reverses the booking's DISCOUNT with its funding, so a full refund
 * nets every ledger account of the payment to zero. Runs the real booking
 * journal builder, the real refund cascade and the real postLedgerTxn over an
 * in-memory ledger.
 */

import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";
import { applyRefundCascade } from "@/lib/payments/operations/refund";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { txDouble } from "../fixtures/tx-double";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";
import { memLedgerJournals } from "../fixtures/mem-ledger-journals";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/api/organizations/wallet", () => ({
  walletCredit: jest.fn(async () => ({
    balanceAfter: 0,
    ownerOrgId: "org-iitm",
  })),
}));
jest.mock("../../lib/collaborators/revenue-split", () => ({
  calculateRevenueSplit: jest.fn(async () => []),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: jest.fn(async () => ({ reversed: true })),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerCreditNote: jest.fn(async () => null),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const ORG = "org-iitm";
const PAYMENT_ID = "pay-1";
const ORIGINAL = 1_140_071;
const TAX = 205_213;
const GROSS = ORIGINAL + TAX;
const DISCOUNT = 285_018;
const FUNDED = GROSS - DISCOUNT;

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
type Refund = {
  id: string;
  amountPaise: number;
  status: string;
  cascadedAt: Date | null;
  deletedAt: null;
};

function makeWorld(rail: "CARD" | "WALLET") {
  const txns: Txn[] = [];
  const holds = createEarningsHoldStore();
  const refunds: Refund[] = [];
  const legs = [
    {
      id: "leg-1",
      source: rail,
      amountPaise: rail === "CARD" ? FUNDED : GROSS,
    },
  ];
  const payment = {
    id: PAYMENT_ID,
    amount: legs[0].amountPaise,
    originalAmount: ORIGINAL,
    taxAmount: TAX,
    createdAt: new Date(),
    organizationId: rail === "WALLET" ? ORG : null,
    billingAccountId: rail === "WALLET" ? "ba-iitm" : null,
    billableToOrgInvoiceId: null,
    parentPaymentId: null,
    appointmentId: "appt-1",
    paymentIntent: "intent-1",
  };
  const tx = {
    ...holds.db,
    consultantEarnings: {
      ...holds.db.consultantEarnings,
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => {
        const row = {
          id: `ce-${holds.consultant.length}`,
          refundedShareAmount: 0,
          payoutId: null,
          payout: null,
          ...data,
        };
        holds.consultant.push({ ...row, paymentId: PAYMENT_ID } as never);
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { refundedShareAmount: number; status?: string };
        }) => {
          const row = holds.consultant.find((e) => e.id === where.id);
          Object.assign(row ?? {}, data);
          return { count: row ? 1 : 0 };
        },
      ),
    },
    ...memLedgerJournals(txns),
    ledgerEntry: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            account: { kind: { in: string[] } };
            transaction: { paymentId: string };
          };
        }) =>
          txns
            .filter((t) => t.paymentId === where.transaction.paymentId)
            .flatMap((t) =>
              t.entries.create
                .map((e) => ({
                  ...e,
                  account: { kind: e.accountId.split("|")[0] },
                  transaction: { kind: t.kind },
                }))
                .filter((e) => where.account.kind.in.includes(e.account.kind)),
            ),
      ),
    },
    paymentLeg: {
      findMany: jest.fn(async () => legs),
      upsert: jest.fn(async () => ({})),
    },
    payment: {
      findUniqueOrThrow: jest.fn(async () => ({
        ...payment,
        legs,
        earnings: holds.consultant,
        organizationEarnings: [],
        bookingUtilization: null,
        appointment: null,
        refunds,
        disputes: [],
      })),
      findUnique: jest.fn(async () => payment),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    refund: { updateMany: jest.fn(async () => ({ count: 1 })) },
    billingAccount: { findUnique: jest.fn(async () => ({ ownerOrgId: ORG })) },
    supportCase: { findMany: jest.fn(async () => []) },
    platformFeeSchedule: { findFirst: jest.fn(async () => null) },
    consultantFeeWaiver: { findFirst: jest.fn(async () => null) },
    expertCustomerRelationship: { findUnique: jest.fn(async () => null) },
    membership: { findFirst: jest.fn(async () => null) },
    organization: {
      findUnique: jest.fn(async () => ({
        status: "ACTIVE",
        dataResidencyRegion: "IN",
      })),
    },
    organizationInvoice: { findUnique: jest.fn(async () => null) },
    creditNote: { findUnique: jest.fn(async () => null) },
    overageEvent: { findMany: jest.fn(async () => []) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
  };

  const book = () =>
    createEarningsFromPayment({
      payment: {
        ...payment,
        appointmentId: null,
        appointment: { consultantProfile: { id: "consultant-1" } },
      } as unknown as Parameters<
        typeof createEarningsFromPayment
      >[0]["payment"],
      appointmentType: "CONSULTATION",
      teamAt: new Date("2026-10-09T10:00:00Z"),
      tx: txDouble(tx),
    });
  // A member overage carved after the booking journal: Dr DISCOUNT / Cr WALLET.
  const carve = async () => {
    legs[0].amountPaise -= DISCOUNT;
    payment.amount -= DISCOUNT;
    await postLedgerTxn(txDouble(tx), {
      idempotencyKey: "overage-carve-credit:ev-1",
      kind: "OVERAGE_MEMBER",
      paymentId: PAYMENT_ID,
      postings: [
        {
          account: { kind: "DISCOUNT" },
          direction: "DEBIT",
          amountPaise: DISCOUNT,
        },
        {
          account: { kind: "WALLET", organizationId: ORG },
          direction: "CREDIT",
          amountPaise: DISCOUNT,
        },
      ],
    });
  };
  // A gateway-SUCCEEDED refund whose cascade has not run yet.
  const settle = (id: string, amountPaise: number) => {
    refunds.push({
      id,
      amountPaise,
      status: "SUCCEEDED",
      cascadedAt: null,
      deletedAt: null,
    });
  };
  const cascade = async (id: string) => {
    const row = refunds.find((r) => r.id === id);
    if (!row) throw new Error(`no refund ${id}`);
    await applyRefundCascade(txDouble(tx), {
      paymentId: PAYMENT_ID,
      refundId: id,
      amountPaise: row.amountPaise,
      reason: "cancellation",
    });
    row.cascadedAt = new Date();
  };
  const refund = async (id: string, amountPaise: number) => {
    settle(id, amountPaise);
    await cascade(id);
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
  return { book, carve, settle, cascade, refund, nets };
}

const zeroed = (nets: Record<string, number>) =>
  Object.fromEntries(Object.keys(nets).map((k) => [k, 0]));

describe("a refund reverses the booking's DISCOUNT pro rata", () => {
  it("a full refund of a discounted card booking nets every account to zero", async () => {
    const world = makeWorld("CARD");
    await world.book();
    expect(world.nets().DISCOUNT).toBe(DISCOUNT);

    await world.refund("rf-1", FUNDED);
    expect(world.nets()).toEqual(zeroed(world.nets()));
  });

  it("a full refund of a carved wallet booking reverses both journals' DISCOUNT", async () => {
    const world = makeWorld("WALLET");
    await world.book();
    await world.carve();
    expect(world.nets().DISCOUNT).toBe(DISCOUNT);

    await world.refund("rf-1", FUNDED);
    expect(world.nets()).toEqual(zeroed(world.nets()));
  });

  it("a 40% then 60% refund ends every account at exactly zero", async () => {
    const world = makeWorld("WALLET");
    await world.book();
    await world.carve();
    const first = Math.floor(FUNDED * 0.4);

    await world.refund("rf-1", first);
    expect(world.nets().DISCOUNT).toBe(
      DISCOUNT - Math.floor((DISCOUNT * first) / FUNDED),
    );
    await world.refund("rf-2", FUNDED - first);
    expect(world.nets()).toEqual(zeroed(world.nets()));
  });

  it("two SUCCEEDED but uncascaded refunds each reverse their own share; the second takes the remainder", async () => {
    const world = makeWorld("WALLET");
    await world.book();
    await world.carve();
    const first = Math.floor(FUNDED * 0.4);
    world.settle("rf-1", first);
    world.settle("rf-2", FUNDED - first);

    await world.cascade("rf-1");
    expect(world.nets().DISCOUNT).toBe(
      DISCOUNT - Math.floor((DISCOUNT * first) / FUNDED),
    );
    await world.cascade("rf-2");
    expect(world.nets()).toEqual(zeroed(world.nets()));
  });
});
