/**
 * @jest-environment node
 */

/**
 * Platform B2B invoicing: a void is a credit note that re-bills or writes off,
 * a bank transfer settles through the gateway's own paid transition, a capture
 * that cannot settle is parked, a credit note returns its PO share, and a
 * failed member overage can be settled to the org.
 */

const mockPost = jest.fn(async (_tx: unknown, _input: unknown) => ({
  transactionId: "t",
  created: true,
}));
const mockSystemEvent = jest.fn(async (_p: unknown) => undefined);
const mockMint = jest.fn();
const mockRemaining = jest.fn();
const mockRelease = jest.fn(async (..._a: unknown[]) => undefined);
const mockPay = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  findUniqueOrThrow: jest.fn(),
  updateMany: jest.fn(),
};
const mockPrisma = {
  organizationInvoice: mockPay,
  orgAuditLog: { create: jest.fn(async () => ({})) },
  creditNote: {
    groupBy: jest.fn(
      async (): Promise<
        { invoiceId: string; _sum: { totalPaise: bigint } }[]
      > => [],
    ),
  },
  organizationInvoiceReceipt: { groupBy: jest.fn(async () => []) },
  $transaction: jest.fn(),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
  readJobCheckpoint: jest.fn(async () => null),
  withCronLock: (
    _name: string,
    _options: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}));
jest.mock("@/lib/observability/standing-finding", () => ({
  reportStandingFinding: jest.fn(async () => false),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (tx: unknown, input: unknown) => mockPost(tx, input),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEventSafe: (p: unknown) => mockSystemEvent(p),
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(async () => []),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  mintInvoiceRefundCreditNote: (...a: unknown[]) => mockMint(...a),
  remainingOrgInvoiceCreditPaise: (...a: unknown[]) => mockRemaining(...a),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  lockHeldOverageEarnings: jest.fn(),
  releaseOverageHeldParentEarnings: (...a: unknown[]) => mockRelease(...a),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "m-1" },
    org: { id: "org-1", status: "PENDING_VERIFICATION" },
  })),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  moneyOpsLimiter: {},
}));
const mockCreateOrder = jest.fn(
  async (_p: { amount: number }, _timeoutMs?: number) => ({
    id: "order_new",
  }),
);
type MockOrder = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  notes: Record<string, string>;
};
type MockHolding =
  | { kind: "captured"; paymentId: string; amountPaise: number }
  | { kind: "live" | "empty" };
const mockFetchOrder = jest.fn<Promise<MockOrder | null>, [string, number?]>(
  async () => null,
);
const mockReadHolding = jest.fn<Promise<MockHolding>, [string, number?]>(
  async () => ({ kind: "empty" }),
);
jest.mock("../../lib/payments/core/razorpay", () => ({
  createRazorpayOrder: (p: { amount: number }, timeoutMs?: number) =>
    mockCreateOrder(p, timeoutMs),
  fetchRazorpayOrder: (orderId: string, timeoutMs?: number) =>
    mockFetchOrder(orderId, timeoutMs),
  readRazorpayOrderHolding: (orderId: string, timeoutMs?: number) =>
    mockReadHolding(orderId, timeoutMs),
}));

import { NextRequest } from "next/server";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import type { Tx } from "@/lib/prisma";
import { voidOrgInvoice } from "@/lib/payments/billing/org-invoice-void";
import {
  applyOrgInvoiceCapture,
  recordBankTransferReceipt,
} from "@/lib/payments/billing/org-invoice-settlement";
import { restorePurchaseOrderForCredit } from "@/lib/payments/billing/purchase-order-draw";
import { settleFailedMemberOverageAsOrg } from "@/lib/payments/billing/overage-settlement";
import { reconcileOrgInvoicePayments } from "@/lib/payments/billing/reconcile-invoice-payments";
import { POST as payInvoice } from "@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route";

type Posted = {
  idempotencyKey: string;
  postings: {
    account: { kind: string };
    direction: string;
    amountPaise: number;
  }[];
};
const posted = () => mockPost.mock.calls.map((c) => c[1] as Posted);

