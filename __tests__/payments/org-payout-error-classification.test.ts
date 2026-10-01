/**
 * @jest-environment node
 */

/**
 * #1846 N1 — the org payout rail classified RazorpayX submission failures by
 * string-sniffing the error message for "400" / "401" / "403" / "422" /
 * "invalid" / "bad request". A message match cannot tell a rejection from a
 * throttle, so a 429, a 408, a 409, or a 5xx whose description happened to
 * contain the word "invalid" all read as PERMANENT_4XX.
 *
 * That is a money-loss bug, not a cosmetic one. PERMANENT_4XX routes into
 * `markPayoutFailedFromSubmission`, which releases the organization's BATCHED
 * earnings back to READY. The next `createOrgPayoutBatch` re-claims them under
 * a NEW payout row with a NEW idempotency key
 * (`opts.idempotencyKey ?? globalThis.crypto.randomUUID()`), and RazorpayX
 * documents the consequence verbatim:
 *
 *   "Do not retry the same payout using a fresh Idempotency Key when the first
 *    attempt is still processing. The system will treat them as different
 *    payouts and will process both resulting in duplication."
 *
 * So a misclassified transient permanently double-pays the organization.
 *
 * These tests pin the classification the org rail now performs — the same
 * status-based gate the consultant rail uses (`isDefinitiveGatewayRejection`,
 * razorpay-payouts.ts:342) — so the invariant holds on both rails: ONLY a
 * definitive gateway rejection may fail a payout and release its earnings.
 * Everything the gate does not recognise must be treated as still-in-flight
 * and retried under the SAME idempotency key.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationPayout: { findMany: jest.fn(), update: jest.fn() },
    organizationPayoutAccount: { findUnique: jest.fn() },
    organizationEarnings: { updateMany: jest.fn(), findFirst: jest.fn() },
    orgAuditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  __esModule: true,
  notifyOrgPayoutCompleted: jest.fn(),
  notifyOrgPayoutFailed: jest.fn(),
}));

import {
  RazorpayXHttpError,
  isDefinitiveGatewayRejection,
} from "@/lib/payments/payouts/razorpay-payouts";
import { classifyGatewaySubmissionError } from "@/lib/payments/payouts/org-payout-service";

/**
 * Build the error the RazorpayX `apiRequest` non-2xx branch actually throws
 * (razorpay-payouts.ts:451): a `RazorpayXHttpError` carrying `httpStatus` plus
 * the gateway's own description.
 */
const gatewayError = (httpStatus: number, description: string) =>
  new RazorpayXHttpError(
    `RazorpayX API error (HTTP ${httpStatus}) on POST /payouts: ${description}`,
    "BAD_REQUEST_ERROR",
    httpStatus,
    { error: { code: "BAD_REQUEST_ERROR", description } },
  );

type Case = { label: string; err: unknown };

