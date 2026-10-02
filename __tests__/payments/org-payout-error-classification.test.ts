/**
 * @jest-environment node
 */

/**
 * Only a definitive gateway rejection may fail a payout and release its
 * earnings. Anything else stays in flight and is retried under the SAME
 * idempotency key; a fresh key would make RazorpayX pay the batch twice.
 */

import {
  RazorpayXHttpError,
  isDefinitiveGatewayRejection,
} from "@/lib/payments/payouts/razorpay-payouts";
import { classifyGatewaySubmissionError } from "@/lib/payments/payouts/shared-lifecycle";

/**
 * Build the error the RazorpayX `apiRequest` non-2xx branch throws: a
 * `RazorpayXHttpError` carrying `httpStatus` plus the gateway's description.
 */
const gatewayError = (httpStatus: number, description: string) =>
  new RazorpayXHttpError(
    `RazorpayX API error (HTTP ${httpStatus}) on POST /payouts: ${description}`,
    "BAD_REQUEST_ERROR",
    httpStatus,
    { error: { code: "BAD_REQUEST_ERROR", description } },
  );

type Case = { label: string; err: unknown };

describe("payout submission error classification", () => {
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
  // transfer may still exist at RazorpayX, so releasing its earnings would let
  // the next batch pay it a second time under a fresh idempotency key.
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

  // Each description contains a substring a prose sniffer would match. Prose
  // cannot tell a 429 from a 422, so only the status decides.
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
