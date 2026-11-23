/**
 * @jest-environment node
 */

/**
 * #785 — CHARGE_ORG overage must keep Σ(legs) == Payment.amount.
 *
 * The over-cap pass-through (basePaise) is already inside the base
 * INVOICE_ACCRUAL leg (coveredPaise + basePaise == price) AND the rollup sums
 * BOTH leg sources into the invoice — so the overage leg must CARVE basePaise
 * out of the base leg, not pile on top (which double-billed the org by basePaise
 * and broke the leg-sum invariant). Only the surcharge is genuinely-additional.
 */

import { runAsRegisteredPlatform } from "../fixtures/gst-registered";

import { recordOverageAtCheckout } from "@/lib/payments/billing/overage-settlement";
import {
  holdNewEarningsForUnpaidMemberOverage,
  restoreOverageBaseCarve,
} from "@/lib/payments/billing/overage-base-carve";
import { txDouble } from "../fixtures/tx-double";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";

// jest.mock resolves via jest's resolver (no `@/` path mapping) — use relative
// paths that resolve to the same module files the SUT imports as `@/…`.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  // only the MEMBER notify fire-and-forget touches the outer client; null ctx
  // short-circuits it (.then(ctx => if(!ctx) return)).
  default: { programAssignment: { findUnique: () => Promise.resolve(null) } },
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgProgramOverageDue: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  walletDebit: jest
    .fn()
    .mockResolvedValue({ balanceAfter: 0, ownerOrgId: "org_w" }),
  walletCredit: jest
    .fn()
    .mockResolvedValue({ balanceAfter: 0, ownerOrgId: "org_w" }),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue({ created: true }),
}));

type Leg = { source: string; amountPaise: number };
type Step = { increment?: number; decrement?: number };
type LegWhere = { where: { paymentId_source: { source: string } } };

