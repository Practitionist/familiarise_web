/**
 * @jest-environment node
 */

/**
 * SUBSCRIPTION lazy over-cap metering — the gap, and why it is not a one-liner.
 *
 * SUBSCRIPTION is the only event type whose engagements debit at slot
 * allocation (`SchedulingService.recordSubscriptionAllocationCap`) rather than
 * at checkout, because checkout only creates a placeholder appointment
 * (`engagementsForCap` stays null for SUBSCRIPTION by design). So the lazy path
 * is the ONLY caller of `recordBookingUtilization` outside checkout, and it is
 * the only caller that DISCARDS the result: `wasOverage` is computed, persisted
 * on BookingUtilization, `overageCount` is bumped, and nothing reads it.
 *
 * Consequence: over-cap SUBSCRIPTION sessions on a CHARGE_* programme produce
 * no `OverageEvent`, so no `OVERAGE_INVOICE_ACCRUAL` PaymentLeg exists, so the
 * invoice rollup (which only selects payments carrying that leg) never bills
 * the sponsoring org. The overage is metered but unpaid, silently.
 *
 * This file pins THREE things:
 *
 *   1. The signal EXISTS and is correct — `recordBookingUtilization` does
 *      report `wasOverage: true` on the lazy shape. The defect is purely the
 *      discarded return value, not a broken meter.
 *   2. An UNDER-cap lazy allocation correctly reports `wasOverage: false`.
 *   3. Why the obvious fix (forward the result into `recordOverageAtCheckout`,
 *      the canonical recorder) is NOT safe today: the marginal price basis is
 *      undefined on this path. Both candidate inputs are pinned below — `0`
 *      (what follow-on allocations actually pass) makes the recorder a silent
 *      no-op, and the plan price makes it bill the whole plan for one session.
 *      That is a pricing decision (#715-shaped), not a wiring decision, so this
 *      suite deliberately asserts the CURRENT behaviour rather than asserting a
 *      fix that has not been designed yet.
 *
 * See `docs/enterprise/30-programs-and-lifecycle/02-programs.md` (the 🟡 gap
 * note) for the same conclusion in prose.
 */

import { recordBookingUtilization } from "@/lib/api/organizations/program-helpers";
import {
  computeOverageForBooking,
  type OverageContext,
} from "@/lib/payments/billing/overage";

// Both modules under test are pure with respect to the DB client: the helper
// takes `tx` as an argument and the calculator is a pure function. No prisma
// mock is needed, so this suite cannot accidentally assert against a stub.

type MockTx = {
  programAssignment: {
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  bookingUtilization: { upsert: jest.Mock; findUnique: jest.Mock };
  usageLedgerEntry: { create: jest.Mock };
};

/**
 * A CHARGE_ORG LICENSED_SEAT assignment at `cap`, with `used` already on the
 * meter. CHARGE_ORG is the behaviour where the overage is genuinely lost:
 * BLOCK throws inside the helper (so no booking survives) and CHARGE_MEMBER is
 * refused at config time by `overageBehaviorUnsupportedReason` (#1744).
 */
function makeTx(opts: {
  cap: number;
  used: number;
  /** Post-increment `engagementsUsed` the CHARGE_* branch reads back. */
  engagementsUsedAfter: number;
  /** Existing tracked occurrence ids — drives the PR-1e set-diff delta. */
  trackedIds?: string[];
}): MockTx {
  return {
    programAssignment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        programId: "prog-1",
        membershipId: "mem-1",
        engagementsUsed: opts.used,
        consumedPaise: 0,
        program: {
          type: "LICENSED_SEAT",
          licensedSeatConfig: {
            coveredEngagementsPerCycle: opts.cap,
            overageBehavior: "CHARGE_ORG",
          },
          creditPoolConfig: null,
        },
      }),
      // CHARGE_* records the post value from the UPDATE return.
      update: jest
        .fn()
        .mockResolvedValue({ engagementsUsed: opts.engagementsUsedAfter }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingUtilization: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.trackedIds ? { appointmentIds: opts.trackedIds } : null,
        ),
    },
    usageLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe("SUBSCRIPTION lazy debit — the over-cap signal exists but goes unread", () => {
  it("an over-cap allocation DOES report wasOverage=true (the signal is not the bug)", async () => {
    // 10 covered, 10 already used, one more session allocated => crossing.
    const tx = makeTx({ cap: 10, used: 10, engagementsUsedAfter: 11 });

    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-sub",
      paymentId: "pay-sub",
      engagementsConsumed: 1,
      priceAtBookingPaise: 0,
      appointmentIds: ["occ-11"],
    });

    expect(result.wasOverage).toBe(true);
    expect(result.engagementsUsedAfter).toBe(11);
    // The meter also persists the flag — so the row is auditable, it is just
    // never READ by any consumer. Nothing writes an OverageEvent for it.
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ wasOverage: true }),
      }),
    );
    // overageCount is bumped too, which is exactly why the reconcile job's
    // OVERAGE_COUNT_DRIFT check fires on these rows (overageCount advanced with
    // zero OverageEvents behind it).
    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { overageCount: { increment: 1 } },
      }),
    );
  });

  it("an under-cap allocation reports wasOverage=false and leaves overageCount alone", async () => {
    const tx = makeTx({ cap: 10, used: 3, engagementsUsedAfter: 4 });

    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-sub",
      paymentId: "pay-sub",
      engagementsConsumed: 1,
      priceAtBookingPaise: 0,
      appointmentIds: ["occ-4"],
    });

    expect(result.wasOverage).toBe(false);
    expect(tx.programAssignment.update).toHaveBeenCalledTimes(1); // count only
    expect(tx.programAssignment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { overageCount: { increment: 1 } } }),
    );
  });

  it("re-allocating already-counted occurrences is still idempotent (wasOverage=false, no new debit)", async () => {
    // The consultant reschedules: delete + recreate yields the SAME ids, so the
    // set-diff delta is 0. Must not re-flag an overage that already happened.
    const tx = makeTx({
      cap: 10,
      used: 10,
      engagementsUsedAfter: 10,
      trackedIds: ["occ-11"],
    });

    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-sub",
      paymentId: "pay-sub",
      engagementsConsumed: 1,
      priceAtBookingPaise: 0,
      appointmentIds: ["occ-11"],
    });

    expect(result.wasOverage).toBe(false);
    expect(result.engagementsConsumedDelta).toBe(0);
  });
});

