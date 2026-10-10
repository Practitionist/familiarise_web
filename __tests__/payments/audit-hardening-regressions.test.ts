import crypto from "crypto";
import { RazorpayPayoutsService } from "@/lib/payments/payouts/razorpay-payouts";
import { razorpayWebhookEnvelopeSchema } from "@/schemas/webhooks/razorpay";

describe("Financial & Razorpay Audit Hardening Regressions", () => {
  const service = new RazorpayPayoutsService({
    keyId: "rzp_test_audit_key",
    keySecret: "rzp_test_audit_secret",
    accountNumber: "2323230000000001",
    webhookSecret: "whsec_audit_test_secret",
  });

  describe("RazorpayPayoutsService.determinePayoutMode", () => {
    it("allows UPI payouts up to ₹1,00,000 (10,000,000 paise)", () => {
      expect(service.determinePayoutMode(10_000_000, "vpa")).toBe("UPI");
      expect(service.determinePayoutMode(50_000, "vpa")).toBe("UPI");
    });

    it("rejects UPI payouts exceeding ₹1,00,000 (10,000,000 paise)", () => {
      expect(() => service.determinePayoutMode(10_000_001, "vpa")).toThrow(
        /exceeds ₹1,00,000 limit/i,
      );
    });

    it("selects IMPS up to ₹5,00,000 and NEFT above ₹5,00,000 for bank accounts", () => {
      expect(service.determinePayoutMode(50_000_000, "bank_account")).toBe(
        "IMPS",
      );
      expect(service.determinePayoutMode(50_000_001, "bank_account")).toBe(
        "NEFT",
      );
    });
  });

  describe("RazorpayPayoutsService.verifyWebhookSignature", () => {
    it("accepts valid HMAC-SHA256 hex signatures", () => {
      const payload = JSON.stringify({ event: "payout.processed" });
      const sig = crypto
        .createHmac("sha256", "whsec_audit_test_secret")
        .update(payload)
        .digest("hex");
      expect(service.verifyWebhookSignature(payload, sig)).toBe(true);
    });

    it("returns false without throwing RangeError on 64-char multi-byte UTF-8 input", () => {
      const payload = JSON.stringify({ event: "payout.processed" });
      const multiByte64CodeUnits = "é".repeat(64);
      expect(multiByte64CodeUnits.length).toBe(64);
      expect(
        service.verifyWebhookSignature(payload, multiByte64CodeUnits),
      ).toBe(false);
    });
  });

  describe("razorpayWebhookEnvelopeSchema — refund speed & payout error contracts", () => {
    it("parses refund.speed_changed with optimum, instant, and normal speed_processed", () => {
      const parsed = razorpayWebhookEnvelopeSchema.parse({
        event: "refund.speed_changed",
        payload: {
          refund: {
            entity: {
              id: "rfnd_speed_001",
              payment_id: "pay_speed_001",
              amount: 50000,
              currency: "INR",
              status: "processed",
              speed_requested: "optimum",
              speed_processed: "optimum",
              notes: {},
            },
          },
        },
      });
      expect(parsed.payload?.refund?.entity?.speed_requested).toBe("optimum");
      expect(parsed.payload?.refund?.entity?.speed_processed).toBe("optimum");
    });

    it("parses payout.failed payload with nested error object when failure_reason is null", () => {
      const parsed = razorpayWebhookEnvelopeSchema.parse({
        event: "payout.failed",
        payload: {
          payout: {
            entity: {
              id: "pout_err_001",
              status: "failed",
              failure_reason: null,
              status_details: null,
              error: {
                code: "BAD_REQUEST_ERROR",
                description: "Beneficiary bank rejected IFSC",
                source: "beneficiary_bank",
                reason: "invalid_ifsc",
              },
            },
          },
        },
      });
      expect(parsed.payload?.payout?.entity?.error?.description).toBe(
        "Beneficiary bank rejected IFSC",
      );
    });
  });

  describe("createRazorpayOrder — minimum INR 1.00 (100 paise) integer floor", () => {
    const prevKey = process.env.RAZORPAY_KEY_ID;
    const prevSecret = process.env.RAZORPAY_SECRET;

    beforeAll(() => {
      process.env.RAZORPAY_KEY_ID = "rzp_test_min_floor_key";
      process.env.RAZORPAY_SECRET = "rzp_test_min_floor_secret";
    });

    afterAll(() => {
      process.env.RAZORPAY_KEY_ID = prevKey;
      process.env.RAZORPAY_SECRET = prevSecret;
    });

    it("rejects sub-₹1 (< 100 paise) or non-integer order amounts before calling Razorpay API", async () => {
      const { PaymentGateway } = await import("@prisma/client");
      const { createRazorpayOrder } =
        await import("@/lib/payments/core/razorpay");

      await expect(
        createRazorpayOrder({
          paymentGateway: PaymentGateway.RAZORPAY,
          amount: 50,
          currency: "INR",
          metadata: { test: "sub_rupee" },
        }),
      ).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
        gateway: "RAZORPAY",
      });

      await expect(
        createRazorpayOrder({
          paymentGateway: PaymentGateway.RAZORPAY,
          amount: 105.5,
          currency: "INR",
          metadata: { test: "float_paise" },
        }),
      ).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
        gateway: "RAZORPAY",
      });
    });
  });

  describe("summariseFundAccountValidation — Reverse Penny Drop (upi_intent) bank_account payload", () => {
    it("extracts bankAccount and registeredName when fund_account is omitted on upi_intent webhook", async () => {
      const { summariseFundAccountValidation } =
        await import("@/lib/payments/payouts/razorpay-payouts");
      const summary = summariseFundAccountValidation({
        id: "fav_rpd_tab_close_001",
        entity: "fund_account.validation",
        status: "completed",
        reference_id: "cprofile_mobile_001",
        validation_results: {
          account_status: "active",
          registered_name: "Priya Nair",
          bank_account: {
            account_number: "998877665544",
            bank_routing_code: "HDFC0001234",
            bank_name: "HDFC Bank",
          },
        },
      });

      expect(summary.accountStatus).toBe("valid");
      expect(summary.referenceId).toBe("cprofile_mobile_001");
      expect(summary.registeredName).toBe("Priya Nair");
      expect(summary.bankAccount).toEqual({
        accountNumber: "998877665544",
        accountType: null,
        ifsc: "HDFC0001234",
        bankName: "HDFC Bank",
      });
    });
  });
});