/** Stateful mock tx that maintains the payment's legs + amount in memory. */
function makeTx(opts: {
  price: number;
  cap: number;
  used: number;
  surchargeBps?: number | null;
  priceCap?: number | null;
  overageBehavior?: "CHARGE_ORG" | "CHARGE_MEMBER";
  /** #1458 — which funding rail wrote the parent's base leg. */
  baseSource?: "INVOICE_ACCRUAL" | "WALLET" | "LICENSE";
  /** #1744 row 1 — a base leg that holds less than the price. */
  baseLegPaise?: number;
  /** Whether the parent's `booking:<id>` journal has already posted. */
  bookingJournal?: boolean;
}) {
  const legs: Leg[] = [
    {
      source: opts.baseSource ?? "INVOICE_ACCRUAL",
      // A licence leg is deliberately zero-value: the contract already paid.
      amountPaise:
        opts.baseSource === "LICENSE" ? 0 : (opts.baseLegPaise ?? opts.price),
    },
  ];
  const payment = { amount: opts.price, taxAmount: 0 };
  const children: { amount: number }[] = [];
  /** Σ legs each child Payment is created with: what the deferred leg-sum trigger sees. */
  const childLegSums: number[] = [];
  let childSeq = 0;
  /** Payment.paymentIntent is @unique: a repeated intent fails like Postgres does. */
  const intents = new Set<string>();
  const legOf = (src: string): Leg => {
    const leg = legs.find((l) => l.source === src);
    if (!leg) throw new Error(`no ${src} leg`);
    return leg;
  };
  const holds = createEarningsHoldStore();
  return {
    state: { legs, payment, children, childLegSums },
    holds,
    tx: {
      ...holds.db,
      organization: {
        findUnique: jest.fn().mockResolvedValue({ dataResidencyRegion: "IN" }),
      },
      program: {
        findFirst: jest.fn().mockResolvedValue({
          licensedSeatConfig: {
            overageBehavior: opts.overageBehavior ?? "CHARGE_ORG",
            priceCapPerEngagementPaise: opts.priceCap ?? null,
            coveredEngagementsPerCycle: opts.cap,
            overageSurchargeBps: opts.surchargeBps ?? null,
            maxOveragePerCyclePaise: null,
          },
          creditPoolConfig: null,
        }),
      },
      overageEvent: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { basePaise: 0, surchargePaise: 0 } }),
        create: jest.fn().mockResolvedValue({ id: "ev1" }),
        // The side payment the recorder minted is still unpaid.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingUtilization: {
        findUnique: jest.fn().mockResolvedValue({ id: "bu1" }),
      },
      ledgerTransaction: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.bookingJournal ? { id: "txn_booking" } : null,
          ),
      },
      paymentLeg: {
        findUnique: jest.fn(async ({ where }: LegWhere) => {
          const src = where.paymentId_source.source;
          return legs.find((l) => l.source === src) ?? null;
        }),
        update: jest.fn(
          async ({
            where,
            data,
          }: LegWhere & { data: { amountPaise: Step } }) => {
            const leg = legOf(where.paymentId_source.source);
            leg.amountPaise +=
              (data.amountPaise.increment ?? 0) -
              (data.amountPaise.decrement ?? 0);
          },
        ),
        create: jest.fn(async ({ data }: { data: Leg }) => {
          legs.push({ source: data.source, amountPaise: data.amountPaise });
        }),
      },
      payment: {
        create: jest.fn(
          async ({
            data,
          }: {
            data: {
              amount: number;
              paymentIntent?: string;
              legs?: { create: Leg };
            };
          }) => {
            if (data.paymentIntent && intents.has(data.paymentIntent)) {
              throw Object.assign(new Error("Unique constraint failed"), {
                code: "P2002",
              });
            }
            if (data.paymentIntent) intents.add(data.paymentIntent);
            children.push({ amount: data.amount });
            childLegSums.push(data.legs?.create.amountPaise ?? 0);
            return { id: `child${++childSeq}` };
          },
        ),
        update: jest.fn(
          async ({ data }: { data: { amount?: Step; taxAmount?: Step } }) => {
            payment.taxAmount += data.taxAmount?.increment ?? 0;
            payment.amount += data.amount?.increment ?? 0;
            payment.amount -= data.amount?.decrement ?? 0;
          },
        ),
        findUnique: jest.fn<
          Promise<{
            amount: number;
            billingAccountId?: string | null;
            billableToOrgInvoiceId?: string | null;
          } | null>,
          [unknown?]
        >(async () => ({
          amount: payment.amount,
          billingAccountId: "ba1",
        })),
      },
    },
  };
}

const callArgs = (price: number) => ({
  programAssignmentId: "asg1",
  utilization: {
    programType: "LICENSED_SEAT" as const,
    engagementsConsumedDelta: 1,
    engagementsUsedAfter: 6,
    consumedPaiseAfter: 0,
    creditBudgetPaise: null,
    usageLedgerEntryId: "ule-1",
  },
  bookingPricePaise: price,
  currency: "INR" as const,
  paymentId: "pay1",
  userId: "user1",
  organizationId: "org1",
  paymentGateway: "RAZORPAY" as const,
});

const sum = (legs: Leg[]) => legs.reduce((s, l) => s + l.amountPaise, 0);

