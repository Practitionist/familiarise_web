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

import { recordOverageAtCheckout } from "@/lib/payments/billing/overage-settlement";
import { txDouble } from "../fixtures/tx-double";

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
  walletDebit: jest.fn().mockResolvedValue(undefined),
  walletCredit: jest.fn().mockResolvedValue(undefined),
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
  const legOf = (src: string): Leg => {
    const leg = legs.find((l) => l.source === src);
    if (!leg) throw new Error(`no ${src} leg`);
    return leg;
  };
  return {
    state: { legs, payment, children, childLegSums },
    tx: {
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
      },
      bookingUtilization: {
        findUnique: jest.fn().mockResolvedValue({ id: "bu1" }),
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
            data: { amount: number; legs?: { create: Leg } };
          }) => {
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
    expect(state.legs).toEqual([
      { source: "WALLET", amountPaise: 129_500 },
    ]);
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
    });
    await recordOverageAtCheckout({
      tx: txDouble(tx),
      ...callArgs(100_000),
      isLazyAllocation: true,
    });

    expect(state.legs).toEqual([
      { source: "WALLET", amountPaise: 129_500 },
    ]);
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
            account: { kind: "WALLET", organizationId: "org1" },
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