/** An invoice whose status, credit notes and receipts the code under test moves. */
function invoiceWorld(init: {
  status: string;
  totalPaise: number;
  creditedPaise?: number;
  billedPayments?: number;
  providerPaymentOrderId?: string;
}) {
  const state = {
    status: init.status,
    providerPaymentOrderId: init.providerPaymentOrderId ?? null,
    receipts: [] as { amountPaise: number; reference: string }[],
  };
  const row = () => ({
    id: "inv-1",
    organizationId: "org-1",
    invoiceNumber: "ACME-2026-0001",
    status: state.status,
    totalPaise: init.totalPaise,
    subtotalPaise: Math.round(init.totalPaise / 1.18),
    displayCurrency: "INR",
    providerPaymentId: null,
    providerPaymentOrderId: state.providerPaymentOrderId,
    irn: null,
    organization: { name: "Acme" },
    _count: {
      billedPayments: init.billedPayments ?? 0,
      receipts: state.receipts.length,
    },
  });
  const received = () => state.receipts.reduce((s, r) => s + r.amountPaise, 0);
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: {
        status?: { in: string[] } | string;
        providerPaymentOrderId?: string | null;
      };
      data: { status?: string; providerPaymentOrderId?: string | null };
    }) => {
      if (
        where.status &&
        !(typeof where.status === "string"
          ? where.status === state.status
          : where.status.in.includes(state.status))
      ) {
        return { count: 0 };
      }
      if (
        where.providerPaymentOrderId !== undefined &&
        where.providerPaymentOrderId !== state.providerPaymentOrderId
      )
        return { count: 0 };
      if (data.status) state.status = data.status;
      if (data.providerPaymentOrderId !== undefined) {
        state.providerPaymentOrderId = data.providerPaymentOrderId;
      }
      return { count: 1 };
    },
  );
  const tx = {
    organizationInvoice: {
      findFirst: jest.fn(async () => row()),
      findUnique: jest.fn(async () => row()),
      findUniqueOrThrow: jest.fn(async () => row()),
      updateMany,
    },
    organizationInvoiceReceipt: {
      count: jest.fn(async () => state.receipts.length),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { organizationId_reference: { reference: string } };
        }) =>
          state.receipts.find(
            (r) => r.reference === where.organizationId_reference.reference,
          ) ?? null,
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: { amountPaise: number; reference: string };
        }) => {
          state.receipts.push(data);
          return { id: `rcpt-${state.receipts.length}` };
        },
      ),
      groupBy: jest.fn(async () =>
        state.receipts.length
          ? [{ invoiceId: "inv-1", _sum: { amountPaise: BigInt(received()) } }]
          : [],
      ),
      aggregate: jest.fn(async () => ({
        _sum: { amountPaise: BigInt(received()) },
      })),
    },
    creditNote: {
      groupBy: jest.fn(async () =>
        init.creditedPaise
          ? [
              {
                invoiceId: "inv-1",
                _sum: { totalPaise: BigInt(init.creditedPaise) },
              },
            ]
          : [],
      ),
      findUniqueOrThrow: jest.fn(async () => ({
        igstPaise: 18_000,
        cgstPaise: 0,
        sgstPaise: 0,
      })),
    },
    ledgerTransaction: {
      findUnique: jest.fn(
        async (_args: {
          where: { idempotencyKey: string };
        }): Promise<{ id: string } | null> => ({ id: "issued" }),
      ),
    },
    payment: { updateMany: jest.fn(async () => ({ count: 2 })) },
    overageEvent: { updateMany: jest.fn(async () => ({ count: 0 })) },
    organizationEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
    consultantEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
    membership: { findMany: jest.fn(async () => []) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
  };
  return { tx: tx as unknown as Tx, raw: tx, state };
}

function configureStoredInvoiceOrder(
  args: {
    holding?: MockHolding;
    orderStatus?: string;
    orderAmountPaise?: number;
    transactionTx?: Tx;
  } = {},
) {
  const row = {
    id: "inv-1",
    status: "ISSUED",
    invoiceNumber: "N",
    displayCurrency: "INR",
    paidAt: null,
    providerPaymentOrderId: "order_existing",
    totalPaise: 100_000,
  };
  mockPay.findFirst.mockResolvedValue(row);
  mockPay.findUniqueOrThrow.mockResolvedValue(row);
  mockFetchOrder.mockResolvedValue({
    id: "order_existing",
    amount: args.orderAmountPaise ?? 100_000,
    currency: "INR",
    status: args.orderStatus ?? "paid",
    notes: {
      type: "invoice_payment",
      invoiceId: "inv-1",
      organizationId: "org-1",
    },
  });
  if (args.holding) mockReadHolding.mockResolvedValue(args.holding);
  if (args.transactionTx) {
    const tx = args.transactionTx;
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: Tx) => unknown) => run(tx),
    );
  }
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ transactionId: "t", created: true });
  mockFetchOrder.mockResolvedValue(null);
  mockReadHolding.mockResolvedValue({ kind: "empty" });
  mockPrisma.creditNote.groupBy.mockResolvedValue([]);
  mockPrisma.organizationInvoiceReceipt.groupBy.mockResolvedValue([]);
});