describe("recordOverageAtCheckout — CHARGE_ORG leg-sum invariant (#785)", () => {
  it("no surcharge: carves basePaise out of the base leg, amount unchanged", async () => {
    const { state, tx } = makeTx({ price: 500_000, cap: 5, used: 5 });
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(500_000) });

    // base leg carved to 0 (whole over-cap engagement), overage holds the marginal
    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 0 },
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 500_000 },
    ]);
    expect(state.payment.amount).toBe(500_000); // surcharge=0 → no bump
    expect(sum(state.legs)).toBe(state.payment.amount); // Σlegs == amount
    // the rollup sums BOTH sources → must equal price, NOT 2×price
    expect(sum(state.legs)).toBe(500_000);
  });

  it("with surcharge: carves base, bumps amount by the surcharge only", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500, // +25%
    });
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });

    // base carved to 0; overage = base + surcharge + 18% GST on the surcharge
    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 0 },
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 129_500 },
    ]);
    expect(state.payment.amount).toBe(129_500);
    expect(state.payment.taxAmount).toBe(4_500); // the rollup bills it once, from taxAmount
    expect(sum(state.legs)).toBe(state.payment.amount);
  });

  it("partial over-cap (priceCap < price): base leg keeps the covered remainder", async () => {
    // priceCap caps the marginal at 40_000 of a 100_000 booking → covered 60_000.
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      priceCap: 40_000,
    });
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });

    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 60_000 }, // 100k − 40k carved
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 40_000 },
    ]);
    expect(state.payment.amount).toBe(100_000); // no surcharge → unchanged
    expect(sum(state.legs)).toBe(state.payment.amount); // covered + overage == price
  });

  it("#1744 row 1: a short base leg is carved to zero, never billed twice", async () => {
    // base 1_000 (whole booking over cap) but the base leg only holds 400.
    const { state, tx } = makeTx({
      price: 1_000,
      cap: 5,
      used: 5,
      baseLegPaise: 400,
    });
    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(1_000),
    });

    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 0 }, // carved min(400, 1_000)
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 1_000 },
    ]);
    // The rollup bills Σ(both sources) — exactly the marginal, not 1_400.
    expect(sum(state.legs)).toBe(1_000);
  });
});

describe("recordOverageAtCheckout — CHARGE_ORG on the WALLET and LICENSE rails", () => {
  it("leaves the payment at the wallet debit when surcharge is 0, adds no leg, and records the overage as collected", async () => {
    const walletDebit = 258_326;
    const { state, tx } = makeTx({
      price: walletDebit,
      cap: 5,
      used: 5,
      baseSource: "WALLET",
    });
    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(walletDebit),
    });

    expect(state.legs).toEqual([
      { source: "WALLET", amountPaise: walletDebit },
    ]);
    expect(state.payment.amount).toBe(walletDebit);
    expect(sum(state.legs)).toBe(state.payment.amount);
    expect(tx.paymentLeg.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();

    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "CHARGED",
          paymentId: "pay1",
          settledAt: expect.any(Date),
        }),
      }),
    );
  });

  it("WALLET + CHARGE_ORG with surcharge (#2005): debits surcharge + 18% GST from wallet, increments WALLET leg, amount, and taxAmount", async () => {
    const { walletDebit } = jest.requireMock(
      "../../lib/api/organizations/wallet",
    );
    walletDebit.mockClear();
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500,
      baseSource: "WALLET",
    });
    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
    });

    // 25_000 surcharge + 4_500 (18% GST) = 29_500 incremental wallet debit -> 129_500 total
    expect(walletDebit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        billingAccountId: "ba1",
        amountPaise: 29_500,
        reason: "BOOKING",
        paymentId: "pay1",
      }),
    );
    expect(state.legs).toEqual([{ source: "WALLET", amountPaise: 129_500 }]);
    expect(state.payment.amount).toBe(129_500);
    expect(state.payment.taxAmount).toBe(4_500);
    expect(sum(state.legs)).toBe(state.payment.amount);
    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "CHARGED",
          surchargePaise: 25_000,
          marginalPaise: 129_500,
          paymentId: "pay1",
        }),
      }),
    );
  });

  it("WALLET + CHARGE_ORG lazy allocation with surcharge (#2005): debits wallet and posts BOOKING journal crediting PLATFORM_FEE and GST_PAYABLE", async () => {
    const { postLedgerTxn } = jest.requireMock(
      "../../lib/payments/ledger/post",
    );
    postLedgerTxn.mockClear();
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500,
      baseSource: "WALLET",
      bookingJournal: true,
    });
    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
      isLazyAllocation: true,
    });

    expect(state.legs).toEqual([{ source: "WALLET", amountPaise: 129_500 }]);
    expect(state.payment.amount).toBe(129_500);
    expect(state.payment.taxAmount).toBe(4_500);
    expect(postLedgerTxn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: "overage-accrual:ev1",
        kind: "BOOKING",
        paymentId: "pay1",
        postings: [
          {
            account: { kind: "WALLET", organizationId: "org_w" },
            direction: "DEBIT",
            amountPaise: 29_500,
          },
          {
            account: { kind: "PLATFORM_FEE" },
            direction: "CREDIT",
            amountPaise: 25_000,
          },
          {
            account: { kind: "GST_PAYABLE" },
            direction: "CREDIT",
            amountPaise: 4_500,
          },
        ],
      }),
    );
  });

  it("WALLET + CHARGE_ORG surcharge journals against the wallet's owner even with a null organizationId, or leaves it to an unposted booking journal", async () => {
    const { postLedgerTxn } = jest.requireMock(
      "../../lib/payments/ledger/post",
    );
    const run = (bookingJournal: boolean) => {
      postLedgerTxn.mockClear();
      const { tx } = makeTx({
        price: 100_000,
        cap: 5,
        used: 5,
        surchargeBps: 2500,
        baseSource: "WALLET",
        bookingJournal,
      });
      return recordOverageAtCheckout({
        tx: txDouble(tx),
        ...callArgs(100_000),
        organizationId: null,
      });
    };

    await run(true);
    expect(postLedgerTxn).toHaveBeenCalledTimes(1);
    expect(postLedgerTxn.mock.calls[0][1]).toMatchObject({
      idempotencyKey: "overage-accrual:ev1",
      postings: [
        {
          account: { kind: "WALLET", organizationId: "org_w" },
          direction: "DEBIT",
          amountPaise: 29_500,
        },
        { account: { kind: "PLATFORM_FEE" }, amountPaise: 25_000 },
        { account: { kind: "GST_PAYABLE" }, amountPaise: 4_500 },
      ],
    });

    await run(false);
    expect(postLedgerTxn).not.toHaveBeenCalled();
  });

  it("LICENSE + CHARGE_ORG mints a standalone child accrual payment (incl. GST on surcharge) without mutating the 0-paise LICENSE parent", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500,
      baseSource: "LICENSE",
    });

    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
    });

    expect(tx.paymentLeg.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(state.legs).toEqual([{ source: "LICENSE", amountPaise: 0 }]);
    expect(state.children).toEqual([{ amount: 129_500 }]);
    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "PENDING",
          basePaise: 100_000,
          surchargePaise: 25_000,
          marginalPaise: 129_500,
          paymentId: "child1",
        }),
      }),
    );
  });
});

