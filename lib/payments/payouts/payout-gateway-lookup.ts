/**
 * Payout Gateway Lookup - shared core
 *
 * #1761 Sonar dedup — `scripts/payouts/reconcile-payout-status.ts` and
 * `scripts/payouts/handle-stuck-payouts.ts` carried byte-identical copies of
 * everything here. Both scripts keep their own row selection and O3
 * "retired" accounting; only the gateway query/mapping core moved.
 */

import { PayoutStatus, PaymentGateway } from "@prisma/client";
import { resolveRazorpayXCredentials } from "@/lib/payments/payouts/razorpay-payouts";
import { handlePayoutWebhook } from "@/lib/payments/payouts";

// #1757 — `unknown_id` (the gateway has no record of the id; terminal per row)
// is kept apart from `gateway_error` (unreachable, down, bad auth; retried).
export type PayoutLookup =
  | {
      kind: "status";
      status: string;
      failureMessage?: string;
      failureReason?: string;
      utr?: string;
    }
  | { kind: "unknown_id"; detail: string }
  | { kind: "gateway_error"; detail: string };

/** Stripe answers `resource_missing` / 404 for a payout or transfer id it never issued. */
export function isStripeUnknownId(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

/** Razorpay's error body is `{ error: { code, description } }`; tolerate anything else. */
async function razorpayErrorDescription(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; description?: unknown };
    };
    return [body?.error?.code, body?.error?.description]
      .filter((v): v is string => typeof v === "string")
      .join(": ");
  } catch {
    return "";
  }
}

// #677 PM-15 — narrow PayoutStatus to the status union handlePayoutWebhook
// accepts. mapGatewayStatus only ever returns these four, so the rest map to
// undefined (treated as "no canonical transition" at the call site).
export const WEBHOOK_STATUS_MAP: Partial<
  Record<
    PayoutStatus,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  >
> = {
  [PayoutStatus.COMPLETED]: "COMPLETED",
  [PayoutStatus.PROCESSING]: "PROCESSING",
  [PayoutStatus.FAILED]: "FAILED",
  [PayoutStatus.CANCELLED]: "CANCELLED",
};

/**
 * Query Stripe for payout/transfer status
 */
export async function getStripePayoutStatus(
  providerPayoutId: string,
): Promise<PayoutLookup> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return {
      kind: "gateway_error",
      detail: "Stripe credentials not configured",
    };
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    // Check if it's a transfer (tr_) or payout (po_)
    if (providerPayoutId.startsWith("tr_")) {
      const transfer = await stripe.transfers.retrieve(providerPayoutId);
      return {
        kind: "status",
        status: transfer.reversed ? "reversed" : "paid",
      };
    } else if (providerPayoutId.startsWith("po_")) {
      const payout = await stripe.payouts.retrieve(providerPayoutId);
      return {
        kind: "status",
        status: payout.status,
        failureMessage: payout.failure_message || undefined,
      };
    }

    return { kind: "gateway_error", detail: "unrecognised Stripe id prefix" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isStripeUnknownId(error)) return { kind: "unknown_id", detail };
    console.error(`Failed to get Stripe payout status: ${error}`);
    return { kind: "gateway_error", detail };
  }
}

/**
 * Query RazorpayX for payout status
 */