describe("platform void", () => {
  it("refuses a paid invoice and points at a refund", async () => {
    const { tx } = invoiceWorld({ status: "PAID", totalPaise: 118_000 });
    await expect(
      voidOrgInvoice(tx, {
        organizationId: "org-1",
        invoiceId: "inv-1",
        mode: "FORGIVE",
        reason: "duplicate",
        actorMembershipId: "a",
      }),
    ).rejects.toMatchObject({ code: "INVOICE_PAID_USE_REFUND" });
  });

  it("counts receipts only under the row lock a bank transfer also takes", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
    });
    // A transfer commits between the void's first read and its lock.
    raw.organizationInvoice.updateMany.mockImplementationOnce(async () => {
      state.receipts.push({ amountPaise: 18_000, reference: "UTR9" });
      return { count: 1 };
    });
    await expect(
      voidOrgInvoice(tx, {
        organizationId: "org-1",
        invoiceId: "inv-1",
        mode: "FORGIVE",
        reason: "duplicate",
        actorMembershipId: "a",
      }),
    ).rejects.toMatchObject({ code: "INVOICE_PART_PAID_USE_REFUND" });
    expect(state.status).toBe("ISSUED");
  });

  it("FORGIVE credits the invoice and writes the receivable off against GST and fee", async () => {
    const { tx, state } = invoiceWorld({
      status: "OVERDUE",
      totalPaise: 118_000,
    });
    mockRemaining.mockResolvedValue(118_000);
    mockMint.mockResolvedValue({ creditNoteId: "cn-1" });

    const out = await voidOrgInvoice(tx, {
      organizationId: "org-1",
      invoiceId: "inv-1",
      mode: "FORGIVE",
      reason: "goodwill",
      actorMembershipId: "a",
    });

    expect(state.status).toBe("VOID");
    expect(mockMint.mock.calls[0][1]).toMatchObject({
      amountPaise: 118_000,
      voidedInvoiceId: "inv-1",
    });
    const [journal] = posted();
    expect(journal.idempotencyKey).toBe("invoice-voided:inv-1");
    expect(journal.postings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: expect.objectContaining({ kind: "ORG_RECEIVABLE" }),
          direction: "CREDIT",
          amountPaise: 118_000,
        }),
        expect.objectContaining({
          account: { kind: "GST_PAYABLE" },
          direction: "DEBIT",
          amountPaise: 18_000,
        }),
        expect.objectContaining({
          account: { kind: "PLATFORM_FEE" },
          direction: "DEBIT",
          amountPaise: 100_000,
        }),
      ]),
    );
    expect(out.receivableWrittenOffPaise).toBe(118_000);
  });

  it("REBILL un-stamps the bookings and reverses no revenue", async () => {
    const { tx, raw } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
      billedPayments: 2,
    });
    mockRemaining.mockResolvedValue(118_000);
    mockMint.mockResolvedValue({ creditNoteId: "cn-1" });

    const out = await voidOrgInvoice(tx, {
      organizationId: "org-1",
      invoiceId: "inv-1",
      mode: "REBILL",
      reason: "wrong cycle",
      actorMembershipId: "a",
    });

    expect(raw.payment.updateMany).toHaveBeenCalledWith({
      where: { billableToOrgInvoiceId: "inv-1" },
      data: { billableToOrgInvoiceId: null },
    });
    expect(out.rebilledPaymentCount).toBe(2);
    expect(posted()).toHaveLength(0);
  });
});

