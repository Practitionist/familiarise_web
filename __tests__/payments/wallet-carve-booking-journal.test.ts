/**
 * @jest-environment node
 */

/**
 * A wallet-funded booking whose CHARGE_MEMBER overage carves the base back to
 * the org must leave balance(WALLET) equal to the post-carve WALLET leg, in
 * either order of booking journal and carve. Runs the real booking journal
 * builder, the real carve and the real postLedgerTxn over an in-memory ledger.
 */

import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";
import { recordOverageAtCheckout } from "@/lib/payments/billing/overage-settlement";
import { walletCredit } from "@/lib/api/organizations/wallet";
import { txDouble } from "../fixtures/tx-double";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { programAssignment: { findUnique: () => Promise.resolve(null) } },
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgProgramOverageDue: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  walletCredit: jest
    .fn()
    .mockResolvedValue({ balanceAfter: 0, ownerOrgId: "org-iitm" }),
  walletDebit: jest
    .fn()
    .mockResolvedValue({ balanceAfter: 0, ownerOrgId: "org-iitm" }),
}));
jest.mock("../../lib/collaborators/revenue-split", () => ({
  calculateRevenueSplit: jest.fn().mockResolvedValue([]),
}));

const ORG = "org-iitm";
const PAYMENT_ID = "pay-wallet";
const ORIGINAL = 1_140_071;
const TAX = 205_213;
const GROSS = ORIGINAL + TAX;
const BASE = 285_018;
const WALLET_ACCOUNT = `WALLET|${ORG}|_|INR`;

type Entry = {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amountPaise: bigint;
};
type Txn = { idempotencyKey: string; entries: { create: Entry[] } };

function makeWorld(legPaise: number) {
  const txns: Txn[] = [];
  const leg = { source: "WALLET", amountPaise: legPaise };
  const payment = { amount: legPaise, taxAmount: TAX };
  const holds = createEarningsHoldStore();
  const tx = {
    ...holds.db,
    consultantEarnings: {
      ...holds.db.consultantEarnings,
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: { status: "PENDING" } }) => {
        const row = { id: `ce-${holds.consultant.length}`, ...data };
        holds.consultant.push({ ...row, paymentId: PAYMENT_ID });
        return row;
      }),
    },
    ledgerTransaction: {
      findUnique: jest.fn(
        async ({ where }: { where: { idempotencyKey: string } }) => {
          const i = txns.findIndex(
            (t) => t.idempotencyKey === where.idempotencyKey,
          );
          return i < 0 ? null : { id: `ltxn-${i}` };
        },
      ),
      create: jest.fn(async ({ data }: { data: Txn }) => {
        txns.push(data);
        return { id: `ltxn-${txns.length - 1}` };
      }),
    },
    ledgerAccount: {
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    paymentLeg: {
      findMany: jest.fn(async () => [{ ...leg }]),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { paymentId_source: { source: string } };
        }) => (where.paymentId_source.source === "WALLET" ? { ...leg } : null),
      ),
      update: jest.fn(
        async ({
          data,
        }: {
          data: { amountPaise: { decrement?: number; increment?: number } };
        }) => {
          leg.amountPaise +=
            (data.amountPaise.increment ?? 0) -
            (data.amountPaise.decrement ?? 0);
        },
      ),
    },
    payment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(
        async ({ data }: { data: { amount?: { decrement?: number } } }) => {
          payment.amount -= data.amount?.decrement ?? 0;
        },
      ),
      findUnique: jest.fn(async () => ({
        amount: payment.amount,
        billingAccountId: "ba-iitm",
      })),
      create: jest.fn(async () => ({ id: "side-1" })),
    },
    supportCase: { findMany: jest.fn(async () => []) },
    platformFeeSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    consultantFeeWaiver: { findFirst: jest.fn().mockResolvedValue(null) },
    expertCustomerRelationship: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    membership: { findFirst: jest.fn().mockResolvedValue(null) },
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: "ACTIVE", dataResidencyRegion: "IN" }),
    },
    organizationInvoice: { count: jest.fn().mockResolvedValue(1) },
    program: {
      findFirst: jest.fn().mockResolvedValue({
        licensedSeatConfig: {
          overageBehavior: "CHARGE_MEMBER",
          priceCapPerEngagementPaise: BASE,
          coveredEngagementsPerCycle: 5,
          overageSurchargeBps: null,
          maxOveragePerCyclePaise: null,
        },
        creditPoolConfig: null,
      }),
    },
    overageEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { basePaise: 0, surchargePaise: 0 } }),
      create: jest.fn().mockResolvedValue({ id: "ev-1" }),
    },
    bookingUtilization: {
      findUnique: jest.fn().mockResolvedValue({ id: "bu" }),
    },
  };

  const journal = () =>
    createEarningsFromPayment({
      payment: {
        id: PAYMENT_ID,
        amount: payment.amount,
        originalAmount: ORIGINAL,
        taxAmount: TAX,
        organizationId: ORG,
        billingAccountId: "ba-iitm",
        createdAt: new Date("2026-10-18T17:57:57Z"),
        appointment: { consultantProfile: { id: "consultant-1" } },
      } as unknown as Parameters<
        typeof createEarningsFromPayment
      >[0]["payment"],
      appointmentType: "CONSULTATION",
      teamAt: new Date("2026-10-09T10:00:00Z"),
      tx: txDouble(tx),
    });
  const carve = () =>
    recordOverageAtCheckout({
      tx: txDouble(tx),
      programAssignmentId: "asg-1",
      utilization: {
        programType: "LICENSED_SEAT",
        engagementsConsumedDelta: 1,
        engagementsUsedAfter: 6,
        consumedPaiseAfter: 0,
        creditBudgetPaise: null,
        usageLedgerEntryId: "ule-1",
      },
      bookingPricePaise: GROSS,
      currency: "INR",
      paymentId: PAYMENT_ID,
      userId: "member-1",
      organizationId: ORG,
      paymentGateway: "RAZORPAY",
      isLazyAllocation: true,
    });
  const net = (accountId: string) =>
    txns
      .flatMap((t) => t.entries.create)
      .filter((e) => e.accountId === accountId)
      .reduce(
        (s, e) =>
          s + (e.direction === "DEBIT" ? 1 : -1) * Number(e.amountPaise),
        0,
      );
  const balanced = () => txns.every((t) => sumSigned(t) === 0);
  return { leg, journal, carve, net, balanced };
}

function sumSigned(t: Txn): number {
  return t.entries.create.reduce(
    (s, e) => s + (e.direction === "DEBIT" ? 1 : -1) * Number(e.amountPaise),
    0,
  );
}

describe("wallet-funded booking with a member overage carve", () => {
  it.each([
    ["the carve lands after the booking journal", true],
    ["the carve lands before the booking journal", false],
  ])("balance(WALLET) equals the post-carve leg when %s", async (_, after) => {
    const world = makeWorld(GROSS);
    if (after) {
      await world.journal();
      await world.carve();
    } else {
      await world.carve();
      await world.journal();
    }

    expect(world.leg.amountPaise).toBe(GROSS - BASE);
    expect(world.net(WALLET_ACCOUNT)).toBe(GROSS - BASE);
    expect(world.net("DISCOUNT|_|_|INR")).toBe(BASE);
    expect(world.net("PLATFORM_FEE|_|_|INR")).toBe(-228_014);
    expect(world.balanced()).toBe(true);
    expect(walletCredit).toHaveBeenCalledTimes(1);
    expect(walletCredit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        billingAccountId: "ba-iitm",
        amountPaise: BASE,
      }),
    );
  });
});