export async function getRazorpayPayoutStatus(
  providerPayoutId: string,
): Promise<PayoutLookup> {
  // #1407 — the same resolver the disbursement path uses. Reading
  // RAZORPAY_KEY_ID/RAZORPAY_SECRET here authenticated as the checkout
  // merchant, not the RazorpayX one, so on an account with distinct X keys
  // every lookup 401s and this reconciliation is silently dead while it
  // looks green. (#677 PM-1 kept the RAZORPAY_SECRET fallback, inside the
  // resolver now.)
  const { keyId, keySecret } = resolveRazorpayXCredentials();

  if (!keyId || !keySecret) {
    console.warn("RazorpayX credentials not configured");
    return {
      kind: "gateway_error",
      detail: "RazorpayX credentials not configured",
    };
  }

  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/payouts/${providerPayoutId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
      },
    );

    if (!response.ok) {
      // RazorpayX answers 400 BAD_REQUEST_ERROR ("does not exist"), not 404,
      // for an id it never issued; 401/403 is our key, anything else is theirs.
      const { status } = response;
      const description = await razorpayErrorDescription(response);
      if (status === 400 || status === 404) {
        return { kind: "unknown_id", detail: `${status} ${description}` };
      }
      console.error(`RazorpayX API error: ${status} ${description}`);
      return { kind: "gateway_error", detail: `${status} ${description}` };
    }

    const payout = await response.json();
    return {
      kind: "status",
      status: payout.status,
      failureReason: payout.failure_reason,
      // #677 PM-15 — RazorpayX returns the bank UTR on a processed payout;
      // capture it so the COMPLETED delegation can persist the reference.
      utr: payout.utr,
    };
  } catch (error) {
    console.error(`Failed to get RazorpayX payout status: ${error}`);
    return {
      kind: "gateway_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Map gateway payout status to our PayoutStatus
 */
export function mapGatewayStatus(
  gateway: PaymentGateway,
  status: string,
): PayoutStatus | null {
  if (gateway === PaymentGateway.STRIPE) {
    switch (status.toLowerCase()) {
      case "paid":
        return PayoutStatus.COMPLETED;
      case "pending":
        return PayoutStatus.PROCESSING;
      case "in_transit":
        return PayoutStatus.PROCESSING;
      case "canceled":
        return PayoutStatus.CANCELLED;
      case "failed":
        return PayoutStatus.FAILED;
      // This poller only walks PENDING/PROCESSING payouts, where the PAYOUT
      // ledger txn was never posted — a gateway "reversed" here is a net-zero
      // round trip, so FAILED handling (unlink earnings, reverse TDS) is the
      // correct accounting. Post-COMPLETED reversals arrive via the
      // payout.reversed webhook → markConsultantPayoutReversed (#812), which
      // does post the counter-txn. The failureReason records the distinction.
      case "reversed":
        return PayoutStatus.FAILED;
      default:
        return null;
    }
  } else if (gateway === PaymentGateway.RAZORPAY) {
    switch (status.toLowerCase()) {
      case "processed":
        return PayoutStatus.COMPLETED;
      case "processing":
        return PayoutStatus.PROCESSING;
      case "queued":
        return PayoutStatus.PROCESSING;
      case "pending":
        return PayoutStatus.PROCESSING;
      case "rejected":
        return PayoutStatus.FAILED;
      // #1407 — RazorpayX returns `failed` for a payout the bank refused after
      // it was queued, and the arm had only `rejected`. That is precisely the
      // cohort this sweep walks, so the payout fell through as an unknown
      // status and was skipped: PENDING/PROCESSING forever, earnings still
      // batched against money that never left. The Stripe arm has always
      // mapped it. FAILED delegation un-batches the earnings and reverses TDS.
      case "failed":
        return PayoutStatus.FAILED;
      case "reversed":
        return PayoutStatus.FAILED;
      case "cancelled":
        return PayoutStatus.CANCELLED;
      default:
        return null;
    }
  }

  return null;
}

/**
 * #1757 — an id the gateway has no record of is terminal for this row, not a
 * run failure: retire it FAILED via the canonical handler (releases
 * earnings, TDS). Callers own their own retiredCount/retired[] accounting.
 */
export async function retireUnknownGatewayPayout(
  payout: { provider: PaymentGateway; providerPayoutId: string },
  detail: string,
): Promise<void> {
  console.warn(
    `   Gateway does not know ${payout.providerPayoutId} (${detail}) - retiring as FAILED/GATEWAY_UNKNOWN_ID`,
  );
  await handlePayoutWebhook(
    payout.provider,
    payout.providerPayoutId,
    "FAILED",
    "GATEWAY_UNKNOWN_ID",
  );
}