describe("recordOverageAtCheckout — CHARGE_MEMBER parent carve (#785)", () => {
  it("carves basePaise off the org parent; member child pays the marginal (no double-collect)", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500, // +25% → member owes 125_000
      overageBehavior: "CHARGE_MEMBER",
    });
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });

    // org parent: base leg + amount shed basePaise (100_000) → org pays coveredPaise (0)
    expect(state.legs).toEqual([{ source: "INVOICE_ACCRUAL", amountPaise: 0 }]);
    expect(state.payment.amount).toBe(0);
    expect(sum(state.legs)).toBe(state.payment.amount); // parent stays consistent
    // member side-charge holds base + surcharge + 18% GST on the surcharge
    expect(state.children).toEqual([{ amount: 129_500 }]);
    // and is born with a CARD leg for all of it, so the leg-sum trigger passes at COMMIT
    expect(state.childLegSums).toEqual([129_500]);
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taxAmount: 4_500 }),
      }),
    );
    // basePaise is collected once (from the member), never twice.
    const totalCollected = sum(state.legs) + state.children[0].amount;
    expect(totalCollected).toBe(129_500);
  });

  it("at checkout finds no earnings yet; the earnings written after it start held", async () => {
    const { holds, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      overageBehavior: "CHARGE_MEMBER",
      baseSource: "LICENSE",
    });
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });
    expect(holds.holds).toEqual([]);

    // The checkout's earnings writer runs after the recorder.
    holds.consultant.push({ id: "ce1", paymentId: "pay1", status: "PENDING" });
    holds.org.push({ id: "oe1", paymentId: "pay1", status: "PENDING" });
    await holdNewEarningsForUnpaidMemberOverage(txDouble(tx), "pay1");

    for (const row of [...holds.consultant, ...holds.org]) {
      expect(row).toMatchObject({ status: "HELD", preHoldStatus: "PENDING" });
      expect(holds.activeReasons(row.id)).toEqual(["OVERAGE"]);
    }
  });

  it("partial over-cap: org parent keeps the covered remainder, member pays the capped marginal", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      priceCap: 40_000, // marginal capped at 40_000 → covered 60_000
      overageBehavior: "CHARGE_MEMBER",
    });
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });

    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 60_000 }, // covered remainder
    ]);
    expect(state.payment.amount).toBe(60_000);
    expect(state.children).toEqual([{ amount: 40_000 }]); // member pays the overage
    // org(60_000) + member(40_000) == price(100_000), no double-collect.
    expect(sum(state.legs) + state.children[0].amount).toBe(100_000);
  });

  it("OverageEvent + side-Payment mirror the booking currency (no hardcoded INR)", async () => {
    const { tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      overageBehavior: "CHARGE_MEMBER",
    });
    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
      currency: "USD" as const,
    });

    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: "USD" }),
      }),
    );
    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currency: "USD",
          overageBehavior: "CHARGE_MEMBER",
        }),
      }),
    );
  });

  it("lazy allocation (#1895): leaves an already-invoiced parent untouched under CHARGE_MEMBER and creates the side payment", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500,
      overageBehavior: "CHARGE_MEMBER",
    });
    tx.payment.findUnique.mockResolvedValue({
      amount: 100_000,
      billableToOrgInvoiceId: "inv_issued_1",
    });

    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
      isLazyAllocation: true,
    });

    // Parent payment and its leg are NOT mutated because parent is already invoiced
    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 100_000 },
    ]);
    expect(state.payment.amount).toBe(100_000);
    // Side-charge Payment and OverageEvent ARE created for the surcharge (+ GST) only
    expect(state.children).toEqual([{ amount: 29_500 }]);
    expect(tx.overageEvent.create).toHaveBeenCalledTimes(1);
  });

  it("lazy allocation (#1895): creates a child accrual Payment for surchargePaise > 0 without mutating the already-invoiced parent under CHARGE_ORG", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500, // 25_000 surcharge
      overageBehavior: "CHARGE_ORG",
    });
    tx.payment.findUnique.mockResolvedValue({
      amount: 100_000,
      billableToOrgInvoiceId: "inv_issued_1",
    });

    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
      isLazyAllocation: true,
    });

    // Parent is untouched; a standalone child accrual Payment carries the surcharge + GST
    expect(state.payment.amount).toBe(100_000);
    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 100_000 },
    ]);
    expect(state.children).toEqual([{ amount: 29_500 }]);
    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "PENDING",
          basePaise: 0,
          surchargePaise: 25_000,
          marginalPaise: 29_500,
          paymentId: "child1",
        }),
      }),
    );
  });

  it("lazy allocation (#1895): records an ACCRUED CHARGE_ORG OverageEvent with 0 marginal when parent is already invoiced and surcharge is 0", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 0,
      overageBehavior: "CHARGE_ORG",
    });
    tx.payment.findUnique.mockResolvedValue({
      amount: 100_000,
      billableToOrgInvoiceId: "inv_issued_1",
    });

    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
      isLazyAllocation: true,
    });

    expect(state.payment.amount).toBe(100_000);
    expect(state.children).toEqual([]);
    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "ACCRUED",
          basePaise: 0,
          surchargePaise: 0,
          marginalPaise: 0,
          paymentId: "pay1",
        }),
      }),
    );
  });
});

