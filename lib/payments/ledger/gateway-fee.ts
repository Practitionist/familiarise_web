import type { PrismaLike } from "@/lib/prisma";
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";

/** One fee journal per capture: the capture webhook and the settlement job share this key. */
export const gatewayFeeKey = (gatewayPaymentId: string): string =>
  `gatewayfee:${gatewayPaymentId}`;

/**
 * Dr GATEWAY_FEE (fee − tax) / Dr GST_INPUT_CREDIT (tax) / Cr GATEWAY_CLEARING (fee).
 * `feePaise` is the gateway's fee including GST; `taxPaise` is the GST part.
 */
export async function postGatewayFee(
  db: PrismaLike,
  input: { gatewayPaymentId: string; feePaise: number; taxPaise: number },
): Promise<{ created: boolean }> {
  const { gatewayPaymentId, feePaise } = input;
  if (!Number.isSafeInteger(feePaise) || feePaise <= 0) {
    return { created: false };
  }
  const taxPaise = Math.min(Math.max(0, input.taxPaise), feePaise);
  const postings: Posting[] = [];
  if (feePaise - taxPaise > 0) {
    postings.push({
      account: { kind: "GATEWAY_FEE" },
      direction: "DEBIT",
      amountPaise: feePaise - taxPaise,
    });
  }
  if (taxPaise > 0) {
    postings.push({
      account: { kind: "GST_INPUT_CREDIT" },
      direction: "DEBIT",
      amountPaise: taxPaise,
    });
  }
  postings.push({
    account: gatewayCashAccount(),
    direction: "CREDIT",
    amountPaise: feePaise,
  });
  const { created } = await postLedgerTxn(db, {
    idempotencyKey: gatewayFeeKey(gatewayPaymentId),
    kind: "GATEWAY_FEE",
    description: `Gateway fee on ${gatewayPaymentId}`,
    postings,
  });
  return { created };
}
