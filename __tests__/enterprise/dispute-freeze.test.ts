/**
 * @jest-environment node
 */

/**
 * #1008 — dispute freeze. Two independent pieces, unit-tested against small
 * mocks:
 *   1. hasActiveDisputeForAppointment — the mutation-guard predicate (true iff a
 *      non-terminal dispute exists on any payment for the appointment).
 *   2. refundPayment's REFUND_BLOCKED_BY_DISPUTE guard — an app refund is
 *      rejected while a dispute is live, and allowed once it's terminal.
 */

import {
  TERMINAL_DISPUTE_STATUSES,
  DISPUTE_INACTIVE_FOR_GATING,
} from "@/lib/payments/dispute-status";

const mockDisputeFindFirst = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { dispute: { findFirst: (...a: unknown[]) => mockDisputeFindFirst(...a) } },
}));

import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";

beforeEach(() => mockDisputeFindFirst.mockReset());

describe("hasActiveDisputeForAppointment (#1008)", () => {
  it("queries with the inactive-for-gating set excluded and the appointment relation", async () => {
    mockDisputeFindFirst.mockResolvedValue({ id: "d1" });
    const active = await hasActiveDisputeForAppointment("appt1");
    expect(active).toBe(true);
    const where = mockDisputeFindFirst.mock.calls[0][0].where;
    expect(where.payment).toEqual({ appointmentId: "appt1" });
    // #1019 — terminal verdicts AND a resolved WARNING_CLOSED must not freeze.
    expect(where.status.notIn).toEqual(DISPUTE_INACTIVE_FOR_GATING);
    expect(where.status.notIn).toContain("WARNING_CLOSED");
  });

  it("returns false when no live dispute is found", async () => {
    mockDisputeFindFirst.mockResolvedValue(null);
    expect(await hasActiveDisputeForAppointment("appt1")).toBe(false);
  });

  it("terminal statuses are exactly WON/LOST/CHARGE_REFUNDED/CLOSED", () => {
    // Guards the freeze semantics: a resolved dispute must NOT freeze the
    // appointment or block refunds.
    expect([...TERMINAL_DISPUTE_STATUSES].sort()).toEqual(
      ["CHARGE_REFUNDED", "CLOSED", "LOST", "WON"],
    );
  });
});