describe("bank transfer receipts", () => {
  it("recovers a missing capture webhook after full bank settlement as a separate unapplied liability", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
      providerPaymentOrderId: "order_bank_race",
    });
    raw.ledgerTransaction.findUnique.mockResolvedValue(null);
    await recordBankTransferReceipt(tx, {
      organizationId: "org-1",
      invoiceId: "inv-1",
      utr: "UTR_FULL",
      amountPaise: 118_000,
      receivedOn: new Date("2026-10-27"),
      recordedById: "admin-1",
      actorMembershipId: "a",
    });
    expect(state.status).toBe("PAID");
    expect(state.providerPaymentOrderId).toBe("order_bank_race");
    expect(mockReadHolding).not.toHaveBeenCalled();
    mockPay.findMany.mockResolvedValue([
      await raw.organizationInvoice.findFirst(),
    ]);
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: Tx) => unknown) => run(tx),
    );
    mockReadHolding.mockResolvedValue({
      kind: "captured",
      paymentId: "pay_lost",
      amountPaise: 118_000,
    });

    const recovered = await reconcileOrgInvoicePayments({ limit: 1 });

    expect(recovered).toMatchObject({
      success: true,
      captured: 1,
      unapplied: 1,
      paid: 0,
    });
    expect(state.status).toBe("PAID");
    expect(state.providerPaymentOrderId).toBeNull();
    expect(state.receipts).toHaveLength(1);
    expect(posted().map((p) => p.idempotencyKey)).toEqual([
      "invoicereceipt:rcpt-1",
      "unapplied:pay_lost",
    ]);
    expect(mockSystemEvent).toHaveBeenCalledTimes(1);
    expect(raw.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "INVOICE_PAYMENT_ORDER_RETIRED",
          details: {
            invoiceId: "inv-1",
            razorpayOrderId: "order_bank_race",
            reason: "CAPTURE_ACCOUNTED",
          },
        }),
      }),
    );
  });

  it("a part-payment leaves the invoice ISSUED; the receipt that clears it settles PAID", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
      providerPaymentOrderId: "order_before_bank",
    });
    const base = {
      organizationId: "org-1",
      invoiceId: "inv-1",
      receivedOn: new Date("2026-10-19"),
      recordedById: "admin-1",
      actorMembershipId: "a",
    };

    const first = await recordBankTransferReceipt(tx, {
      ...base,
      utr: "UTR0001",
      amountPaise: 18_000,
    });
    expect(first.settled).toBeNull();
    expect(first.outstandingAfterPaise).toBe(100_000);
    expect(state.status).toBe("ISSUED");
    expect(state.providerPaymentOrderId).toBe("order_before_bank");

    await expect(
      recordBankTransferReceipt(tx, {
        ...base,
        utr: "UTR0002",
        amountPaise: 100_001,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_EXCEEDS_OUTSTANDING" });

    const last = await recordBankTransferReceipt(tx, {
      ...base,
      utr: "UTR0003",
      amountPaise: 100_000,
    });
    expect(last.settled).not.toBeNull();
    expect(state.status).toBe("PAID");
    expect(state.providerPaymentOrderId).toBe("order_before_bank");
    expect(posted().map((p) => p.idempotencyKey)).toEqual([
      "invoicereceipt:rcpt-1",
      "invoicereceipt:rcpt-2",
    ]);
    // The gateway path's downstream: PENDING_TRUST released.
    expect(raw.consultantEarnings.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("gateway capture", () => {
  it("keeps an already parked capture out of automatic settlement even when its amount now matches", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
      providerPaymentOrderId: "order_current",
    });
    raw.ledgerTransaction.findUnique.mockImplementation(async ({ where }) =>
      where.idempotencyKey === "unapplied:pay_parked" ? { id: "parked" } : null,
    );

    const outcome = await applyOrgInvoiceCapture(tx, {
      invoiceId: "inv-1",
      gatewayPaymentId: "pay_parked",
      capturedPaise: 118_000,
      notesOrganizationId: "org-1",
    });

    expect(outcome).toEqual({ kind: "UNAPPLIED", reason: "ALREADY_UNAPPLIED" });
    expect(state.status).toBe("ISSUED");
    expect(state.providerPaymentOrderId).toBe("order_current");
    expect(raw.organizationInvoice.updateMany).not.toHaveBeenCalled();
    expect(raw.organizationInvoiceReceipt.create).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSystemEvent).not.toHaveBeenCalled();
  });

  it("preserves a newer checkout when a late capture is parked, then clears it only on settlement", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
      creditedPaise: 18_000,
      providerPaymentOrderId: "order_current_net",
    });

    expect(
      await applyOrgInvoiceCapture(tx, {
        invoiceId: "inv-1",
        gatewayPaymentId: "pay_old_gross",
        capturedPaise: 118_000,
        notesOrganizationId: "org-1",
      }),
    ).toEqual({ kind: "UNAPPLIED", reason: "AMOUNT_MISMATCH" });
    expect(state.providerPaymentOrderId).toBe("order_current_net");
    expect(state.status).toBe("ISSUED");
    expect(raw.organizationInvoiceReceipt.create).not.toHaveBeenCalled();
    expect(posted()[0]).toMatchObject({
      idempotencyKey: "unapplied:pay_old_gross",
    });

    expect(
      (
        await applyOrgInvoiceCapture(tx, {
          invoiceId: "inv-1",
          gatewayPaymentId: "pay_current_net",
          capturedPaise: 100_000,
          notesOrganizationId: "org-1",
        })
      ).kind,
    ).toBe("PAID");
    expect(state.providerPaymentOrderId).toBeNull();
    expect(state.status).toBe("PAID");
    expect(state.receipts).toEqual([
      expect.objectContaining({
        reference: "pay_current_net",
        amountPaise: 100_000,
      }),
    ]);
  });

  it("settles only the outstanding amount and parks anything else once", async () => {
    const { tx, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
      creditedPaise: 18_000,
    });
    const capture = (gatewayPaymentId: string, capturedPaise: number) =>
      applyOrgInvoiceCapture(tx, {
        invoiceId: "inv-1",
        gatewayPaymentId,
        capturedPaise,
        notesOrganizationId: "org-1",
      });

    // The gross total no longer settles a credited invoice.
    expect(await capture("pay_gross", 118_000)).toEqual({
      kind: "UNAPPLIED",
      reason: "AMOUNT_MISMATCH",
    });
    expect(mockSystemEvent).toHaveBeenCalledTimes(1);
    expect(posted()[0]).toMatchObject({
      idempotencyKey: "unapplied:pay_gross",
    });

    expect((await capture("pay_net", 100_000)).kind).toBe("PAID");
    expect(state.status).toBe("PAID");

    mockPost.mockResolvedValue({ transactionId: "t", created: false });
    expect(await capture("pay_gross", 118_000)).toEqual({
      kind: "UNAPPLIED",
      reason: "INVOICE_NOT_PAYABLE",
    });
    expect(mockSystemEvent).toHaveBeenCalledTimes(1);
    expect(await capture("pay_net", 100_000)).toEqual({
      kind: "ALREADY_APPLIED",
    });
  });
});

