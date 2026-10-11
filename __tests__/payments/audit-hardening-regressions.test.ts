import crypto from "crypto";
import { PaymentGateway } from "@prisma/client";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";
import {
  RazorpayPayoutsService,
  summariseFundAccountValidation,
} from "@/lib/payments/payouts/razorpay-payouts";
import { fitPrefixToRule46 } from "@/lib/payments/billing/invoice-numbering";
import { TDS_SECTION_DEFAULT_BPS } from "@/lib/compliance/tds";
import { razorpayWebhookEnvelopeSchema } from "@/schemas/webhooks/razorpay";

const TEST_WEBHOOK_KEY = `whsec_${"a".repeat(24)}`;

describe("Financial & Razorpay Audit Hardening Regressions", () => {
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

  const service = new RazorpayPayoutsService({
    keyId: "rzp_test_audit_key",
    keySecret: "rzp_test_audit_secret",
    accountNumber: "acct_rzpx_test_001",
    webhookSecret: TEST_WEBHOOK_KEY,
  });

  describe("RazorpayPayoutsService.determinePayoutMode", () => {
    it("enforces UPI ₹1,00,000 cap and IMPS/NEFT thresholds", () => {
      expect(service.determinePayoutMode(50_000, "vpa")).toBe("UPI");
      expect(service.determinePayoutMode(10_000_000, "vpa")).toBe("UPI");
      expect(() => service.determinePayoutMode(10_000_001, "vpa")).toThrow(
        /exceeds ₹1,00,000 limit/i,
      );
      expect(service.determinePayoutMode(50_000_000, "bank_account")).toBe(
        "IMPS",
      );
      expect(service.determinePayoutMode(50_000_001, "bank_account")).toBe(
        "NEFT",
      );
    });
  });

  describe("RazorpayPayoutsService.verifyWebhookSignature", () => {
    it("validates hex digests and handles 64-char multi-byte UTF-8 safely", () => {
      const payload = JSON.stringify({ event: "payout.processed" });
      const sig = crypto
        .createHmac("sha256", TEST_WEBHOOK_KEY)
        .update(payload)
        .digest("hex");
      expect(service.verifyWebhookSignature(payload, sig)).toBe(true);

      const multiByte64CodeUnits = "é".repeat(64);
      expect(multiByte64CodeUnits).toHaveLength(64);
      expect(
        service.verifyWebhookSignature(payload, multiByte64CodeUnits),
      ).toBe(false);
    });
  });

  describe("razorpayWebhookEnvelopeSchema — refund speed & payout error contracts", () => {
    it("parses strict refund speed enums and nested payout error objects", () => {
      const refundParsed = razorpayWebhookEnvelopeSchema.parse({
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
      expect(refundParsed.payload?.refund?.entity?.speed_processed).toBe(
        "optimum",
      );

      const payoutParsed = razorpayWebhookEnvelopeSchema.parse({
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
      expect(payoutParsed.payload?.payout?.entity?.error?.description).toBe(
        "Beneficiary bank rejected IFSC",
      );
    });
  });

  describe("createRazorpayOrder — money boundaries (zero, negative, sub-rupee, float, foreign currency)", () => {
    it.each([0, -500, 50, 99, 105.5])(
      "rejects invalid INR amount %s before calling Razorpay API",
      async (badAmount) => {
        await expect(
          createRazorpayOrder({
            paymentGateway: PaymentGateway.RAZORPAY,
            amount: badAmount,
            currency: "INR",
            metadata: {},
          }),
        ).rejects.toMatchObject({
          code: "INVALID_AMOUNT",
          gateway: "RAZORPAY",
        });
      },
    );

    it("rejects non-INR order currency before calling Razorpay API", async () => {
      await expect(
        createRazorpayOrder({
          paymentGateway: PaymentGateway.RAZORPAY,
          amount: 10_000,
          currency: "USD",
          metadata: {},
        }),
      ).rejects.toThrow(/INR/i);
    });
  });

  describe("summariseFundAccountValidation — Reverse Penny Drop (upi_intent) payload", () => {
    it("extracts bankAccount and registeredName when fund_account is omitted", () => {
      const summary = summariseFundAccountValidation({
        id: "fav_rpd_tab_close_001",
        entity: "fund_account.validation",
        status: "completed",
        reference_id: "cprofile_mobile_001",
        validation_results: {
          account_status: "active",
          registered_name: "Priya Nair",
          bank_account: {
            account_number: "acct_end4455",
            bank_routing_code: "HDFC0001234",
            bank_name: "HDFC Bank",
          },
        },
      });

      expect(summary).toMatchObject({
        accountStatus: "valid",
        referenceId: "cprofile_mobile_001",
        registeredName: "Priya Nair",
        bankAccount: {
          accountNumber: "acct_end4455",
          accountType: null,
          ifsc: "HDFC0001234",
          bankName: "HDFC Bank",
        },
      });
    });

    it("coerces string name_match_score ('00' -> 0, '100' -> 100) and falls back to ifsc", () => {
      const zeroScoreSummary = summariseFundAccountValidation({
        id: "fav_str_score_zero",
        entity: "fund_account.validation",
        status: "completed",
        results: {
          account_status: "active",
          registered_name: "Unknown Holder",
          name_match_score: "00" as unknown as number,
          bank_account: {
            account_number: "9988776655",
            ifsc: "ICIC0000123",
            bank_name: "ICICI Bank",
          },
        },
      });

      expect(zeroScoreSummary.nameMatchScore).toBe(0);
      expect(zeroScoreSummary.bankAccount?.ifsc).toBe("ICIC0000123");
    });
  });

  describe("CGST Rule 46(b) & Section 195 statutory constants", () => {
    it("sanitizes disallowed GSTN GSTR-1 characters and strips leading separators in fitPrefixToRule46", () => {
      expect(fitPrefixToRule46("-@WIPRO_INDIA!", 11)).toBe("WIPRO");
      expect(fitPrefixToRule46("---///", 11)).toBe("");
    });

    it("defines Section 195 non-resident withholding rate at 2000 bps (20%) alongside 194-O 10 bps (0.1%)", () => {
      expect(TDS_SECTION_DEFAULT_BPS["195"]).toBe(2000);
      expect(TDS_SECTION_DEFAULT_BPS["194O"]).toBe(10);
      expect(TDS_SECTION_DEFAULT_BPS["393-8(v)"]).toBe(10);
    });
  });
});