describe("why forwarding the result into recordOverageAtCheckout is not yet safe", () => {
  /**
   * The canonical CHARGE_ORG context the lazy path would have to build — same
   * shape checkout and the preview both assemble via `computeOverageForBooking`.
   */
  const ctx: OverageContext = {
    programType: "LICENSED_SEAT",
    overageBehavior: "CHARGE_ORG",
    overageSurchargeBps: null,
    maxOveragePerCyclePaise: null,
    cycleOverageSoFarPaise: 0,
    coveredEngagementsPerCycle: 10,
    // Pre-booking usage: the recorder reconstructs this as
    // engagementsUsedAfter - engagementsConsumedDelta = 11 - 1 = 10.
    engagementsUsed: 10,
    priceCapPerEngagementPaise: null,
  };

  it("basis 0 — what follow-on allocations actually pass — is a silent NO-OP", () => {
    // `SchedulingService` passes `priceAtBookingPaise: 0` for every allocation
    // after the first (`existingUtil ? 0 : orgPayment.amount`), because no new
    // money changes hands at allocation time.
    const r = computeOverageForBooking(ctx, {
      bookingPricePaise: 0,
      engagementsConsumed: 1,
    });

    // `recordOverageAtCheckout` bails at `if (marginalPaise <= 0) return null`
    // before touching OverageEvent or any leg — so wiring it up with this basis
    // would change nothing at all. The money stays unbilled.
    expect(r.marginalPaise).toBe(0);
    expect(r.chargeTo).toBeNull();
  });

  it("basis = plan price — the other candidate — overbills catastrophically", () => {
    // The only other price the lazy path has in hand is the subscription's
    // whole plan price (orgPayment.amount). Feeding that to a SINGLE-session
    // booking bills the org the entire plan for one over-cap session.
    const planPricePaise = 500_000; // ₹5,000 plan

    const r = computeOverageForBooking(ctx, {
      bookingPricePaise: planPricePaise,
      engagementsConsumed: 1,
    });

    // The whole plan, not a per-session share.
    expect(r.marginalPaise).toBe(planPricePaise);
    expect(r.chargeTo).toBe("ORG");
  });

  it("neither basis is the canonical figure — a per-session price must be DECIDED", () => {
    // Documented per-tier outcomes, so the eventual design decision has a
    // pinned baseline to argue against. `priceCapPerEngagementPaise` is the
    // existing config knob that COULD supply a per-session basis, but it is
    // nullable and the schema does not require it.
    const withCap = computeOverageForBooking(
      { ...ctx, priceCapPerEngagementPaise: 100_000 }, // ₹1,000/session
      { bookingPricePaise: 500_000, engagementsConsumed: 1 },
    );
    expect(withCap.marginalPaise).toBe(100_000);

    const withoutCap = computeOverageForBooking(ctx, {
      bookingPricePaise: 500_000,
      engagementsConsumed: 1,
    });
    // With no cap configured there is NO defensible marginal — it falls back to
    // the full plan price. This is the hole the design decision must close.
    expect(withoutCap.marginalPaise).toBe(500_000);
  });
});