describe("gateway capture redelivered concurrently", () => {
  it("re-checks the receipt after losing the lock, so a settled capture is never parked", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
    });
    // The other delivery settles the invoice while this one waits on the lock.
    raw.organizationInvoice.updateMany.mockImplementationOnce(async () => {
      state.receipts.push({ amountPaise: 118_000, reference: "pay_dup" });
      state.status = "PAID";
      return { count: 0 };
    });

    const out = await applyOrgInvoiceCapture(tx, {
      invoiceId: "inv-1",
      gatewayPaymentId: "pay_dup",
      capturedPaise: 118_000,
      notesOrganizationId: "org-1",
    });

    expect(out).toEqual({ kind: "ALREADY_APPLIED" });
    expect(posted()).toHaveLength(0);
    expect(mockSystemEvent).not.toHaveBeenCalled();
  });
});

describe("/pay", () => {
  it("does not attach an old-amount order when a credit commits during gateway creation", async () => {
    const row = {
      id: "inv-1",
      status: "ISSUED",
      invoiceNumber: "N",
      displayCurrency: "INR",
      paidAt: null,
      providerPaymentOrderId: null,
      totalPaise: 118_000,
    };
    mockPay.findFirst.mockResolvedValue(row);
    mockPay.findUniqueOrThrow.mockResolvedValue(row);
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const transactionTx = {
      organizationInvoice: {
        updateMany,
        findUniqueOrThrow: mockPay.findUniqueOrThrow,
      },
      orgAuditLog: { create: jest.fn(async () => ({})) },
      creditNote: mockPrisma.creditNote,
      organizationInvoiceReceipt: mockPrisma.organizationInvoiceReceipt,
    };
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: typeof transactionTx) => unknown) => run(transactionTx),
    );
    mockCreateOrder.mockImplementationOnce(async () => {
      mockPrisma.creditNote.groupBy.mockResolvedValue([
        { invoiceId: "inv-1", _sum: { totalPaise: BigInt(18_000) } },
      ]);
      return { id: "order_old_amount" };
    });

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("INVOICE_STATE_CHANGED");
    expect(mockCreateOrder.mock.calls[0][0].amount).toBe(118_000);
    expect(updateMany).not.toHaveBeenCalled();
    expect(transactionTx.orgAuditLog.create).not.toHaveBeenCalled();
    expect(row.providerPaymentOrderId).toBeNull();
  });

  it("lets a verifying org pay the outstanding amount, not the gross", async () => {
    const row = {
      id: "inv-1",
      status: "ISSUED",
      invoiceNumber: "N",
      displayCurrency: "INR",
      paidAt: null,
      providerPaymentOrderId: null,
      totalPaise: 118_000,
    };
    mockPay.findFirst.mockResolvedValue(row);
    mockPay.findUniqueOrThrow.mockResolvedValue(row);
    mockPrisma.creditNote.groupBy.mockResolvedValue([
      { invoiceId: "inv-1", _sum: { totalPaise: BigInt(18_000) } },
    ] as never);
    const transactionTx = {
      organizationInvoice: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => ({
          status: "ISSUED",
          providerPaymentOrderId: "order_new",
        })),
        findUniqueOrThrow: mockPay.findUniqueOrThrow,
      },
      orgAuditLog: { create: jest.fn(async () => ({})) },
      creditNote: mockPrisma.creditNote,
      organizationInvoiceReceipt: mockPrisma.organizationInvoiceReceipt,
    };
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: typeof transactionTx) => unknown) => run(transactionTx),
    );

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      {
        params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockCreateOrder.mock.calls[0][0].amount).toBe(100_000);
    expect(mockCreateOrder.mock.calls[0][1]).toBeLessThanOrEqual(5_000);
    expect(mockCreateOrder.mock.calls[0][1]).toBeGreaterThan(0);
    expect((await res.json()).amountPaise).toBe(100_000);
  });

  it("replaces a stale-amount order only after an empty gateway read and old-order CAS", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 100_000,
      providerPaymentOrderId: "order_old",
    });
    mockPay.findFirst.mockImplementation(() =>
      raw.organizationInvoice.findFirst(),
    );
    mockPay.findUniqueOrThrow.mockImplementation(() =>
      raw.organizationInvoice.findUniqueOrThrow(),
    );
    mockPay.findUnique.mockImplementation(() =>
      raw.organizationInvoice.findUnique(),
    );
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: Tx) => unknown) => run(tx),
    );
    mockFetchOrder.mockResolvedValue({
      id: "order_old",
      amount: 118_000,
      currency: "INR",
      status: "created",
      notes: {
        type: "invoice_payment",
        invoiceId: "inv-1",
        organizationId: "org-1",
      },
    });
    mockReadHolding.mockResolvedValue({ kind: "empty" });

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(200);
    expect(state.providerPaymentOrderId).toBe("order_new");
    expect(mockReadHolding).toHaveBeenCalledWith(
      "order_old",
      expect.any(Number),
    );
    expect(mockReadHolding.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateOrder.mock.invocationCallOrder[0],
    );
    expect(raw.organizationInvoice.updateMany).toHaveBeenCalledWith({
      where: {
        id: "inv-1",
        organizationId: "org-1",
        status: { in: ["ISSUED", "OVERDUE"] },
        providerPaymentOrderId: "order_old",
      },
      data: { providerPaymentOrderId: "order_new" },
    });
    expect(raw.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          details: expect.objectContaining({
            replacedRazorpayOrderId: "order_old",
          }),
        }),
      }),
    );
  });

  it("refuses a concurrent stale-amount winner that still requires replacement", async () => {
    const initial = {
      id: "inv-1",
      status: "ISSUED",
      invoiceNumber: "N",
      displayCurrency: "INR",
      paidAt: null,
      providerPaymentOrderId: null,
      totalPaise: 100_000,
    };
    const winner = { ...initial, providerPaymentOrderId: "order_winner_old" };
    mockPay.findFirst.mockResolvedValue(initial);
    mockPay.findUniqueOrThrow.mockResolvedValue(winner);
    mockPay.findUnique.mockResolvedValue(winner);
    const transactionTx = {
      organizationInvoice: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findUnique: jest.fn(async () => winner),
        findUniqueOrThrow: mockPay.findUniqueOrThrow,
      },
      creditNote: mockPrisma.creditNote,
      organizationInvoiceReceipt: mockPrisma.organizationInvoiceReceipt,
    };
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: typeof transactionTx) => unknown) => run(transactionTx),
    );
    mockFetchOrder.mockResolvedValue({
      id: "order_winner_old",
      amount: 50_000,
      currency: "INR",
      status: "created",
      notes: {
        type: "invoice_payment",
        invoiceId: "inv-1",
        organizationId: "org-1",
      },
    });
    mockReadHolding.mockResolvedValue({ kind: "empty" });

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.code).toBe("INVOICE_STATE_CHANGED");
    expect(payload).not.toHaveProperty("razorpayOrderId");
    expect(mockReadHolding).toHaveBeenCalledWith(
      "order_winner_old",
      expect.any(Number),
    );
  });

  it("stops gateway reads when the route's provider budget is exhausted", async () => {
    jest.useFakeTimers();
    const row = {
      id: "inv-1",
      status: "ISSUED",
      invoiceNumber: "N",
      displayCurrency: "INR",
      paidAt: null,
      providerPaymentOrderId: "order_old",
      totalPaise: 100_000,
    };
    mockPay.findFirst.mockResolvedValue(row);
    mockPay.findUniqueOrThrow.mockResolvedValue(row);
    mockFetchOrder.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(20_001);
      return {
        id: "order_old",
        amount: 50_000,
        currency: "INR",
        status: "created",
        notes: {
          type: "invoice_payment",
          invoiceId: "inv-1",
          organizationId: "org-1",
        },
      };
    });

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "ORDER_UNCONFIRMED" });
    expect(mockReadHolding).not.toHaveBeenCalled();
    expect(mockCreateOrder).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("settles a captured stored order instead of minting a second checkout", async () => {
    const { tx, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 100_000,
    });
    configureStoredInvoiceOrder({
      holding: {
        kind: "captured",
        paymentId: "pay_existing",
        amountPaise: 100_000,
      },
      transactionTx: tx,
    });

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVOICE_ALREADY_PAID" });
    expect(mockCreateOrder).not.toHaveBeenCalled();
    expect(state.status).toBe("PAID");
    expect(tx.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "INVOICE_PAID" }),
      }),
    );
    expect(mockPrisma.orgAuditLog.create).not.toHaveBeenCalled();
    expect(state.receipts).toMatchObject([
      { amountPaise: 100_000, reference: "pay_existing" },
    ]);
    expect(posted().map((p) => p.idempotencyKey)).toContain(
      "invoicepaid:inv-1",
    );
  });

  it.each([
    ["empty", { kind: "empty" }],
    ["live", { kind: "live" }],
  ] as const)(
    "does not replace a gateway-paid order with an inconclusive %s payment read",
    async (_name, holding) => {
      configureStoredInvoiceOrder({
        holding,
      });

      const res = await payInvoice(
        new NextRequest("https://x.test/api", { method: "POST" }),
        { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code:
          holding.kind === "live"
            ? "PAYMENT_IN_PROGRESS"
            : "PAYMENT_CAPTURE_UNCONFIRMED",
      });
      expect(mockCreateOrder).not.toHaveBeenCalled();
    },
  );

  it("rolls back capture recovery when its business audit cannot be committed", async () => {
    const { tx, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 100_000,
    });
    configureStoredInvoiceOrder({
      holding: {
        kind: "captured",
        paymentId: "pay_existing",
        amountPaise: 100_000,
      },
    });
    jest
      .mocked(tx.orgAuditLog.create)
      .mockRejectedValueOnce(new Error("audit unavailable"));
    mockPrisma.$transaction.mockImplementation(
      async (run: (tx: Tx) => unknown) => {
        const beforeStatus = state.status;
        const beforeReceipts = [...state.receipts];
        try {
          return await run(tx);
        } catch (error) {
          state.status = beforeStatus;
          state.receipts.splice(0, state.receipts.length, ...beforeReceipts);
          throw error;
        }
      },
    );

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "PAYMENT_RECOVERY_UNCONFIRMED",
    });
    expect(mockCreateOrder).not.toHaveBeenCalled();
    expect(state.status).toBe("ISSUED");
    expect(state.receipts).toHaveLength(0);
  });

  it("does not mint a second order when a stored order has a captured mismatch", async () => {
    const { tx } = invoiceWorld({ status: "ISSUED", totalPaise: 100_000 });
    configureStoredInvoiceOrder({
      holding: {
        kind: "captured",
        paymentId: "pay_mismatch",
        amountPaise: 50_000,
      },
      transactionTx: tx,
    });

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "PAYMENT_CAPTURE_REQUIRES_REVIEW",
    });
    expect(mockCreateOrder).not.toHaveBeenCalled();
    expect(mockSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the stored order cannot be read", async () => {
    const row = {
      id: "inv-1",
      status: "ISSUED",
      invoiceNumber: "N",
      displayCurrency: "INR",
      paidAt: null,
      providerPaymentOrderId: "order_existing",
      totalPaise: 100_000,
    };
    mockPay.findFirst.mockResolvedValue(row);
    mockPay.findUniqueOrThrow.mockResolvedValue(row);
    mockFetchOrder.mockRejectedValue(new Error("gateway unavailable"));

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "ORDER_UNCONFIRMED" });
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("does not return a newly minted order if another payment settled the invoice first", async () => {
    const row = {
      id: "inv-1",
      status: "ISSUED",
      invoiceNumber: "N",
      displayCurrency: "INR",
      paidAt: null,
      providerPaymentOrderId: null,
      totalPaise: 100_000,
    };
    mockPay.findFirst.mockResolvedValue(row);
    mockPay.findUniqueOrThrow.mockResolvedValue(row);
    mockPrisma.$transaction.mockImplementationOnce(
      async (run: (tx: unknown) => unknown) =>
        run({
          organizationInvoice: {
            updateMany: jest.fn(async () => ({ count: 0 })),
            findUniqueOrThrow: mockPay.findUniqueOrThrow,
            findUnique: jest.fn(async () => ({
              status: "PAID",
              providerPaymentOrderId: null,
            })),
          },
          orgAuditLog: { create: jest.fn() },
          creditNote: mockPrisma.creditNote,
          organizationInvoiceReceipt: mockPrisma.organizationInvoiceReceipt,
        }),
    );

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      { params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "INVOICE_STATE_CHANGED" });
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveProperty("razorpayOrderId");
  });
});