describe("recordOverageAtCheckout — CHARGE_MEMBER carve on a WALLET parent", () => {
  const carveCreditCalls = () =>
    (
      jest.requireMock("../../lib/payments/ledger/post")
        .postLedgerTxn as jest.Mock
    ).mock.calls.filter(([, txn]) =>
      String(txn.idempotencyKey).startsWith("overage-carve-credit:"),
    );
  const memberWalletTx = (bookingJournal: boolean) =>
    makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      overageBehavior: "CHARGE_MEMBER",
      baseSource: "WALLET",
      bookingJournal,
    });

  beforeEach(() => {
    jest
      .requireMock("../../lib/payments/ledger/post")
      .postLedgerTxn.mockClear();
    jest
      .requireMock("../../lib/api/organizations/wallet")
      .walletCredit.mockClear();
  });

  it("credits the carved base back with a balanced Dr DISCOUNT / Cr WALLET line against the wallet's owner", async () => {
    const { state, tx } = memberWalletTx(true);
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });

    expect(state.legs).toEqual([{ source: "WALLET", amountPaise: 0 }]);
    expect(
      jest.requireMock("../../lib/api/organizations/wallet").walletCredit,
    ).toHaveBeenCalledWith(expect.anything(), {
      billingAccountId: "ba1",
      amountPaise: 100_000,
      reason: "REFUND",
      paymentId: "pay1",
    });
    expect(carveCreditCalls()).toEqual([
      [
        expect.anything(),
        expect.objectContaining({
          idempotencyKey: "overage-carve-credit:ev1",
          paymentId: "pay1",
          postings: [
            {
              account: { kind: "DISCOUNT" },
              direction: "DEBIT",
              amountPaise: 100_000,
            },
            {
              account: { kind: "WALLET", organizationId: "org_w" },
              direction: "CREDIT",
              amountPaise: 100_000,
            },
          ],
        }),
      ],
    ]);
  });

  it("posts no line before the booking journal, which tallies the post-carve leg", async () => {
    const { tx } = memberWalletTx(false);
    await recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });
    expect(carveCreditCalls()).toEqual([]);
  });

  it("refuses a second run of the same batch at its batch-keyed side payment, before any second line", async () => {
    const { state, tx } = memberWalletTx(true);
    const run = () =>
      recordOverageAtCheckout({ tx: txDouble(tx), ...callArgs(100_000) });
    await run();
    state.legs[0].amountPaise = 100_000;

    await expect(run()).rejects.toMatchObject({ code: "P2002" });
    expect(tx.payment.create.mock.calls[1][0].data.paymentIntent).toBe(
      "overage:pay1:ule-1",
    );
    expect(carveCreditCalls()).toHaveLength(1);
  });
});

