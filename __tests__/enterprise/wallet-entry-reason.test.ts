/**
 * @jest-environment node
 */

/** An org wallet line is named by its posting's subtype and direction, the same on the Wallet tab and in analytics. */

import {
  walletActivityByReason,
  walletLedgerLineSelect,
  walletLedgerRow,
  type WalletLedgerLine,
} from "@/lib/api/organizations/wallet";
import { walletReasonLabel } from "@/lib/labels/money-labels";

const at = new Date("2026-11-20T10:00:00Z");
const line = (
  id: string,
  direction: WalletLedgerLine["direction"],
  amountPaise: number,
  kind: WalletLedgerLine["transaction"]["kind"],
  idempotencyKey: string,
): WalletLedgerLine => ({
  id,
  direction,
  amountPaise,
  createdAt: at,
  transaction: { kind, idempotencyKey, paymentId: "pay_parent" },
});

// The wallet lines each overage path posts, keyed as the posting functions key them.
const booked = line("e1", "DEBIT", 1000_00, "BOOKING", "booking:pay_parent");
const carvedForMember = line(
  "e2",
  "CREDIT",
  400_00,
  "OVERAGE_MEMBER",
  "overage-carve-credit:ov_1",
);
const memberUnpaid = line(
  "e3",
  "DEBIT",
  400_00,
  "OVERAGE_MEMBER",
  "overage-restore:ov_1",
);
const memberPaidLate = line(
  "e4",
  "CREDIT",
  400_00,
  "OVERAGE_MEMBER",
  "overage-recarve:ov_1",
);
const orgSurcharge = line(
  "e5",
  "DEBIT",
  118_00,
  "BOOKING",
  "overage-accrual:ov_2",
);

// A top-up refund after part of the top-up was spent: the clawback and the unrecovered part.
const topUpRefunded = line(
  "e6",
  "DEBIT",
  1000_00,
  "TOPUP_REFUND",
  "topup-refund:rfnd_1",
);
const topUpRefundShortfall = line(
  "e7",
  "CREDIT",
  700_00,
  "TOPUP_REFUND",
  "topup-refund-shortfall:rfnd_1",
);

const labelOf = (l: WalletLedgerLine) =>
  walletReasonLabel(walletLedgerRow(l).reason);

describe("wallet ledger rows", () => {
  it("names a member-billed base credit and its unpaid reversal apart", () => {
    expect(labelOf(carvedForMember)).toBe(
      "Returned to the wallet: a member is billed for their extra session",
    );
    expect(labelOf(memberPaidLate)).toBe(labelOf(carvedForMember));
    expect(labelOf(memberUnpaid)).toBe(
      "Paid by the wallet: a member's extra-session charge went unpaid",
    );
  });

  it("names an org-paid overage surcharge apart from the session it rode on", () => {
    expect(labelOf(orgSurcharge)).toBe("Extra-session surcharge");
    expect(labelOf(booked)).toBe("Session booked");
  });

  it("names a top-up refund's unrecovered part apart from the refund", () => {
    expect(walletLedgerRow(topUpRefundShortfall).reason).toBe(
      "TOPUP_REFUND_SHORTFALL",
    );
    expect(labelOf(topUpRefunded)).toBe("Top-up refunded");
    expect(labelOf(topUpRefundShortfall)).not.toBe(labelOf(topUpRefunded));
  });

  it("signs the amount and carries no internal description", () => {
    expect(walletLedgerRow(memberUnpaid)).toEqual({
      id: "e3",
      deltaPaise: -400_00,
      reason: "OVERAGE_MEMBER_UNPAID",
      paymentId: "pay_parent",
      createdAt: at,
    });
    expect(walletLedgerLineSelect.transaction.select).not.toHaveProperty(
      "description",
    );
  });
});

describe("org analytics wallet activity", () => {
  it("groups by the same reason the Wallet tab shows, so a reversal does not net into its credit", () => {
    const rows = walletActivityByReason([
      booked,
      carvedForMember,
      memberUnpaid,
      memberPaidLate,
      orgSurcharge,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        { reason: "BOOKING", count: 1, deltaPaise: -1000_00 },
        { reason: "OVERAGE_MEMBER_BILLED", count: 2, deltaPaise: 800_00 },
        { reason: "OVERAGE_MEMBER_UNPAID", count: 1, deltaPaise: -400_00 },
        { reason: "OVERAGE_SURCHARGE", count: 1, deltaPaise: -118_00 },
      ]),
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(walletReasonLabel(r.reason)).not.toMatch(/_/);
    }
  });

  it("keeps a top-up refund and its unrecovered part in separate rows", () => {
    expect(
      walletActivityByReason([topUpRefunded, topUpRefundShortfall]),
    ).toEqual([
      { reason: "TOPUP_REFUND", count: 1, deltaPaise: -1000_00 },
      { reason: "TOPUP_REFUND_SHORTFALL", count: 1, deltaPaise: 700_00 },
    ]);
  });
});
