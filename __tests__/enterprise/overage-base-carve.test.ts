/**
 * @jest-environment node
 */

/**
 * #812 §P0 — basePaise carve bookkeeping. FAILing a CHARGE_MEMBER side-charge
 * must return the carved basePaise to the org's parent accrual (restore);
 * the recovery edges (retry / late capture) must take it back out (recarve).
 * An already-invoiced parent must never have its leg silently diverged from
 * the issued document — those return "invoiced" for the caller to surface.
 */

import {
  restoreOverageBaseCarve,
  recarveOverageBase,
} from "@/lib/payments/billing/overage-base-carve";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";

const mockWalletCredit = jest.fn();
const mockOpenShortfall = jest.fn();
jest.mock("../../lib/api/organizations/wallet", () => ({
  walletCredit: (...a: unknown[]) => mockWalletCredit(...a),
  openShortfallReceivablePaise: (...a: unknown[]) => mockOpenShortfall(...a),
}));
const mockPostLedgerTxn = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));

interface MockOpts {
  event?: object | null;
  parent?: object | null;
  legUpdateManyCount?: number;
  parentUpdateManyCount?: number;
  unpaidSiblings?: number;
}

function mockTx(opts: MockOpts = {}) {
  const event =
    opts.event === undefined
      ? {
          id: "ov1",
          basePaise: 300,
          overageBehavior: "CHARGE_MEMBER",
          payment: { id: "side1", parentPaymentId: "parent1" },
        }
      : opts.event;
  const parent =
    opts.parent === undefined
      ? { id: "parent1", billableToOrgInvoiceId: null }
      : opts.parent;
  const legUpdate = jest.fn().mockResolvedValue({});
  const legUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: opts.legUpdateManyCount ?? 1 });
  const paymentUpdate = jest.fn().mockResolvedValue({});
  const paymentUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: opts.parentUpdateManyCount ?? 1 });
  const eventCount = jest.fn().mockResolvedValue(opts.unpaidSiblings ?? 0);
  // The parent's one consultant earning, held by its member overage.
  const holds = createEarningsHoldStore();
  holds.consultant.push({
    id: "ce1",
    paymentId: "parent1",
    status: "HELD",
    preHoldStatus: "PENDING",
    holdUntil: null,
  });
  holds.holds.push({
    id: "h1",
    consultantEarningsId: "ce1",
    organizationEarningsId: null,
    reason: "OVERAGE",
    sourceRef: "parent1",
    placedAt: new Date(0),
    releasedAt: null,
    releasedById: null,
    note: null,
  });
  const earningsUpdateMany = jest.fn(holds.db.consultantEarnings.updateMany);
  return {
    holds,
    legUpdate,
    legUpdateMany,
    paymentUpdate,
    paymentUpdateMany,
    eventCount,
    earningsUpdateMany,
    tx: {
      overageEvent: {
        findFirst: jest.fn().mockResolvedValue(event),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: eventCount,
      },
      ...holds.db,
      consultantEarnings: {
        ...holds.db.consultantEarnings,
        updateMany: earningsUpdateMany,
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(parent),
        update: paymentUpdate,
        updateMany: paymentUpdateMany,
      },
      paymentLeg: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: legUpdate,
        updateMany: legUpdateMany,
      },
    } as never,
  };
}

