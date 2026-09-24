/**
 * @jest-environment node
 */

/**
 * #1675 / #1527 W2 PR-Y — one derivation per earning and per payout. The
 * tables cover every EarningStatus and every PayoutStatus so a new enum value
 * fails here before it reaches the page as a raw word; the flag pin keeps the
 * timing copy honest while disbursement is off; the source guard keeps
 * gateway internals out of the consultant-facing payout read.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { EarningStatus, PayoutStatus } from "@prisma/client";
import {
  deriveEarningPresentation,
  derivePayoutPresentation,
  moneyWalk,
  nextPayoutCopy,
  sanitizePayoutFailure,
  sumEarningBuckets,
  type EarningRowInput,
  type PayoutRowInput,
} from "@/lib/dashboard/earnings-state";

const NOW = new Date("2026-09-20T09:12:00Z"); // a Sunday
const IN_5D = new Date("2026-09-25T09:12:00Z");
const LIVE = { now: NOW, livePayoutsEnabled: true };
const OFF = { now: NOW, livePayoutsEnabled: false };

const earning = (
  status: EarningStatus,
  over: Partial<EarningRowInput> = {},
): EarningRowInput => ({
  status,
  holdUntil: IN_5D,
  consultantSharePaise: 80_000,
  refundedShareAmount: 0,
  ...over,
});

const payout = (
  status: PayoutStatus,
  over: Partial<PayoutRowInput> = {},
): PayoutRowInput => ({
  status,
  amount: 100_000,
  tdsDeducted: 100,
  netAmount: 99_900,
  tdsRateAppliedBps: 10,
  processedAt: "2026-09-14T20:05:00Z",
  gatewayUtr: "UTR123",
  failureReason: null,
  createdAt: "2026-09-14T20:00:00Z",
  ...over,
});

describe("deriveEarningPresentation — every EarningStatus lands in one bucket", () => {
  it.each<[EarningStatus, string, string, RegExp]>([
    ["READY", "AVAILABLE", "Available", /next payout/],
    ["BATCHED", "AVAILABLE", "In this week's payout", /this week/],
    ["PENDING", "PENDING", "Pending", /^available on 25 Sep$/],
    ["HELD", "PENDING", "On hold", /account review/],
    [
      "PENDING_TRUST",
      "PENDING",
      "Waiting for Acme",
      /Acme's first paid invoice/,
    ],
    ["PAID", "PAID_OUT", "Paid", /bank/],
    ["REFUNDED", "REFUNDED", "Refunded", /client/],
  ])("%s → %s", (status, bucket, label, line) => {
    const p = deriveEarningPresentation(
      earning(status, { sponsorOrgName: "Acme" }),
      LIVE,
    );
    expect(p.bucket).toBe(bucket);
    expect(p.label).toBe(label);
    expect(p.line).toMatch(line);
    expect(p.availableOn).toEqual(status === "PENDING" ? IN_5D : null);
  });

  it("covers the whole enum", () => {
    expect(Object.values(EarningStatus)).toHaveLength(7);
  });

  it("a dispute hold names the dispute; a null hold and a matured hold read honestly", () => {
    expect(
      deriveEarningPresentation(
        earning("HELD", { preDisputeStatus: "READY" }),
        LIVE,
      ).line,
    ).toMatch(/dispute/);
    expect(
      deriveEarningPresentation(earning("PENDING", { holdUntil: null }), LIVE)
        .line,
    ).toBe("available after your sessions");
    expect(
      deriveEarningPresentation(
        earning("PENDING", { holdUntil: "2026-09-01T00:00:00Z" }),
        LIVE,
      ).line,
    ).toBe("releasing shortly");
  });

  it("with disbursement off, a batched row is reserved, not in transit", () => {
    const p = deriveEarningPresentation(earning("BATCHED"), OFF);
    expect(p.label).toBe("Available");
    expect(p.line).toMatch(/until payouts begin/);
  });
});

describe("derivePayoutPresentation — every PayoutStatus has one label and one line", () => {
  it.each<[PayoutStatus, string, string, RegExp]>([
    ["PENDING", "Queued", "neutral", /next payout run/],
    ["APPROVED", "Queued", "neutral", /next payout run/],
    ["PROCESSING", "On its way", "info", /Sent to your bank/],
    ["COMPLETED", "Paid", "success", /^Paid 15 Sep · UTR UTR123$/], // 20:05 UTC is the 15th in IST
    [
      "FAILED",
      "Failed",
      "warning",
      /^Bank rejected the transfer; we retry on Monday$/,
    ],
    ["CANCELLED", "Cancelled", "neutral", /stays in your balance/],
    ["REVERSED", "Returned by your bank", "critical", /account details/],
  ])("%s → %s", (status, label, tone, line) => {
    const p = derivePayoutPresentation(payout(status));
    expect(p.label).toBe(label);
    expect(p.tone).toBe(tone);
    expect(p.line).toMatch(line);
  });

  it("covers the whole enum", () => {
    expect(Object.values(PayoutStatus)).toHaveLength(7);
  });

  it("a failure reason is plain words, never the gateway's text or its ids", () => {
    const raw = "Gateway accepted (pout_ABC123); post-submit DB write failed";
    expect(sanitizePayoutFailure(raw)).toBe("bank rejected the transfer");
    expect(sanitizePayoutFailure("invalid_account_number")).toBe(
      "your bank details did not match",
    );
    // Idempotent, so the read can sanitise on the server and the client again.
    expect(sanitizePayoutFailure("your bank details did not match")).toBe(
      "your bank details did not match",
    );
    expect(
      derivePayoutPresentation(payout("FAILED", { failureReason: raw })).line,
    ).not.toMatch(/pout_/);
  });
});

describe("nextPayoutCopy and the tile sums", () => {
  it("is flag-aware: safe-with-us when off, the next Monday when on", () => {
    expect(nextPayoutCopy(NOW, false)).toBe(
      "Payouts begin at launch — your balance is safe with us",
    );
    expect(nextPayoutCopy(NOW, true)).toBe(
      "Paid every Monday, or get paid now once a day · next: Mon 21 Sep",
    );
    // A Monday after 20:00 UTC rolls to the following week.
    expect(nextPayoutCopy(new Date("2026-09-21T20:00:01Z"), true)).toBe(
      "Paid every Monday, or get paid now once a day · next: Mon 28 Sep",
    );
  });

  it("Available nets refunds, Pending gathers the three waiting states, Paid out is net of TDS", () => {
    const rows = [
      earning("READY", { refundedShareAmount: 5_000 }),
      earning("BATCHED"),
      earning("PENDING"),
      earning("HELD"),
      earning("PENDING_TRUST"),
      earning("PAID"),
      earning("REFUNDED", { refundedShareAmount: 80_000 }),
    ];
    const payouts = [payout("COMPLETED"), payout("FAILED"), payout("PENDING")];
    expect(sumEarningBuckets(rows, payouts)).toEqual({
      available: 155_000,
      pending: 240_000,
      paidOut: 99_900,
    });
    expect(moneyWalk(payout("COMPLETED", { netAmount: null }))).toEqual({
      share: 100_000,
      tds: 100,
      tdsRateBps: 10,
      net: 99_900,
    });
  });

  it("a zero row and a zero payout add nothing; a row refunded to its share nets to zero", () => {
    expect(
      sumEarningBuckets(
        [earning("READY", { consultantSharePaise: 0 })],
        [payout("COMPLETED", { amount: 0, tdsDeducted: 0, netAmount: 0 })],
      ),
    ).toEqual({ available: 0, pending: 0, paidOut: 0 });
    // refundEarnings caps the reversal at the share (earnings-service.ts), so
    // the floor a row can reach is exactly zero.
    expect(
      sumEarningBuckets([earning("READY", { refundedShareAmount: 80_000 })], [])
        .available,
    ).toBe(0);
  });
});

describe("the consultant payout read never names gateway internals", () => {
  it("getConsultantPayouts selects the money walk, the dates and the UTR only", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/payments/payouts/payout-service.ts"),
      "utf8",
    );
    const block = src.slice(src.indexOf("CONSULTANT_PAYOUT_SELECT"));
    expect(block).toContain("gatewayUtr: true");
    expect(block).not.toMatch(/providerPayoutId|idempotencyKey|batchId/);
  });
});
