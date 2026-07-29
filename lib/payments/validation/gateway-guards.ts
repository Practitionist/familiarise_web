/**
 * Runtime guard for gateway values that exist in the schema but have no
 * implementation.
 *
 * Without this, a stub value reaching a money path falls through whatever
 * `default:` branch is nearest and gets treated as a working gateway — which
 * for a refund or a payout means silently doing nothing while the surrounding
 * code reports success. Failing loudly is the only safe behaviour: there is no
 * sensible fallback for "refund this through a gateway that does not exist".
 */
import { PaymentError } from "@/lib/payments/core/types";
import { isPostMvpGatewayStub } from "@/lib/payments/constants";

export class UnsupportedGatewayError extends PaymentError {
  constructor(gateway: string, operation: string) {
    super(
      `Payment gateway "${gateway}" has no implementation — cannot ${operation}. ` +
        `It exists in the PaymentGateway enum as a post-MVP placeholder only ` +
        `(see POST_MVP_GATEWAY_STUBS in lib/payments/constants.ts).`,
      "UNSUPPORTED_GATEWAY",
    );
    this.name = "UnsupportedGatewayError";
  }
}

/**
 * Throw if `gateway` is a schema-only placeholder.
 *
 * `operation` completes the sentence "cannot ..." — e.g. "issue a refund".
 */
export function assertGatewayUsable(gateway: string, operation: string): void {
  if (isPostMvpGatewayStub(gateway)) {
    throw new UnsupportedGatewayError(gateway, operation);
  }
}
