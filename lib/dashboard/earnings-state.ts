/**
 * #1675 / #1527 W2 — the ONE derivation the consultant Earnings page reads an
 * earning or a payout through: which of three buckets a row sits in
 * (Available, Pending, Paid out), the badge word, and the one line under it.
 * Before this module the page showed the machine's vocabulary (READY,
 * BATCHED, PENDING_TRUST) in five tiles and eight filter tabs, and hardcoded
 * the hold-date rule inline.
 *
 * Pure and Prisma-free (type-only imports), so the client page and a jest pin
 * both run it. Nothing here decides legality — `earning-status.ts` owns the
 * transitions; this only names what the rows say.
 */

import { formatInTimeZone } from "date-fns-tz";
import type { EarningStatus, PayoutStatus } from "@prisma/client";
import { toneBadge, type Tone } from "@/lib/dashboard/money-state";

export type EarningBucket = "AVAILABLE" | "PENDING" | "PAID_OUT" | "REFUNDED";

export const BUCKET_LABEL: Record<EarningBucket, string> = {
  AVAILABLE: "Available",
  PENDING: "Pending",
  PAID_OUT: "Paid out",
  REFUNDED: "Refunded",
};

/**
 * The segmented list's words. The third segment lists EVERY payout with its
 * state (Queued / On its way / Paid / Failed / Returned), so it is "Payouts";
 * the tile keeps "Paid out" for its COMPLETED-only sum (QA #1774 case 3).
 */
export const SEGMENT_LABEL: Record<EarningBucket, string> = {
  ...BUCKET_LABEL,
  PAID_OUT: "Payouts",
};

export interface EarningRowInput {
  status: EarningStatus;
  holdUntil: Date | string | null;
  preDisputeStatus?: EarningStatus | null;
  consultantSharePaise: number;
  refundedShareAmount?: number;
  /** The sponsoring organisation when the booking was org-funded. */
  sponsorOrgName?: string | null;
}

export interface EarningPresentation {
  bucket: EarningBucket;
  label: string;
  tone: Tone;
  /** The one line under the badge — a date, a reason, never a second state word. */
  line: string;
  /** The hold's release instant for a PENDING row; null otherwise. */
  availableOn: Date | null;
}

export interface DeriveEarningOptions {
  now: Date;
  livePayoutsEnabled: boolean;
}

export interface PayoutRowInput {
  status: PayoutStatus;
  amount: number;
  tdsDeducted: number;
  netAmount: number | null;
  tdsRateAppliedBps: number | null;
  processedAt: Date | string | null;
  gatewayUtr: string | null;
  failureReason: string | null;
  createdAt: Date | string;
}

export interface PayoutPresentation {
  label: string;
  tone: Tone;
  line: string;
}

export interface MoneyWalk {
  share: number;
  tds: number;
  tdsRateBps: number;
  net: number;
}

export interface BucketSums {
  available: number;
  pending: number;
  paidOut: number;
}

/**
 * Mirrors the schedule in `.github/workflows/create-payout-batch.yml`
 * (`0 20 * * 1`); the workflow is never imported here.
 */
export const PAYOUT_BATCH_UTC = { weekday: 1, hour: 20 } as const;

/** Rows the page fetches in one read; the tiles sum these, so the cap is stated when it bites. */
export const EARNINGS_FETCH_CAP = 200;

/** Payouts are India-only (INR rails), so the dates on this page read in IST. */
export const PAYOUT_ZONE = "Asia/Kolkata";

const toDate = (d: Date | string): Date =>
  d instanceof Date ? d : new Date(d);
const toDateOrNull = (d: Date | string | null | undefined): Date | null =>
  d === null || d === undefined ? null : toDate(d);
const day = (d: Date) => formatInTimeZone(d, PAYOUT_ZONE, "d MMM");

/** Which of the three consultant-facing buckets a status belongs to. */
export function bucketOf(status: EarningStatus): EarningBucket {
  switch (status) {
    case "READY":
    case "BATCHED":
      return "AVAILABLE";
    case "PAID":
      return "PAID_OUT";
    case "REFUNDED":
      return "REFUNDED";
    default:
      return "PENDING";
  }
}

/** What an earning row says to the consultant who earned it. */
export function deriveEarningPresentation(
  e: EarningRowInput,
  opts: DeriveEarningOptions,
): EarningPresentation {
  const bucket = bucketOf(e.status);
  const org = e.sponsorOrgName ?? "the organisation";
  switch (e.status) {
    case "READY":
      return {
        bucket,
        label: "Available",
        tone: "info",
        line: opts.livePayoutsEnabled
          ? "Goes out in your next payout"
          : "Reserved for you until payouts begin",
        availableOn: null,
      };
    case "BATCHED":
      // With disbursement off a batched row is reserved at the platform, not
      // in transit (#776 §B); the badge must not imply otherwise.
      return {
        bucket,
        label: opts.livePayoutsEnabled ? "In this week's payout" : "Available",
        tone: "info",
        line: opts.livePayoutsEnabled
          ? "Locked into this week's payout run"
          : "Reserved for you until payouts begin",
        availableOn: null,
      };
    case "PENDING": {
      const availableOn = toDateOrNull(e.holdUntil);
      let line = "available after your sessions";
      if (availableOn) {
        line =
          availableOn > opts.now
            ? `available on ${day(availableOn)}`
            : "releasing shortly";
      }
      return { bucket, label: "Pending", tone: "neutral", line, availableOn };
    }
    case "HELD":
      return {
        bucket,
        label: "On hold",
        tone: "caution",
        line: e.preDisputeStatus
          ? "Held while a dispute on this booking is reviewed"
          : "Held for account review — support can tell you more",
        availableOn: null,
      };
    case "PENDING_TRUST":
      return {
        bucket,
        label: `Waiting for ${org}`,
        tone: "neutral",
        line: `Waiting for ${org}'s first paid invoice`,
        availableOn: null,
      };
    case "PAID":
      return {
        bucket,
        label: "Paid",
        tone: "success",
        line: "Paid out to your bank",
        availableOn: null,
      };
    case "REFUNDED":
      return {
        bucket,
        label: "Refunded",
        tone: "caution",
        line: "Returned to the client",
        availableOn: null,
      };
  }
}

