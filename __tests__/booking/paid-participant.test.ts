/**
 * @jest-environment node
 */

/**
 * `paidParticipant` is the predicate a group-event room uses to admit a seat.
 * It admits a fulfilled entitlement and nothing merely held, rejected or owed back.
 */

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  PAID_PARTICIPANT_STATUSES,
  liveParticipant,
  paidParticipant,
} from "@/lib/booking/participants";
import {
  MANUAL_RECOVERY_PREFIX,
  autoRefundPendingDescription,
  settledAutoRefundDescription,
  stuckAutoRefundDescription,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { matchesWhere, type Row, type Where } from "../fixtures/mem-db";

const pay = (over: Row = {}): Row => ({
  paymentStatus: "SUCCEEDED",
  paymentMethod: "CARD",
  description: null,
  refundOwedKey: null,
  refunds: [],
  ...over,
});
const seat = (status: string, payment: Row | null, userId = "u1"): Row => ({
  userId,
  status,
  paymentId: payment ? "pay1" : null,
  payment,
});
const admits = (row: Row) => matchesWhere(row, paidParticipant("u1") as Where);

const mismatch = autoRefundPendingDescription(
  "capture amount 9999p ≠ expected 10000p",
);

describe("paidParticipant", () => {
  it.each<[string, Row]>([
    ["a confirmed card seat", seat("CONFIRMED", pay())],
    ["an attended seat", seat("ATTENDED", pay())],
    [
      "a confirmed seat with no payment (re-seated or host-seated)",
      seat("CONFIRMED", null),
    ],
    ...(["WALLET", "INVOICE", "LICENSE", "CREDITS"] as const).map(
      (rail): [string, Row] => [
        `a ${rail} no-gateway seat`,
        seat("CONFIRMED", pay({ paymentMethod: rail, isMockPayment: true })),
      ],
    ),
    [
      "a seat the recovery door confirmed (its marker stays on the payment)",
      seat(
        "CONFIRMED",
        pay({
          description: `${MANUAL_RECOVERY_PREFIX} Metadata validation failed`,
        }),
      ),
    ],
    [
      "a confirmed class seat owed one incident session back",
      seat(
        "CONFIRMED",
        pay({
          refundOwedKey: "incident:i1:o1:u1",
          refunds: [{ status: "SUCCEEDED" }],
        }),
      ),
    ],
    [
      "a held seat whose capture settled and awaits confirmation",
      seat("HELD", pay()),
    ],
    [
      "a held seat whose only refund attempt failed",
      seat("HELD", pay({ refunds: [{ status: "FAILED" }] })),
    ],
  ])("admits %s", (_label, row) => {
    expect(admits(row)).toBe(true);
  });

  it.each<[string, Row]>([
    [
      "a confirmed seat whose payment FAILED",
      seat("CONFIRMED", pay({ paymentStatus: "FAILED" })),
    ],
    [
      "a confirmed seat whose payment EXPIRED",
      seat("CONFIRMED", pay({ paymentStatus: "EXPIRED" })),
    ],
    [
      "a confirmed seat whose payment is PENDING",
      seat("CONFIRMED", pay({ paymentStatus: "PENDING" })),
    ],
    [
      "a held seat on an uncaptured payment",
      seat("HELD", pay({ paymentStatus: "PENDING" })),
    ],
    ["a held seat with no payment", seat("HELD", null)],
    [
      "a held seat whose capture is under auto-refund",
      seat("HELD", pay({ description: mismatch })),
    ],
    [
      "a held seat whose capture was auto-refunded",
      seat(
        "HELD",
        pay({ description: settledAutoRefundDescription(mismatch) }),
      ),
    ],
    [
      "a held seat whose auto-refund is stuck",
      seat("HELD", pay({ description: stuckAutoRefundDescription(mismatch) })),
    ],
    [
      "a held seat awaiting manual recovery",
      seat(
        "HELD",
        pay({
          description: `${MANUAL_RECOVERY_PREFIX} Metadata validation failed`,
        }),
      ),
    ],
    [
      "a held seat whose payment owes a refund",
      seat("HELD", pay({ refundOwedKey: "seat-leave:pay1" })),
    ],
    [
      "a held seat with a refund in flight",
      seat("HELD", pay({ refunds: [{ status: "PENDING" }] })),
    ],
    ["a released seat", seat("CANCELLED", pay())],
    ["another user's seat", seat("CONFIRMED", pay(), "u2")],
  ])("denies %s", (_label, row) => {
    expect(admits(row)).toBe(false);
  });

  it("is narrower than the live roster and never lists a bare HELD status", () => {
    expect(PAID_PARTICIPANT_STATUSES).not.toContain("HELD");
    expect(liveParticipant().status).toEqual({
      in: ["HELD", "CONFIRMED", "ATTENDED"],
    });
    expect(paidParticipant()).not.toHaveProperty("userId");
  });
});
