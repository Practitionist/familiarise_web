/**
 * #1351 — a fenced or stub gateway must reach the caller as a business
 * rejection. Before this pin the guard's error matched no message pattern, so
 * `POST /api/checkout` with a disabled rail answered 500 UNKNOWN_ERROR and
 * Sentry recorded it as an unexpected exception.
 */
import {
  classifyError,
  ErrorTypes,
} from "@/lib/errors/classification/payment-error-classification";
import { getErrorToast } from "@/lib/errors/mapping/payment-error-toast-map";
import {
  DisabledGatewayError,
  UnsupportedGatewayError,
} from "@/lib/payments/validation/gateway-guards";

describe("gateway fence classification", () => {
  it("classifies a disabled gateway as a 422 business rejection", () => {
    const classified = classifyError(
      new DisabledGatewayError("STRIPE", "route a checkout"),
    );

    expect(classified.errorType).toBe(ErrorTypes.GATEWAY_UNAVAILABLE);
    expect(classified.isBusinessError).toBe(true);
    expect(classified.httpStatus).toBe(422);
  });

  it("classifies a stub gateway the same way", () => {
    const classified = classifyError(
      new UnsupportedGatewayError("PAYPAL", "issue a refund"),
    );

    expect(classified.errorType).toBe(ErrorTypes.GATEWAY_UNAVAILABLE);
    expect(classified.httpStatus).toBe(422);
  });

  it("gives the buyer a payment-method toast, not the env flag", () => {
    const toast = getErrorToast(ErrorTypes.GATEWAY_UNAVAILABLE);

    expect(toast.title).toBe("This payment method is not available");
    expect(toast.description).not.toContain("STRIPE_ENABLED");
  });

  // #1426 — WALLET_FROZEN, CONSENT_REQUIRED and CONSENT_WITHDRAWN are the
  // codes checkout.ts already throws (lib/payments/operations/checkout.ts:881,
  // :1556, :2538) but BUSINESS_ERROR_CODES only carried GATEWAY_DISABLED and
  // UNSUPPORTED_GATEWAY, so these three fell through to the 500 UNKNOWN path.
  it.each(["WALLET_FROZEN", "CONSENT_REQUIRED", "CONSENT_WITHDRAWN"])(
    "classifies %s as a business rejection with an actionable toast",
    (code) => {
      const classified = classifyError(
        Object.assign(new Error("refused"), { code }),
      );

      expect(classified.isBusinessError).toBe(true);
      expect(classified.httpStatus).not.toBe(500);

      const toast = getErrorToast(classified.errorType);
      expect(toast.title).not.toBe("Something Went Wrong");
      expect(toast.description).toBeTruthy();
    },
  );
});
