/**
 * @jest-environment node
 */

/**
 * #1675 / #1527 W2 PR-Y — the consultant Earnings summary renders three
 * tiles and one list from `earnings-state.ts`. One row per bucket and one
 * COMPLETED payout: the tile sums, the hold date, the payout walk's net figure,
 * and no raw enum word anywhere in the DOM.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EarningsBuckets,
  type EarningsResponse,
} from "@/app/dashboard/consultant/[consultantId]/(features)/earnings/EarningsBuckets";
import { PayoutWalkBody } from "@/app/dashboard/consultant/[consultantId]/(features)/earnings/PayoutWalkSheet";
import { sumEarningBuckets } from "@/lib/dashboard/earnings-state";

const NOW = new Date("2026-09-20T09:12:00Z");
const AT = "2026-09-18T10:00:00Z";

type Earning = EarningsResponse["earnings"][number];
type Payout = EarningsResponse["payouts"][number];

const earning = (
  id: string,
  status: Earning["status"],
  over: Partial<Earning> = {},
): Earning => ({
  id,
  consultantProfileId: "cp_1",
  paymentId: `pay_${id}`,
  payoutId: null,
  grossAmount: 100_000,
  platformFeePaise: 20_000,
  consultantSharePaise: 80_000,
  refundedShareAmount: 0,
  gstTcsAccruedPaise: null,
  role: "OWNER",
  shareBps: 10_000,
  appointmentOccurrenceId: null,
  status,
  holdUntil: "2026-09-25T09:12:00Z",
  paidAt: null,
  preDisputeStatus: null,
  currency: "INR",
  createdAt: AT,
  updatedAt: AT,
  title: `Plan ${id}`,
  sponsorOrgName: null,
  payment: {
    id: `pay_${id}`,
    amount: 118_000,
    originalAmount: 100_000,
    currency: "INR",
    createdAt: AT,
    paymentMethod: "CARD",
    organizationId: null,
    organization: null,
    legs: [],
    appointment: null,
  },
  payout: null,
  ...over,
});

const payout = (status: Payout["status"]): Payout => ({
  id: `po_${status}`,
  status,
  amount: 80_000,
  tdsDeducted: 80,
  netAmount: 79_920,
  tdsRateAppliedBps: 10,
  tdsFinancialYear: "2026-27",
  processedAt: "2026-09-14T20:05:00Z",
  gatewayUtr: "UTR9",
  failureReason: null,
  mustPayByDate: null,
  createdAt: "2026-09-14T20:00:00Z",
});

const data: EarningsResponse = {
  summary: {
    consultantProfileId: "cp_1",
    totalEarnings: 0,
    pendingEarnings: 0,
    readyEarnings: 0,
    batchedEarnings: 0,
    paidEarnings: 0,
    heldEarnings: 0,
    pendingTrustEarnings: 0,
  },
  eligibility: {
    consultantProfileId: "cp_1",
    isEligible: false,
    readyAmount: 75_000,
    minimumAmount: 50_000,
    hasPayoutAccount: false,
  },
  earnings: [
    earning("a", "READY", { refundedShareAmount: 5_000 }),
    earning("b", "PENDING", { sponsorOrgName: "Acme Corp" }),
    earning("c", "PAID", { payoutId: "po_COMPLETED" }),
  ],
  payouts: [payout("COMPLETED")],
  // The read's whole-account sums (Y-1's arithmetic run server-side).
  totals: sumEarningBuckets(
    [
      earning("a", "READY", { refundedShareAmount: 5_000 }),
      earning("b", "PENDING"),
      earning("c", "PAID"),
    ],
    [payout("COMPLETED")],
  ),
  pagination: { total: 3, limit: 200, offset: 0, hasMore: false },
  livePayoutsEnabled: false,
};

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(node).replaceAll("&#x27;", "'");

it("sums the three tiles, shows the hold date and the sponsor, and never a raw enum", () => {
  const html = render(
    <EarningsBuckets consultantId="c_1" data={data} now={NOW} />,
  );
  // Available = 80,000 − 5,000; Pending = 80,000; Paid out = 79,920 net.
  expect(html).toContain("₹750.00");
  expect(html).toContain("₹800.00");
  expect(html).toContain("₹799.20");
  expect(html).toContain("Payouts begin at launch");
  expect(html).toContain("Add your bank account to get paid");
  expect(html).toContain("/dashboard/consultant/c_1/settings/payouts");
  expect(html).toMatch(/₹1,000\.00.*−.*₹200\.00.*platform.*₹800\.00.*yours/);
  expect(html).not.toMatch(/\b(READY|BATCHED|PENDING_TRUST|PROCESSING|HELD)\b/);
});

it("the Pending and Paid-out segments carry the hold date, the sponsor and the walk", () => {
  const pending = render(
    <EarningsBuckets
      consultantId="c_1"
      data={data}
      now={NOW}
      initialSegment="PENDING"
    />,
  );
  expect(pending).toContain("available on 25 Sep");
  expect(pending).toContain("Acme Corp");

  const paid = render(
    <EarningsBuckets
      consultantId="c_1"
      data={data}
      now={NOW}
      initialSegment="PAID_OUT"
    />,
  );
  expect(paid).toContain("Paid 15 Sep · UTR UTR9");

  const walk = render(<PayoutWalkBody payout={data.payouts[0]} />);
  expect(walk).toContain("₹799.20");
  expect(walk).toContain("TDS @ 0.1% (s.194-O)");
  expect(walk).toContain("UTR9");
});
