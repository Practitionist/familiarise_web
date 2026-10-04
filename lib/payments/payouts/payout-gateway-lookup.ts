/**
 * Payout Gateway Lookup - shared core
 *
 * #1761 Sonar dedup — `scripts/payouts/reconcile-payout-status.ts` and
 * `scripts/payouts/handle-stuck-payouts.ts` carried byte-identical copies of
 * everything here. Both scripts keep their own row selection and O3
 * "retired" accounting; only the gateway query/mapping core moved.
 */

import { PayoutStatus, PaymentGateway } from "@prisma/client";
import {
  getRazorpayPayoutsService,
  resolveRazorpayXCredentials,
} from "@/lib/payments/payouts/razorpay-payouts";
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
      // #1761 CodeRabbit — 404 is always unknown_id; a 400 is only unknown_id
      // when the description names a missing/invalid id, else it's a real error.
      const { status } = response;
      const description = await razorpayErrorDescription(response);
      const isMissingIdReason = /does not exist|not found|invalid id/i.test(
        description,
      );
      if (status === 404 || (status === 400 && isMissingIdReason)) {
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

/** What RazorpayX holds under one of our payout ids used as `reference_id`. */
export type ReferenceLookup =
  | { kind: "found"; providerPayoutId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; detail: string }
  | { kind: "gateway_error"; detail: string };

/**
 * #1846 N1 — find the RazorpayX payout created for one of our payout rows by
 * its `reference_id`. A submit whose reply was lost leaves the row with no
 * provider id, and this is how reconcile learns whether the transfer exists
 * before it resubmits or fails the row. `none` is the only answer that makes
 * a resubmission safe; more than one match is left to an operator.
 */
export async function findRazorpayPayoutByReference(
  referenceId: string,
): Promise<ReferenceLookup> {
  try {
    const page = await getRazorpayPayoutsService().listPayouts({
      referenceId,
      count: 10,
    });
    // The client does not re-case the body, so items keep RazorpayX's
    // snake_case fields.
    const items = (page.items ?? []) as unknown as Array<{
      id: string;
      reference_id?: string | null;
    }>;
    const matches = items.filter((item) => item.reference_id === referenceId);
    if (matches.length === 0) return { kind: "none" };
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        detail: `${matches.length} RazorpayX payouts carry reference ${referenceId}: ${matches.map((m) => m.id).join(", ")}`,
      };
    }
    return { kind: "found", providerPayoutId: matches[0].id };
  } catch (error) {
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
  if (gateway === PaymentGateway.RAZORPAY) {
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
      // batched against money that never left. FAILED delegation un-batches
      // the earnings and reverses TDS.
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
