/**
 * @jest-environment node
 */

/**
 * Issue #710: LICENSED_SEAT cap counts engagements (calendar
 * occurrences) per Appointment row, not per checkout.
 *
 * Covers:
 *   - CONSULTATION/WEBINAR debit 1 at checkout
 *   - CLASS debits N at enrolment (one per class day Appointment)
 *   - SUBSCRIPTION skips checkout-time debit (lazy at allocation)
 *   - SUBSCRIPTION lazy debit accumulates engagementsConsumed via upsert
 *   - Cap with BLOCK throws ProgramAssignmentLimitError when exceeded
 *   - Cap with CHARGE_MEMBER / CHARGE_ORG marks wasOverage and continues
 *   - reverseBookingUtilization decrements engagementsUsed by the row's full count
 *
 * Architecture note: the helper does an upsert on `paymentId` (which is
 * @unique on BookingUtilization). For SUBSCRIPTION, the first allocation
 * creates the row; subsequent allocations increment engagementsConsumed
 * by the new delta. Each call always appends a fresh UsageLedgerEntry,
 * so `sum(UsageLedgerEntry.engagementsConsumed) === BookingUtilization.engagementsConsumed`
 * is preserved.
 */

import {
  recordBookingUtilization,
  reverseBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";

type MockTx = {
  programAssignment: {
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
  };
  bookingUtilization: {
    upsert: jest.Mock;
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  usageLedgerEntry: { create: jest.Mock };
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
};

function makeAssignmentLookup(opts: {
  cap: number | null;
  behavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
}) {
  return jest.fn().mockResolvedValue({
    programId: "prog-1",
    membershipId: "mem-1",
    program: {
      licensedSeatConfig: {
        coveredEngagementsPerCycle: opts.cap,
        overageBehavior: opts.behavior,
      },
    },
  });
}

function makeTx(opts: {
  cap: number | null;
  behavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
  blockUpdateRows?: number; // for BLOCK path: rows touched by conditional UPDATE
  chargeReturning?: { engagementsUsed: number }[]; // for CHARGE_* path
}): MockTx {
  return {
    programAssignment: {
      findUniqueOrThrow: makeAssignmentLookup(opts),
      update: jest.fn().mockResolvedValue({}),
    },
    bookingUtilization: {
      upsert: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    usageLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(opts.blockUpdateRows ?? 1),
    $queryRaw: jest.fn().mockResolvedValue(opts.chargeReturning ?? []),
  };
}

describe("recordBookingUtilization — engagement counting (issue #710)", () => {
  it("CONSULTATION/WEBINAR pattern: passes engagementsConsumed=1 cleanly", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 50_000,
    });
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: "pay-1" },
        create: expect.objectContaining({ engagementsConsumed: 1 }),
        update: expect.objectContaining({
          engagementsConsumed: { increment: 1 },
        }),
      }),
    );
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ engagementsConsumed: 1 }),
      }),
    );
  });

  it("CLASS pattern: passes engagementsConsumed = N (count of distinct enrolled appointments)", async () => {
    const tx = makeTx({ cap: 20, behavior: "BLOCK" });
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-class-1",
      engagementsConsumed: 8, // 8-week class
      priceAtBookingPaise: 200_000,
    });
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ engagementsConsumed: 8 }),
      }),
    );
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ engagementsConsumed: 8 }),
      }),
    );
  });

  it("SUBSCRIPTION pattern: incremental upsert — second call increments engagementsConsumed", async () => {
    const tx = makeTx({ cap: null, behavior: "BLOCK" }); // unlimited cap
    // First allocation
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-sub-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 600_000, // full sub price on first call
    });
    // Second allocation
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-sub-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 0, // zero on subsequent
    });
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledTimes(2);
    // Both calls go through upsert; the update branch uses { increment: 1 }
    // so two allocations end at engagementsConsumed = 2 in the DB.
    const calls = tx.bookingUtilization.upsert.mock.calls;
    expect(calls[0][0].update.engagementsConsumed).toEqual({ increment: 1 });
    expect(calls[1][0].update.engagementsConsumed).toEqual({ increment: 1 });
    // The ledger gets a fresh row each call.
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledTimes(2);
  });

  it("BLOCK overage: throws ProgramAssignmentLimitError when conditional UPDATE matches 0 rows", async () => {
    const tx = makeTx({
      cap: 10,
      behavior: "BLOCK",
      blockUpdateRows: 0, // simulating cap exceeded
    });
    await expect(
      recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-overflow",
        engagementsConsumed: 5,
        priceAtBookingPaise: 100_000,
      }),
    ).rejects.toBeInstanceOf(ProgramAssignmentLimitError);
    // Booking utilization must NOT have been upserted on cap rejection.
    expect(tx.bookingUtilization.upsert).not.toHaveBeenCalled();
    expect(tx.usageLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("CHARGE_ORG overage: marks wasOverage=true when post-increment count exceeds cap", async () => {
    const tx = makeTx({
      cap: 10,
      behavior: "CHARGE_ORG",
      chargeReturning: [{ engagementsUsed: 11 }], // post-increment > cap
    });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-overage",
      engagementsConsumed: 1,
      priceAtBookingPaise: 50_000,
    });
    expect(result.wasOverage).toBe(true);
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ wasOverage: true }),
      }),
    );
  });

  it("CHARGE_MEMBER non-overage: wasOverage=false when post-increment fits within cap", async () => {
    const tx = makeTx({
      cap: 10,
      behavior: "CHARGE_MEMBER",
      chargeReturning: [{ engagementsUsed: 7 }],
    });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-fits",
      engagementsConsumed: 2,
      priceAtBookingPaise: 50_000,
    });
    expect(result.wasOverage).toBe(false);
  });
});

describe("reverseBookingUtilization — refund decrements by full row count", () => {
  it("decrements engagementsUsed by util.engagementsConsumed and stamps reversedAt", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8, // CLASS that enrolled 8 sessions
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-class-1",
      reason: "Refund",
    });
    expect(result.reversed).toBe(true);
    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsUsed: { decrement: 8 }, // full reversal
        }),
      }),
    );
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsConsumed: -8, // signed negative reversal entry
        }),
      }),
    );
    expect(tx.bookingUtilization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reversedAt: expect.any(Date) }),
      }),
    );
  });

  it("idempotent: returns reversed=false when reversedAt is already set", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 50_000,
      wasOverage: false,
      reversedAt: new Date(),
      programAssignment: { membershipId: "mem-1" },
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-already-reversed",
    });
    expect(result.reversed).toBe(false);
    expect(tx.programAssignment.update).not.toHaveBeenCalled();
  });

  it("missing utilization row: returns reversed=false (PERSONAL booking that never wrote a util)", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue(null);
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-personal",
    });
    expect(result.reversed).toBe(false);
  });
});