describe("org payout submission error classification (#1846 N1)", () => {
  // The gateway refused the payout outright, so no transfer exists: the row may
  // be failed and its earnings released. These are the ONLY statuses that may
  // do so.
  const DEFINITIVE: number[] = [400, 401, 403, 422];
  it.each(DEFINITIVE)(
    "treats a %i as a definitive rejection (PERMANENT_4XX)",
    (status) => {
      const err = gatewayError(status, "fund account could not be verified");

      expect(classifyGatewaySubmissionError(err)).toBe("PERMANENT_4XX");
      // The org classifier must not be a second opinion — it delegates to the
      // shared gate, so the two rails cannot disagree.
      expect(isDefinitiveGatewayRejection(err)).toBe(true);
    },
  );

  // 408/409/429 are answers about the REQUEST, not about the payout — the
  // transfer may still exist at RazorpayX. Failing these released the
  // organization's earnings and let the next batch pay it a second time under
  // a fresh idempotency key.
  const REQUEST_LEVEL: Case[] = [
    {
      label: "a 408 (request timeout)",
      err: gatewayError(408, "request timed out before the gateway answered"),
    },
    {
      label: "a 409 (conflict)",
      err: gatewayError(409, "a conflicting payout is already being processed"),
    },
    {
      label: "a 429 (rate limited)",
      err: gatewayError(429, "too many requests, rate limited"),
    },
  ];
  it.each(REQUEST_LEVEL)(
    "treats $label as still-in-flight (TRANSIENT_OR_UNKNOWN)",
    ({ err }) => {
      expect(classifyGatewaySubmissionError(err)).toBe("TRANSIENT_OR_UNKNOWN");
      expect(isDefinitiveGatewayRejection(err)).toBe(false);
    },
  );

  // A 5xx says nothing about whether the payout was created.
  const SERVER_ERRORS: number[] = [500, 502, 503];
  it.each(SERVER_ERRORS)(
    "treats a %i as still-in-flight (TRANSIENT_OR_UNKNOWN)",
    (status) => {
      const err = gatewayError(status, "upstream failure");

      expect(classifyGatewaySubmissionError(err)).toBe("TRANSIENT_OR_UNKNOWN");
      expect(isDefinitiveGatewayRejection(err)).toBe(false);
    },
  );

  // THE REGRESSION. Each of these descriptions contains a substring the old
  // sniffer matched. Reading prose cannot tell a 429 from a 422, so every one
  // of them must now be TRANSIENT.
  const PROSE_TRAPS: Case[] = [
    {
      label: "a 429 whose description says invalid",
      err: gatewayError(429, "invalid api key rate limit reached, retry later"),
    },
    {
      label: "a 408 whose description says bad request",
      err: gatewayError(408, "bad request: upstream timed out"),
    },
    {
      label: "a 409 whose description says 422 and invalid",
      err: gatewayError(
        409,
        "422 invalid fund_account_id is already in flight",
      ),
    },
    {
      label: "a 503 whose description says invalid",
      err: gatewayError(
        503,
        "service temporarily unavailable: invalid upstream state",
      ),
    },
    {
      label: "a 502 whose description says bad request",
      err: gatewayError(502, "bad request relayed by the edge, please retry"),
    },
  ];
  it.each(PROSE_TRAPS)(
    "never sniffs prose: $label stays TRANSIENT_OR_UNKNOWN",
    ({ err }) => {
      expect(classifyGatewaySubmissionError(err)).toBe("TRANSIENT_OR_UNKNOWN");
    },
  );

  // The default must be TRANSIENT. A timeout, a socket error, an unreadable
  // body and an unrecognised throw all leave the outcome unknown, and unknown
  // is not the same as "rejected" — the row has to stay PROCESSING with its
  // earnings BATCHED so the cron retries under the SAME idempotency key.
  const UNRECOGNISED: Case[] = [
    { label: "a generic Error", err: new Error("socket hang up") },
    { label: "an empty Error", err: new Error("") },
    { label: "a bare string", err: "RazorpayX API error" },
    { label: "undefined", err: undefined },
    { label: "null", err: null },
    { label: "a plain object", err: { message: "invalid" } },
    {
      // The old sniffer matched "invalid" here and released the earnings.
      label: "a statusless Error whose message says invalid",
      err: new Error("RazorpayX API error: Invalid fund_account_id"),
    },
    {
      label: "a statusless Error whose message says bad request",
      err: new Error("bad request"),
    },
    {
      label: "a statusless Error whose message says 400",
      err: new Error("400 something went wrong"),
    },
  ];
  it.each(UNRECOGNISED)(
    "defaults $label to TRANSIENT_OR_UNKNOWN",
    ({ err }) => {
      expect(classifyGatewaySubmissionError(err)).toBe("TRANSIENT_OR_UNKNOWN");
    },
  );

  // A 2xx is not a rejection either — only the named 4xx range is.
  const NON_REJECTIONS: number[] = [200, 201, 302];
  it.each(NON_REJECTIONS)(
    "does not treat a %i as a definitive rejection",
    (status) => {
      expect(classifyGatewaySubmissionError(gatewayError(status, "ok"))).toBe(
        "TRANSIENT_OR_UNKNOWN",
      );
    },
  );
});