describe("restoreOverageBaseCarve — WALLET and LICENSE parent rails", () => {
  it("WALLET parent: re-debits wallet, increments parent WALLET leg + amount, and releases overage-held earnings", async () => {
    const { walletDebit } = jest.requireMock(
      "../../lib/api/organizations/wallet",
    );
    walletDebit.mockClear();

    // Checkout wrote the parent's earning after recording the overage.
    const holds = createEarningsHoldStore();
    holds.consultant.push({
      id: "ce_wallet_1",
      paymentId: "parent_wallet_1",
      status: "PENDING",
      holdUntil: null,
    });
    const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const legUpdate = jest.fn().mockResolvedValue({});
    const mockTx = {
      overageEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: "oe_wallet_1",
          basePaise: 40_000,
          overageBehavior: "CHARGE_MEMBER",
          payment: { id: "side_wallet_1", parentPaymentId: "parent_wallet_1" },
        }),
        // Unpaid when the earning is written; none left once this one fails.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: "parent_wallet_1",
          billableToOrgInvoiceId: null,
          billingAccountId: "ba_wallet_1",
        }),
        updateMany: paymentUpdateMany,
      },
      paymentLeg: {
        findUnique: jest
          .fn()
          .mockImplementation(
            async ({
              where,
            }: {
              where: { paymentId_source: { source: string } };
            }) =>
              where.paymentId_source.source === "WALLET"
                ? { amountPaise: 60_000 }
                : null,
          ),
        update: legUpdate,
      },
      ledgerTransaction: {
        findUnique: jest.fn().mockResolvedValue({ id: "txn_booking" }),
      },
      ...holds.db,
    };
    const { postLedgerTxn } = jest.requireMock(
      "../../lib/payments/ledger/post",
    );
    postLedgerTxn.mockClear();
    await holdNewEarningsForUnpaidMemberOverage(
      mockTx as never,
      "parent_wallet_1",
    );
    expect(holds.activeReasons("ce_wallet_1")).toEqual(["OVERAGE"]);

    const outcome = await restoreOverageBaseCarve(mockTx as never, {
      sidePaymentId: "side_wallet_1",
    });

    expect(outcome).toBe("restored");
    expect(walletDebit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        billingAccountId: "ba_wallet_1",
        amountPaise: 40_000,
        reason: "BOOKING",
        paymentId: "parent_wallet_1",
      }),
    );
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "parent_wallet_1" },
      data: { amount: { increment: 40_000 } },
    });
    expect(legUpdate).toHaveBeenCalledWith({
      where: {
        paymentId_source: { paymentId: "parent_wallet_1", source: "WALLET" },
      },
      data: { amountPaise: { increment: 40_000 } },
    });
    expect(holds.consultant[0]).toMatchObject({
      status: "PENDING",
      preHoldStatus: null,
    });
    expect(holds.activeReasons("ce_wallet_1")).toEqual([]);
    // The re-debit carries its own balanced journal, moving the base off DISCOUNT.
    expect(postLedgerTxn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: "overage-restore:oe_wallet_1",
        postings: [
          {
            account: { kind: "WALLET", organizationId: "org_w" },
            direction: "DEBIT",
            amountPaise: 40_000,
          },
          {
            account: { kind: "DISCOUNT" },
            direction: "CREDIT",
            amountPaise: 40_000,
          },
        ],
      }),
    );
    postLedgerTxn.mockResolvedValueOnce({ created: false });
    await expect(
      restoreOverageBaseCarve(mockTx as never, {
        sidePaymentId: "side_wallet_1",
      }),
    ).rejects.toThrow(/already restored/);
  });

  it("LICENSE parent: leaves ₹0 LICENSE leg untouched and keeps parent earnings HELD when member side-charge fails", async () => {
    const holds = createEarningsHoldStore();
    holds.consultant.push({
      id: "ce_license_1",
      paymentId: "parent_license_1",
      status: "PENDING",
    });
    const paymentUpdateMany = jest.fn();
    const legUpdate = jest.fn();

    const mockTx = {
      ...holds.db,
      overageEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: "oe_license_1",
          basePaise: 40_000,
          overageBehavior: "CHARGE_MEMBER",
          payment: {
            id: "side_license_1",
            parentPaymentId: "parent_license_1",
          },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: "parent_license_1",
          billableToOrgInvoiceId: null,
          billingAccountId: "ba_license_1",
        }),
        updateMany: paymentUpdateMany,
      },
      paymentLeg: {
        findUnique: jest
          .fn()
          .mockImplementation(
            async ({
              where,
            }: {
              where: { paymentId_source: { source: string } };
            }) =>
              where.paymentId_source.source === "LICENSE"
                ? { amountPaise: 0 }
                : null,
          ),
        update: legUpdate,
      },
    };
    // The earning written at checkout starts held for the unpaid overage.
    await holdNewEarningsForUnpaidMemberOverage(
      mockTx as never,
      "parent_license_1",
    );

    const outcome = await restoreOverageBaseCarve(mockTx as never, {
      sidePaymentId: "side_license_1",
    });

    expect(outcome).toBe("none");
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(legUpdate).not.toHaveBeenCalled();
    expect(holds.consultant[0]).toMatchObject({
      status: "HELD",
      preHoldStatus: "PENDING",
    });
    expect(holds.activeReasons("ce_license_1")).toEqual(["OVERAGE"]);
  });
});

// Priced and invoiced as a GST-registered platform.
runAsRegisteredPlatform();