describe("purchase-order restore", () => {
  it("returns a commercial note's subtotal grossed up at the invoice rate", async () => {
    const updateMany = jest.fn(async (_a: unknown) => ({ count: 1 }));
    const findUnique = jest.fn(async () => ({
      totalAmountPaise: 500_000,
      remainingAmountPaise: 382_000,
    }));
    const restored = await restorePurchaseOrderForCredit(
      { purchaseOrder: { findUnique, updateMany } } as unknown as Tx,
      {
        invoice: {
          purchaseOrderId: "po-1",
          totalPaise: 118_000,
          subtotalPaise: 100_000,
        },
        credit: {
          totalPaise: 50_000,
          subtotalPaise: 50_000,
          isCommercial: true,
        },
      },
    );
    expect(restored).toBe(59_000);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "po-1", remainingAmountPaise: 382_000 },
      data: { remainingAmountPaise: { increment: 59_000 } },
    });
  });
});

describe("failed member overage settled to the org", () => {
  it("accrues base + surcharge to the next rollup and releases a LICENSE parent's hold", async () => {
    const created: Record<string, unknown>[] = [];
    const tx = {
      overageEvent: {
        findUnique: jest.fn(async () => ({
          id: "ev-1",
          overageBehavior: "CHARGE_MEMBER",
          chargeStatus: "FAILED",
          basePaise: 100_000,
          surchargePaise: 0,
          currency: "INR",
          batchKey: "b1",
          paymentId: "side-1",
          programAssignmentId: "asg-1",
          bookingUtilizationId: "bu-1",
          programAssignment: {
            program: { contract: { organizationId: "org-1" } },
          },
          bookingUtilization: {
            payment: {
              id: "parent-1",
              userId: "u-1",
              paymentGateway: "RAZORPAY",
              billableToOrgInvoiceId: null,
              legs: [{ source: "LICENSE" }],
            },
          },
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "ev-org" };
        }),
      },
      payment: { create: jest.fn(async () => ({ id: "child-1" })) },
    } as unknown as Tx;

    const out = await settleFailedMemberOverageAsOrg(tx, {
      organizationId: "org-1",
      overageEventId: "ev-1",
    });

    expect(out).toEqual({ childPaymentId: "child-1", accruedPaise: 100_000 });
    expect(created[0]).toMatchObject({
      overageBehavior: "CHARGE_ORG",
      chargeStatus: "PENDING",
      paymentId: "child-1",
    });
    expect(mockRelease).toHaveBeenCalledWith(tx, "parent-1");
    await expect(
      settleFailedMemberOverageAsOrg(tx, {
        organizationId: "org-2",
        overageEventId: "ev-1",
      }),
    ).rejects.toBeInstanceOf(OpsRefusal);
  });
});