/** Plain words the page may show for a failed transfer; anything else is the generic line. */
const FAILURE_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/name.?mismatch|beneficiary.?name/i, "the account name did not match"],
  [
    /invalid.?(account|ifsc)|account.?(closed|blocked|frozen|invalid)|ifsc/i,
    "your bank details did not match",
  ],
  [
    /bank.?offline|npci|unavailable|timeout|timed out/i,
    "your bank was unavailable",
  ],
  [/insufficient|balance|funds/i, "a delay on our side"],
];
const GENERIC_FAILURE = "bank rejected the transfer";
const KNOWN_FAILURE_OUTPUTS = new Set([
  ...FAILURE_WORDS.map(([, words]) => words),
  GENERIC_FAILURE,
]);

/**
 * A gateway failure string can embed provider ids (the reconcile note does), so
 * the consultant sees plain words, never the raw text. Idempotent, so the read
 * can sanitise before the payload leaves the server and the derivation can run
 * again on the client.
 */
export function sanitizePayoutFailure(reason: string | null): string {
  if (!reason) return GENERIC_FAILURE;
  if (KNOWN_FAILURE_OUTPUTS.has(reason)) return reason;
  return FAILURE_WORDS.find(([re]) => re.test(reason))?.[1] ?? GENERIC_FAILURE;
}

/** What a payout row says to the consultant it pays. */
export function derivePayoutPresentation(
  p: PayoutRowInput,
): PayoutPresentation {
  switch (p.status) {
    case "PENDING":
    case "APPROVED":
      return {
        label: "Queued",
        tone: "neutral",
        line: "Queued for the next payout run",
      };
    case "PROCESSING":
      return { label: "On its way", tone: "info", line: "Sent to your bank" };
    case "COMPLETED": {
      const at = toDateOrNull(p.processedAt) ?? toDate(p.createdAt);
      const utr = p.gatewayUtr ? ` · UTR ${p.gatewayUtr}` : "";
      return { label: "Paid", tone: "success", line: `Paid ${day(at)}${utr}` };
    }
    case "FAILED":
      return {
        label: "Failed",
        tone: "warning",
        line: `${capitalise(sanitizePayoutFailure(p.failureReason))}; we retry on Monday`,
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        tone: "neutral",
        line: "Cancelled before it was sent — the money stays in your balance",
      };
    case "REVERSED":
      return {
        label: "Returned by your bank",
        tone: "critical",
        line: "Your bank sent the transfer back — check your account details",
      };
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The Monday 20:00 UTC batch strictly after `now`. */
export function nextPayoutBatchAt(now: Date): Date {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      PAYOUT_BATCH_UTC.hour,
    ),
  );
  const ahead = (PAYOUT_BATCH_UTC.weekday - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + ahead);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

/** The Available tile's subtitle: flag-aware, so the page never implies money is moving when it is not. */
export function nextPayoutCopy(now: Date, livePayoutsEnabled: boolean): string {
  if (!livePayoutsEnabled) {
    return "Payouts begin at launch — your balance is safe with us";
  }
  // The batch is a Monday event in UTC; formatted in UTC so the day word holds.
  // #1771 row 6 — the free instant payout sits beside it, once a day.
  return `Paid every Monday, or get paid now once a day · next: ${formatInTimeZone(nextPayoutBatchAt(now), "UTC", "EEE d MMM")}`;
}

/**
 * What a payout row is worth to the bank. `netAmount` is nulled on the
 * failure/reversal paths (payout-service.ts) and a later COMPLETED can leave
 * it null, so the fallback is the same arithmetic the row and the tile use.
 */
export const payoutNet = (
  p: Pick<PayoutRowInput, "amount" | "tdsDeducted" | "netAmount">,
): number => p.netAmount ?? p.amount - p.tdsDeducted;

/** Share → TDS at the stamped rate (s.194-O) → net, for the walk sheet. */
export function moneyWalk(p: PayoutRowInput): MoneyWalk {
  return {
    share: p.amount,
    tds: p.tdsDeducted,
    tdsRateBps: p.tdsRateAppliedBps ?? 0,
    net: payoutNet(p),
  };
}

/** What the consultant will actually receive from a row: the share less what was refunded. */
const netShare = (e: EarningRowInput) =>
  e.consultantSharePaise - (e.refundedShareAmount ?? 0);

/** The three tile sums; Paid out is what reached the bank, after TDS. */
export function sumEarningBuckets(
  rows: ReadonlyArray<EarningRowInput>,
  payouts: ReadonlyArray<PayoutRowInput>,
): BucketSums {
  const sums: BucketSums = { available: 0, pending: 0, paidOut: 0 };
  for (const row of rows) {
    const bucket = bucketOf(row.status);
    if (bucket === "AVAILABLE") sums.available += netShare(row);
    else if (bucket === "PENDING") sums.pending += netShare(row);
  }
  for (const p of payouts) {
    if (p.status === "COMPLETED") sums.paidOut += moneyWalk(p).net;
  }
  return sums;
}

/** `StatusBadge` props for either presentation. */
export const presentationBadge = (p: { tone: Tone; label: string }) =>
  toneBadge(p.tone, p.label);
