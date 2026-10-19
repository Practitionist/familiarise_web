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
  findUniqueOrThrow: jest.fn(),
  updateMany: jest.fn(),
};
const mockPrisma = {
  organizationInvoice: mockPay,
  creditNote: { groupBy: jest.fn(async () => []) },
  organizationInvoiceReceipt: { groupBy: jest.fn(async () => []) },
  $transaction: jest.fn(),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
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
const mockCreateOrder = jest.fn(async (_p: { amount: number }) => ({
  id: "order_new",
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  createRazorpayOrder: (p: { amount: number }) => mockCreateOrder(p),
  fetchRazorpayOrder: jest.fn(async () => null),
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
}) {
  const state = {
    status: init.status,
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
      where: { status?: { in: string[] } };
      data: { status?: string };
    }) => {
      if (where.status && !where.status.in.includes(state.status)) {
        return { count: 0 };
      }
      if (data.status) state.status = data.status;
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
    ledgerTransaction: { findUnique: jest.fn(async () => ({ id: "issued" })) },
    payment: { updateMany: jest.fn(async () => ({ count: 2 })) },
    overageEvent: { updateMany: jest.fn(async () => ({ count: 0 })) },
    organizationEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
    consultantEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
    membership: { findMany: jest.fn(async () => []) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
  };
  return { tx: tx as unknown as Tx, raw: tx, state };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ transactionId: "t", created: true });
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
  it("a part-payment leaves the invoice ISSUED; the receipt that clears it settles PAID", async () => {
    const { tx, raw, state } = invoiceWorld({
      status: "ISSUED",
      totalPaise: 118_000,
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
    expect(posted().map((p) => p.idempotencyKey)).toEqual([
      "invoicereceipt:rcpt-1",
      "invoicereceipt:rcpt-2",
    ]);
    // The gateway path's downstream: PENDING_TRUST released.
    expect(raw.consultantEarnings.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("gateway capture", () => {
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

describe("/pay", () => {
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
    mockPrisma.creditNote.groupBy.mockResolvedValueOnce([
      { invoiceId: "inv-1", _sum: { totalPaise: BigInt(18_000) } },
    ] as never);
    mockPrisma.$transaction.mockResolvedValue(undefined);

    const res = await payInvoice(
      new NextRequest("https://x.test/api", { method: "POST" }),
      {
        params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockCreateOrder.mock.calls[0][0].amount).toBe(100_000);
    expect((await res.json()).amountPaise).toBe(100_000);
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
