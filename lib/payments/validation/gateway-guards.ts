/**
 * Runtime guard for gateway values a money path must not use: ones that exist
 * in the schema with no implementation behind them.
 *
 * Without this, a stub value reaching a money path falls through whatever
 * `default:` branch is nearest and gets treated as a working gateway — which
 * for a refund or a payout means silently doing nothing while the surrounding
 * code reports success. Failing loudly is the only safe behaviour: there is no
 * sensible fallback for "refund this through a gateway that does not exist".
 */
import { PaymentError } from "@/lib/payments/core/types";
import type { PaymentGateway } from "@prisma/client";
import { isUnimplementedGateway } from "@/lib/payments/constants";

export class UnsupportedGatewayError extends PaymentError {
  constructor(gateway: string, operation: string) {
    super(
      `Payment gateway "${gateway}" has no implementation — cannot ${operation}. ` +
        `It exists in the PaymentGateway enum as a label only ` +
        `(see UNIMPLEMENTED_GATEWAYS in lib/payments/constants.ts).`,
      "UNSUPPORTED_GATEWAY",
    );
    this.name = "UnsupportedGatewayError";
  }
}

/**
 * Throw if `gateway` is a schema-only label with no implementation behind it.
 *
 * `operation` completes the sentence "cannot ..." — e.g. "issue a refund".
 */
export function assertGatewayUsable(
  gateway: PaymentGateway,
  operation: string,
): void {
  if (isUnimplementedGateway(gateway)) {
    throw new UnsupportedGatewayError(gateway, operation);
  }
}
