/**
 * #771 D2 / Batch 5 — Razorpay Route (routed wallet settlement) — SCAFFOLD.
 *
 * Target architecture: the platform stops CUSTODYING org wallet funds. A top-up
 * is routed to a Razorpay Route escrow / linked account; `BillingAccount.walletBalance`
 * becomes a MIRROR of the PA-held balance; payouts move via RazorpayX from that
 * float. This keeps the platform out of RBI Payment-Aggregator / PPI scope (see
 * the review §"Wallet & RBI" and AF-4).
 *
 * ⚠️ STATUS: NOT LIVE. This file defines the integration CONTRACT and config
 * gate only. It is deliberately not wired into the live top-up path
 * (`lib/api/organizations/wallet.ts` / `confirmTopUp`), which stays custodial.
 * Going live requires, externally:
 *   1. A written CA/RBI opinion confirming the pass-through stance (D2 gate).
 *   2. Razorpay Route enabled on the merchant account + linked-account onboarding.
 *   3. `RAZORPAY_ROUTE_*` credentials (see `.env.sample`).
 * Until then `isRazorpayRouteConfigured()` returns false and the service throws
 * if called — fail-closed, never silently custodial-by-accident.
 */

export interface RouteTransferResult {
  /** Razorpay transfer id (trf_*). */
  transferId: string;
  /** Settlement status as reported by the gateway. */
  status: string;
}

export interface RazorpayRouteConfig {
  keyId: string;
  keySecret: string;
  /** Escrow / parent account the routed funds settle into. */
  accountNumber: string;
}

/** True only when Route credentials are present AND routed wallet is enabled. */
export function isRazorpayRouteConfigured(): boolean {
  return (
    process.env.ENABLE_ROUTED_WALLET === "true" &&
    !!process.env.RAZORPAY_ROUTE_KEY_ID &&
    !!process.env.RAZORPAY_ROUTE_KEY_SECRET &&
    !!process.env.RAZORPAY_ROUTE_ACCOUNT_NUMBER
  );
}

function notEnabled(method: string): never {
  throw new Error(
    `RazorpayRoute.${method} called but routed wallet is not enabled. ` +
      `This is the #771 D2 scaffold — requires the CA/RBI opinion, Route enablement, ` +
      `and RAZORPAY_ROUTE_* credentials before it can go live.`,
  );
}

/**
 * Routed-settlement client. Methods mirror the Razorpay Route API surface the
 * routed wallet needs; bodies are intentionally unimplemented until the gate
 * above is satisfied (so this can't accidentally run against a misconfigured
 * account). When wiring: model the HTTP layer on `razorpay-payouts.ts`'s
 * `apiRequest` against `https://api.razorpay.com/v1` (POST /accounts for linked
 * accounts, POST /transfers for routed settlement, POST /transfers/:id/reversals
 * for reversals).
 */
export class RazorpayRouteService {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _config: RazorpayRouteConfig) {}

  /** Ensure a Route linked account exists for the org; returns acc_* id. */
  async ensureLinkedAccount(_organizationId: string): Promise<string> {
    return notEnabled("ensureLinkedAccount");
  }

  /** Route a confirmed top-up into the org's escrow/linked account. */
  async routeTopUp(_params: {
    orderId: string;
    amountPaise: number;
    linkedAccountId: string;
  }): Promise<RouteTransferResult> {
    return notEnabled("routeTopUp");
  }

  /** Reverse a routed transfer (refund of a wallet top-up). */
  async reverseTransfer(_transferId: string, _amountPaise: number): Promise<RouteTransferResult> {
    return notEnabled("reverseTransfer");
  }
}

export function getRazorpayRouteService(): RazorpayRouteService {
  if (!isRazorpayRouteConfigured()) {
    notEnabled("getRazorpayRouteService");
  }
  return new RazorpayRouteService({
    keyId: process.env.RAZORPAY_ROUTE_KEY_ID!,
    keySecret: process.env.RAZORPAY_ROUTE_KEY_SECRET!,
    accountNumber: process.env.RAZORPAY_ROUTE_ACCOUNT_NUMBER!,
  });
}
