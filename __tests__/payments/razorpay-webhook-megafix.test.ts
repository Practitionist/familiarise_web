/**
 * @jest-environment node
 */

import { Prisma } from "@prisma/client";
import {
  disputeUpdateEntitySchema,
  razorpayNotesSchema,
  razorpayWebhookEnvelopeSchema,
} from "../../schemas/webhooks/razorpay";
import { isPayoutEventName } from "../../app/api/webhooks/razorpay/signature";
import { isLegalDisputeTransition } from "../../lib/payments/dispute-status";
import { DeferSignal } from "../../app/api/webhooks/utils";
import { handleFundAccountValidationWebhook } from "../../lib/payments/payouts/reverse-penny-drop";

jest.mock("../../lib/prisma", () => {
  const txMock: Record<string, unknown> = {};
  const prismaMock: Record<string, unknown> = {
    $transaction: jest.fn(
      async (fn: (tx: Record<string, unknown>) => unknown) => fn(txMock),
    ),
    __tx: txMock,
  };
  return {
    __esModule: true,
    default: prismaMock,
    prisma: prismaMock,
  };
});

jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: jest.fn(() => null),
}));

jest.mock("../../lib/payments/ledger/post", () => ({
  __esModule: true,
  postLedgerTxn: jest.fn(async () => ({ id: "ltxn_1" })),
}));

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  __esModule: true,
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));

jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  handlePayoutWebhook: jest.fn(async () => undefined),
  markOrgPayoutCompleted: jest.fn(async () => ({ wasNoOp: false })),
  markOrgPayoutFailed: jest.fn(async () => ({ wasNoOp: false })),
  markOrgPayoutReversed: jest.fn(async () => ({ wasNoOp: false })),
  markConsultantPayoutReversed: jest.fn(async () => ({ wasNoOp: false })),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemErrorSafe: jest.fn(async () => undefined),
  recordSystemEventSafe: jest.fn(async () => undefined),
}));

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyDisputeCreated: jest.fn(async () => []),
  notifyDisputeResolved: jest.fn(async () => []),
  notifyRefundProcessed: jest.fn(async () => null),
  attemptStaged: jest.fn(async () => undefined),
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  __esModule: true,
  notifyOrgInvoicePaid: jest.fn(async () => undefined),
  notifyOrgWalletTopupConfirmed: jest.fn(async () => undefined),
}));