describe("restoreOverageBaseCarve", () => {
  it("increments the parent (guarded on uninvoiced) and the leg by basePaise", async () => {
    const m = mockTx();
    await expect(
      restoreOverageBaseCarve(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("restored");
    // TOCTOU guard: the invoiced check rides the parent UPDATE's WHERE.
    expect(m.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "parent1", billableToOrgInvoiceId: null },
      data: { amount: { increment: 300 } },
    });
    expect(m.legUpdate).toHaveBeenCalledWith({
      where: {
        paymentId_source: { paymentId: "parent1", source: "INVOICE_ACCRUAL" },
      },
      data: { amountPaise: { increment: 300 } },
    });
  });

  it("keeps the parent's earnings held while another batch's member overage is unpaid", async () => {
    const held = mockTx({ unpaidSiblings: 1 });
    await restoreOverageBaseCarve(held.tx, { overageEventId: "ov1" });
    expect(held.eventCount).toHaveBeenCalledWith({
      where: {
        overageBehavior: "CHARGE_MEMBER",
        chargeStatus: { in: ["PENDING"] },
        paymentId: { not: "side1" },
        payment: { parentPaymentId: "parent1" },
      },
    });
    // The held rows are locked before the count, and never released.
    expect(held.earningsUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      held.eventCount.mock.invocationCallOrder[0],
    );
    expect(held.holds.consultant[0].status).toBe("HELD");
    expect(held.holds.activeReasons("ce1")).toEqual(["OVERAGE"]);

    const last = mockTx();
    await restoreOverageBaseCarve(last.tx, { overageEventId: "ov1" });
    expect(last.holds.consultant[0]).toMatchObject({
      status: "PENDING",
      preHoldStatus: null,
    });
    expect(last.holds.activeReasons("ce1")).toEqual([]);
  });

  it("returns invoiced (no leg writes) when the guarded parent update matches no row", async () => {
    const m = mockTx({
      parent: { id: "parent1", billableToOrgInvoiceId: "inv1" },
      parentUpdateManyCount: 0,
    });
    await expect(
      restoreOverageBaseCarve(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("invoiced");
    expect(m.legUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "zero basePaise",
      {
        id: "ov1",
        basePaise: 0,
        overageBehavior: "CHARGE_MEMBER",
        payment: { id: "s", parentPaymentId: "p" },
      },
    ],
    [
      "CHARGE_ORG event",
      {
        id: "ov1",
        basePaise: 300,
        overageBehavior: "CHARGE_ORG",
        payment: { id: "s", parentPaymentId: "p" },
      },
    ],
    [
      "no parent linkage",
      {
        id: "ov1",
        basePaise: 300,
        overageBehavior: "CHARGE_MEMBER",
        payment: { id: "s", parentPaymentId: null },
      },
    ],
    ["missing event", null],
  ])("is a no-op for %s", async (_label, event) => {
    const m = mockTx({ event });
    await expect(
      restoreOverageBaseCarve(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("none");
    expect(m.legUpdate).not.toHaveBeenCalled();
  });

  it("resolves the event via the side payment id too", async () => {
    const m = mockTx();
    await restoreOverageBaseCarve(m.tx, { sidePaymentId: "side1" });
    expect(
      (m.tx as never as { overageEvent: { findFirst: jest.Mock } }).overageEvent
        .findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: "side1" } }),
    );
  });
});

describe("recarveOverageBase", () => {
  it("decrements the parent (guarded on uninvoiced) then the leg (guarded)", async () => {
    const m = mockTx();
    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("recarved");
    expect(m.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "parent1", billableToOrgInvoiceId: null },
      data: { amount: { decrement: 300 } },
    });
    expect(m.legUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "parent1",
        source: "INVOICE_ACCRUAL",
        amountPaise: { gte: 300 },
      },
      data: { amountPaise: { decrement: 300 } },
    });
  });

  it("returns invoiced when the guarded parent update matches no row", async () => {
    const m = mockTx({
      parent: { id: "parent1", billableToOrgInvoiceId: "inv1" },
      parentUpdateManyCount: 0,
    });
    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("invoiced");
    expect(m.legUpdateMany).not.toHaveBeenCalled();
  });

  it("throws (rolling the tx back) when the leg lacks the restored base on an uninvoiced parent", async () => {
    const m = mockTx({ legUpdateManyCount: 0 });
    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).rejects.toThrow(/missing the restored basePaise/);
  });

  it("carves a wallet-restored base back onto the wallet and cancels its receivable", async () => {
    // Restore of 300: the wallet covered 200, 100 booked as ORG_RECEIVABLE, of
    // which a later top-up settled 60 (40 still open).
    const m = mockTx({
      parent: {
        id: "parent1",
        billableToOrgInvoiceId: null,
        billingAccountId: "ba1",
      },
    });
    const t = m.tx as unknown as Record<string, Record<string, unknown>>;
    t.paymentLeg.findUnique = jest.fn(
      async (a: { where: { paymentId_source: { source: string } } }) =>
        a.where.paymentId_source.source === "WALLET"
          ? { amountPaise: 1_200 }
          : null,
    );
    m.legUpdateMany.mockImplementation(
      async (a: { where: { source: string } }) => ({
        count: a.where.source === "WALLET" ? 1 : 0,
      }),
    );
    t.ledgerEntry = {
      findFirst: jest.fn().mockResolvedValue({ amountPaise: 100 }),
    };
    t.ledgerTransaction = {
      findUnique: jest.fn().mockResolvedValue({ id: "booking-txn" }),
    };
    t.billingAccount = {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ownerOrgId: "org1" }),
    };
    mockOpenShortfall.mockResolvedValue(40);
    mockWalletCredit.mockResolvedValue({ ownerOrgId: "org1" });
    mockPostLedgerTxn.mockResolvedValue({ created: true });

    await expect(
      recarveOverageBase(m.tx, { sidePaymentId: "side1" }),
    ).resolves.toBe("recarved");

    expect(m.legUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "parent1",
        source: "WALLET",
        amountPaise: { gte: 200 },
      },
      data: { amountPaise: { decrement: 200 } },
    });
    expect(mockWalletCredit).toHaveBeenCalledWith(
      m.tx,
      expect.objectContaining({ billingAccountId: "ba1", amountPaise: 260 }),
    );
    expect(mockPostLedgerTxn).toHaveBeenCalledWith(
      m.tx,
      expect.objectContaining({
        idempotencyKey: "overage-recarve:ov1",
        postings: [
          {
            account: { kind: "DISCOUNT" },
            direction: "DEBIT",
            amountPaise: 300,
          },
          {
            account: { kind: "WALLET", organizationId: "org1" },
            direction: "CREDIT",
            amountPaise: 260,
          },
          {
            account: { kind: "ORG_RECEIVABLE", organizationId: "org1" },
            direction: "CREDIT",
            amountPaise: 40,
          },
        ],
      }),
    );
  });

  it("adjusts a DRAFT OrganizationInvoice and its line item in-place and returns recarved (#1900)", async () => {
    const m = mockTx({
      parent: { id: "parent1", billableToOrgInvoiceId: "inv_draft" },
      parentUpdateManyCount: 0,
    });
    const invoiceUpdate = jest.fn().mockResolvedValue({});
    const lineItemUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txWithInvoice = m.tx as unknown as Record<string, unknown>;
    txWithInvoice.organizationInvoice = {
      findUnique: jest.fn().mockResolvedValue({
        id: "inv_draft",
        status: "DRAFT",
        subtotalPaise: 1000,
        cgstPaise: 90,
        sgstPaise: 90,
        igstPaise: 0,
        totalPaise: 1180,
      }),
      update: invoiceUpdate,
    };
    txWithInvoice.invoiceLineItem = {
      updateMany: lineItemUpdateMany,
    };
    // First paymentUpdateMany (billableToOrgInvoiceId: null) returns 0;
    // second paymentUpdateMany (billableToOrgInvoiceId: "inv_draft") returns 1.
    m.paymentUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("recarved");

    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: "inv_draft" },
      data: {
        subtotalPaise: 700,
        cgstPaise: 63,
        sgstPaise: 63,
        igstPaise: 0,
        totalPaise: 826,
        inrEquivalentPaise: 826,
      },
    });
    expect(lineItemUpdateMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv_draft", paymentId: "parent1" },
      data: {
        unitPricePaise: { decrement: 300 },
      },
    });
    expect(m.legUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "parent1",
        source: "INVOICE_ACCRUAL",
        amountPaise: { gte: 300 },
      },
      data: { amountPaise: { decrement: 300 } },
    });
  });
});

describe("transitionOverage fromIn narrowing (#812)", () => {
  function txWithSpy() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    return { updateMany, tx: { overageEvent: { updateMany } } as never };
  }

  it("narrows the guard to the requested subset", async () => {
    const m = txWithSpy();
    await transitionOverage(m.tx, { paymentId: "s1" }, "CHARGED", undefined, {
      fromIn: ["FAILED"],
    });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { paymentId: "s1", chargeStatus: { in: ["FAILED"] } },
      data: { chargeStatus: "CHARGED" },
    });
  });

  it("never widens beyond ALLOWED_FROM — illegal entries are intersected away", async () => {
    const m = txWithSpy();
    // REVERSED is not a legal source for CHARGED; only FAILED survives.
    await transitionOverage(m.tx, { paymentId: "s1" }, "CHARGED", undefined, {
      fromIn: ["FAILED", "REVERSED" as never],
    });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { paymentId: "s1", chargeStatus: { in: ["FAILED"] } },
      data: { chargeStatus: "CHARGED" },
    });
  });
});