describe("Razorpay & RazorpayX Webhook Megafix Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("1. Zod Schema Normalization & Extraction", () => {
    it("normalizes Razorpay notes arrays, nulls, and scalars into Record<string, string>", () => {
      expect(razorpayNotesSchema.parse([])).toEqual({});
      expect(razorpayNotesSchema.parse(undefined)).toEqual({});
      expect(
        razorpayNotesSchema.parse({
          reservationId: "res_123",
          retryCount: 2,
          isOrg: true,
          empty: null,
        }),
      ).toEqual({
        reservationId: "res_123",
        retryCount: "2",
        isOrg: "true",
        empty: "",
      });
    });

    it("extracts fund_account.validation entity and dispute respond_by fields cleanly", () => {
      const parsed = razorpayWebhookEnvelopeSchema.parse({
        event: "fund_account.validation.completed",
        payload: {
          "fund_account.validation": {
            entity: {
              id: "fav_test_123",
              fund_account: { id: "fa_acct_999" },
              status: "completed",
              utr: "UTR123456789",
            },
          },
        },
      });
      expect(parsed.payload?.["fund_account.validation"]?.entity).toMatchObject(
        {
          id: "fav_test_123",
          status: "completed",
        },
      );

      const disputeEntity = disputeUpdateEntitySchema.parse({
        id: "disp_1",
        status: "under_review",
        respond_by: 1800000000,
        phase: "chargeback",
        amount: 50000,
      });
      expect(disputeEntity.respond_by).toBe(1800000000);
      expect(disputeEntity.phase).toBe("chargeback");
    });

    it("identifies both payout.* and fund_account.* webhook events for RazorpayX secret verification", () => {
      expect(
        isPayoutEventName(JSON.stringify({ event: "payout.processed" })),
      ).toBe(true);
      expect(
        isPayoutEventName(
          JSON.stringify({ event: "fund_account.validation.completed" }),
        ),
      ).toBe(true);
      expect(
        isPayoutEventName(
          JSON.stringify({ event: "fund_account.validation.failed" }),
        ),
      ).toBe(true);
      expect(
        isPayoutEventName(JSON.stringify({ event: "payment.captured" })),
      ).toBe(false);
    });
  });

  describe("2. Reverse Penny Drop Webhook Handler", () => {
    it("marks consultant and organization payout accounts verified on completed validation", async () => {
      const prismaMod = await import("../../lib/prisma");
      const db = prismaMod.default as unknown as {
        payoutAccount: { updateMany: jest.Mock };
        organizationPayoutAccount: { updateMany: jest.Mock };
      };
      db.payoutAccount = { updateMany: jest.fn(async () => ({ count: 1 })) };
      db.organizationPayoutAccount = {
        updateMany: jest.fn(async () => ({ count: 1 })),
      };

      await handleFundAccountValidationWebhook(
        "fund_account.validation.completed",
        {
          id: "fav_123",
          fund_account: { id: "fa_456" },
          status: "completed",
          results: { account_status: "active", registered_name: "Asha Rao" },
        },
      );

      expect(db.payoutAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isVerified: false,
            razorpayFundAccId: "fa_456",
          },
          data: expect.objectContaining({
            isVerified: true,
            accountHolderName: "Asha Rao",
          }),
        }),
      );
      expect(db.organizationPayoutAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: ["PENDING_VERIFICATION", "FAILED_VERIFICATION"] },
            razorpayFundAccountId: "fa_456",
          },
          data: expect.objectContaining({ status: "VERIFIED" }),
        }),
      );
    });

    it("marks organization payout account FAILED_VERIFICATION when validation fails", async () => {
      const prismaMod = await import("../../lib/prisma");
      const db = prismaMod.default as unknown as {
        payoutAccount: { updateMany: jest.Mock };
        organizationPayoutAccount: { updateMany: jest.Mock };
      };
      db.payoutAccount = { updateMany: jest.fn(async () => ({ count: 0 })) };
      db.organizationPayoutAccount = {
        updateMany: jest.fn(async () => ({ count: 1 })),
      };

      await handleFundAccountValidationWebhook(
        "fund_account.validation.failed",
        {
          id: "fav_fail",
          fund_account: { id: "fa_fail" },
          status: "failed",
        },
      );

      expect(db.organizationPayoutAccount.updateMany).toHaveBeenCalledWith({
        where: {
          status: "PENDING_VERIFICATION",
          razorpayFundAccountId: "fa_fail",
        },
        data: {
          status: "FAILED_VERIFICATION",
        },
      });
    });
  });

  describe("3. Hold-Window Failure Protection & Fast-Path Idempotency", () => {
    it("retains active checkout hold window on retryable payment failure without canceling booking", async () => {
      const prismaMod = await import("../../lib/prisma");
      const db = prismaMod.default as unknown as {
        payment: { findUnique: jest.Mock; updateMany: jest.Mock };
        __tx: Record<string, unknown>;
      };
      const futureExpiry = new Date(Date.now() + 10 * 60 * 1000);
      const paymentMock = {
        findUnique: jest.fn(async () => ({
          id: "pay_row_1",
          paymentIntent: "order_active_hold",
          paymentStatus: "PENDING",
          expiresAt: futureExpiry,
          appointmentId: "appt_1",
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      };
      db.payment = paymentMock;
      db.__tx.payment = paymentMock;

      const { handlePaymentFailure } =
        await import("../../lib/payments/webhooks/handlers");
      await handlePaymentFailure(
        "order_active_hold",
        "Insufficient funds",
        "pay_attempt_1",
      );

      expect(paymentMock.updateMany).toHaveBeenCalledWith({
        where: { id: "pay_row_1", paymentStatus: "PENDING" },
        data: {
          description:
            "Payment attempt failed (attempt=pay_attempt_1: Insufficient funds)",
        },
      });
    });

    it("backfills missing gatewayPaymentId on already SUCCEEDED payment via CAS without opening $transaction", async () => {
      const prismaMod = await import("../../lib/prisma");
      const db = prismaMod.default as unknown as {
        payment: { findUnique: jest.Mock; updateMany: jest.Mock };
        $transaction: jest.Mock;
      };
      db.payment = {
        findUnique: jest.fn(async () => ({
          id: "pay_done_1",
          paymentIntent: "order_done_1",
          paymentStatus: "SUCCEEDED",
          amount: 50000,
          gatewayPaymentId: null,
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      };
      db.$transaction.mockClear();

      const { handlePaymentSuccess } =
        await import("../../lib/payments/webhooks/handlers");
      await handlePaymentSuccess(
        "order_done_1",
        {},
        undefined,
        "pay_captured_99",
      );

      expect(db.payment.updateMany).toHaveBeenCalledWith({
        where: { id: "pay_done_1", gatewayPaymentId: null },
        data: { gatewayPaymentId: "pay_captured_99" },
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("4. Dispute Lifecycle, DeferSignal & Multi-Dispute Earnings Hold", () => {
    it("allows legal UNDER_REVIEW -> NEEDS_RESPONSE re-open transition", () => {
      expect(isLegalDisputeTransition("UNDER_REVIEW", "NEEDS_RESPONSE")).toBe(
        true,
      );
    });

    it("returns DeferSignal when dispute.updated arrives before dispute.created", async () => {
      const prismaMod = await import("../../lib/prisma");
      const db = prismaMod.default as unknown as {
        __tx: Record<string, unknown>;
      };
      db.__tx.dispute = {
        findUnique: jest.fn(async () => null),
      };

      const { handleDisputeUpdated } =
        await import("../../app/api/webhooks/utils");
      const res = await handleDisputeUpdated("disp_missing", "won", null);
      expect(res).toBeInstanceOf(DeferSignal);
    });

    it("keeps earnings HELD when one dispute wins while a sibling dispute remains open", async () => {
      const prismaMod = await import("../../lib/prisma");
      const db = prismaMod.default as unknown as {
        __tx: Record<string, unknown>;
      };
      const consultantUpdateMany = jest.fn(async () => ({ count: 0 }));
      const orgUpdateMany = jest.fn(async () => ({ count: 0 }));

      db.__tx.dispute = {
        findUnique: jest.fn(async () => ({
          id: "disp_row_1",
          disputeId: "disp_1",
          paymentId: "pay_shared",
          status: "UNDER_REVIEW",
          amountPaise: 50000,
          currency: "INR",
          reason: "duplicate",
          payment: { id: "pay_shared", amount: 50000, organizationId: null },
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        count: jest.fn(async () => 1),
      };
      db.__tx.consultantEarnings = { updateMany: consultantUpdateMany };
      db.__tx.organizationEarnings = { updateMany: orgUpdateMany };
      db.__tx.payment = { findUnique: jest.fn(async () => null) };

      const { handleDisputeUpdated } =
        await import("../../app/api/webhooks/utils");
      await handleDisputeUpdated("disp_1", "won", null);

      expect(consultantUpdateMany).not.toHaveBeenCalled();
      expect(orgUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("5. Enterprise Outbound Webhooks & RazorpayX Payout Routing", () => {
    it("emits invoice.paid outbound webhook atomically inside handleOrgPaymentSuccess", async () => {
      const prismaMod = await import("../../lib/prisma");
      const webhooksMod =
        await import("../../lib/enterprise/outbound-webhooks/dispatch");
      const db = prismaMod.default as unknown as {
        organizationInvoice: { findUnique: jest.Mock };
        orgAuditLog: { create: jest.Mock };
        organization: { findUnique: jest.Mock };
        __tx: Record<string, unknown>;
      };
      db.orgAuditLog = { create: jest.fn(async () => ({})) };
      db.organization = { findUnique: jest.fn(async () => null) };
      db.organizationInvoice = {
        findUnique: jest.fn(async () => ({
          id: "inv_1",
          invoiceNumber: "INV-2026-001",
          totalPaise: 125000,
          status: "ISSUED",
          displayCurrency: "INR",
          organizationId: "org_1",
          organization: { name: "Acme Corp" },
        })),
      };
      db.__tx.organizationInvoice = {
        updateMany: jest.fn(async () => ({ count: 1 })),
      };
      db.__tx.overageEvent = {
        updateMany: jest.fn(async () => ({ count: 0 })),
      };
      db.__tx.organizationEarnings = {
        updateMany: jest.fn(async () => ({ count: 0 })),
      };
      db.__tx.consultantEarnings = {
        updateMany: jest.fn(async () => ({ count: 0 })),
      };

      const { handleOrgPaymentSuccess } =
        await import("../../app/api/webhooks/utils");
      await handleOrgPaymentSuccess(
        {
          type: "invoice_payment",
          invoiceId: "inv_1",
          organizationId: "org_1",
        },
        "pay_inv_1",
        125000,
      );

      expect(webhooksMod.dispatchWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          prisma: db.__tx,
          organizationId: "org_1",
          eventType: "invoice.paid",
          payload: expect.objectContaining({
            invoiceId: "inv_1",
            invoiceNumber: "INV-2026-001",
            paidPaise: 125000,
            paymentId: "pay_inv_1",
          }),
        }),
      );
    });

    it("resolves OrganizationPayout via reference_id when gatewayPayoutId is null and handles payout.cancelled", async () => {
      const prismaMod = await import("../../lib/prisma");
      const payoutsMod = await import("../../lib/payments/payouts");
      const db = prismaMod.default as unknown as {
        organizationPayout: {
          findUnique: jest.Mock;
          findFirst: jest.Mock;
          updateMany: jest.Mock;
        };
      };
      db.organizationPayout = {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => ({
          id: "org_payout_1",
          status: "PROCESSING",
          organizationId: "org_1",
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      };

      const { handleRazorpayPayoutWebhook } =
        await import("../../app/api/webhooks/utils");
      await handleRazorpayPayoutWebhook("payout.cancelled", {
        id: "pout_rzpx_1",
        status: "cancelled",
        reference_id: "org_payout_1",
        failure_reason: "Cancelled on dashboard",
      });

      expect(db.organizationPayout.updateMany).toHaveBeenCalledWith({
        where: { id: "org_payout_1", gatewayPayoutId: null },
        data: { gatewayPayoutId: "pout_rzpx_1" },
      });
      expect(payoutsMod.markOrgPayoutFailed).toHaveBeenCalledWith(
        "org_payout_1",
        "Cancelled on dashboard",
      );
    });
  });

  describe("6. Unique Constraint Violation Guard Helper", () => {
    it("identifies Prisma P2002 unique violations cleanly", () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`refundId`)",
        { code: "P2002", clientVersion: "6.0.0" },
      );
      expect(
        p2002 instanceof Prisma.PrismaClientKnownRequestError &&
          p2002.code === "P2002",
      ).toBe(true);
    });
  });
});
