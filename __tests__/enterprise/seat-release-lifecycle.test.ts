/**
 * @jest-environment node
 */

/**
 * E2E-audit P1 — billed seats must be released when a MEMBER's lifecycle
 * ends, not only when an assignment is individually cancelled.
 *
 * `BillingSubscription.activeSeatCount` is what the subscription-invoice cron
 * multiplies by `ratePerSeatPaise` on a PER_SEAT contract. The per-assignment
 * cancel routes already decremented it, but the four MEMBER-level cascades —
 * DELETE removal, PATCH → REMOVED, SCIM deprovision, DPDP erasure — stamped
 * the member's ProgramAssignments CANCELLED without touching the count. A
 * deprovisioned member therefore stayed billable forever.
 *
 * `releaseSeatsForTerminatedAssignments` is the shared helper those four
 * cascades now call. It runs AFTER the assignments are stamped, so it selects
 * on `status: CANCELLED` and an unexpired period.
 */

import type { Tx } from "@/lib/prisma";
import {
  releaseSeatsForTerminatedAssignments,
  releaseSeatsForClosedAssignments,
  adjustActiveSeatCount,
  SeatCountUnderflowError,
} from "@/lib/api/organizations/seat-count";

const CLOSED_AT = new Date("2026-09-20T10:00:00.000Z");

type ProgramRow = {
  type: string;
  contract: {
    subscription: { id: string; activeSeatCount: number } | null;
  };
};

/**
 * Minimal transaction double. `programAssignment.findMany` returns whatever
 * the test stages; `program.findUnique` resolves the program → subscription
 * chain; `billingSubscription.updateMany` models the underflow-guarded
 * conditional decrement (0 rows matched === guard tripped).
 */
function makeTx(opts: {
  assignments: Array<{ programId: string }>;
  programs: Record<string, ProgramRow>;
  seatCounts?: Record<string, number>;
}) {
  const counts: Record<string, number> = { ...(opts.seatCounts ?? {}) };

  type SeatUpdateArgs = {
    where: { id: string; activeSeatCount?: { gte: number } };
    data: { activeSeatCount: { increment: number } };
  };
  type ByIdArgs = { where: { id: string } };

  const updateMany = jest.fn(async ({ where, data }: SeatUpdateArgs) => {
    const current = counts[where.id] ?? 0;
    const min = where.activeSeatCount?.gte ?? 0;
    if (current < min) return { count: 0 };
    counts[where.id] = current + data.activeSeatCount.increment;
    return { count: 1 };
  });
  const update = jest.fn(async ({ where, data }: SeatUpdateArgs) => {
    counts[where.id] = (counts[where.id] ?? 0) + data.activeSeatCount.increment;
    return {};
  });
  const findUnique = jest.fn(
    async ({ where }: ByIdArgs) => opts.programs[where.id] ?? null,
  );
  const findMany = jest.fn().mockResolvedValue(opts.assignments);

  // The helper only ever touches these three delegates, so a structural
  // double is enough; `Tx` itself is the full Prisma transaction client.
  const tx = {
    programAssignment: { findMany },
    program: { findUnique },
    billingSubscription: {
      updateMany,
      update,
      findUniqueOrThrow: jest.fn(async ({ where }: ByIdArgs) => ({
        activeSeatCount: counts[where.id] ?? 0,
      })),
    },
  };

  return {
    counts,
    tx: tx as unknown as Tx,
    findMany,
    findUnique,
    updateMany,
    update,
  };
}

const licensedProgram = (subId: string, seats: number): ProgramRow => ({
  type: "LICENSED_SEAT",
  contract: { subscription: { id: subId, activeSeatCount: seats } },
});

describe("releaseSeatsForTerminatedAssignments", () => {
  it("releases one seat per distinct licensed program", async () => {
    const { tx, counts } = makeTx({
      assignments: [{ programId: "prog-a" }, { programId: "prog-b" }],
      programs: {
        "prog-a": licensedProgram("sub-1", 5),
        "prog-b": licensedProgram("sub-2", 3),
      },
      seatCounts: { "sub-1": 5, "sub-2": 3 },
    });

    const released = await releaseSeatsForTerminatedAssignments(
      tx,
      ["mem-1"],
      CLOSED_AT,
    );

    expect(released).toBe(2);
    expect(counts["sub-1"]).toBe(4);
    expect(counts["sub-2"]).toBe(2);
  });

  it("dedupes: two assignments on the same program release one seat", async () => {
    // A member can hold several assignments against one seat-pool program
    // across periods; the seat is one seat.
    const { tx, counts } = makeTx({
      assignments: [{ programId: "prog-a" }, { programId: "prog-a" }],
      programs: { "prog-a": licensedProgram("sub-1", 5) },
      seatCounts: { "sub-1": 5 },
    });

    const released = await releaseSeatsForTerminatedAssignments(
      tx,
      ["mem-1"],
      CLOSED_AT,
    );

    expect(released).toBe(1);
    expect(counts["sub-1"]).toBe(4);
  });

  it("selects only the CANCELLED assignments the caller just closed", async () => {
    const { tx, findMany } = makeTx({ assignments: [], programs: {} });

    await releaseSeatsForTerminatedAssignments(
      tx,
      ["mem-1", "mem-2"],
      CLOSED_AT,
    );

    const [args] = findMany.mock.calls[0];
    expect(args.where.status).toBe("CANCELLED");
    expect(args.where.membershipId).toEqual({ in: ["mem-1", "mem-2"] });
    // #1744 row 4 — the caller's own `periodEnd` stamp, exactly: `gte: new
    // Date()` taken a few ms later matched nothing and released no seat.
    expect(args.where.periodEnd).toBe(CLOSED_AT);
  });

  it("is a no-op for an empty membership list (no query at all)", async () => {
    const { tx, findMany } = makeTx({ assignments: [], programs: {} });

    expect(await releaseSeatsForTerminatedAssignments(tx, [], CLOSED_AT)).toBe(
      0,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("no-ops on non-LICENSED_SEAT programs and unlicensed contracts", async () => {
    const { tx, updateMany, update } = makeTx({
      assignments: [{ programId: "prog-credit" }, { programId: "prog-nosub" }],
      programs: {
        "prog-credit": {
          type: "CREDIT_POOL",
          contract: { subscription: { id: "sub-x", activeSeatCount: 9 } },
        },
        "prog-nosub": {
          type: "LICENSED_SEAT",
          contract: { subscription: null },
        },
      },
    });

    // The helper still counts them as visited programs, but no seat moves.
    await releaseSeatsForTerminatedAssignments(tx, ["mem-1"], CLOSED_AT);

    expect(updateMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("swallows a lost underflow race instead of failing the whole cascade", async () => {
    // Two concurrent releases against a count of 1: one wins, one trips the
    // guard. The count is already correct, so the loser must not abort the
    // member-removal transaction it is riding inside.
    const { tx } = makeTx({
      assignments: [{ programId: "prog-a" }],
      programs: { "prog-a": licensedProgram("sub-1", 0) },
      seatCounts: { "sub-1": 0 },
    });

    await expect(
      releaseSeatsForTerminatedAssignments(tx, ["mem-1"], CLOSED_AT),
    ).resolves.toBe(1);
  });
});

// #1744 rows 3/4 + W5 — the three `updateMany` close sites (program cancel
// cascade, cycle CLOSE, contract expiry) all hand their closed count to one
// helper; two closed assignments free two seats at each of them.
describe("releaseSeatsForClosedAssignments", () => {
  it.each([
    ["program cancel cascade", 2],
    ["cycle CLOSE (one per claimed row, twice)", 1],
    ["contract expiry", 2],
  ])("%s: closing 2 assignments frees 2 seats", async (_site, perCall) => {
    const { tx, counts } = makeTx({
      assignments: [],
      programs: { "prog-a": licensedProgram("sub-1", 5) },
      seatCounts: { "sub-1": 5 },
    });

    let released = 0;
    for (let closed = 0; closed < 2; closed += perCall) {
      released += await releaseSeatsForClosedAssignments(tx, "prog-a", perCall);
    }

    expect(released).toBe(2);
    expect(counts["sub-1"]).toBe(3);
  });

  it("clamps at zero when the count had already drifted low", async () => {
    const { tx, counts } = makeTx({
      assignments: [],
      programs: { "prog-a": licensedProgram("sub-1", 1) },
      seatCounts: { "sub-1": 1 },
    });
    // The underflow re-read goes through findUnique on the subscription.
    (
      tx as unknown as { billingSubscription: Record<string, unknown> }
    ).billingSubscription.findUnique = jest.fn(async () => ({
      activeSeatCount: counts["sub-1"],
    }));

    expect(await releaseSeatsForClosedAssignments(tx, "prog-a", 3)).toBe(1);
    expect(counts["sub-1"]).toBe(0);
  });
});

describe("adjustActiveSeatCount", () => {
  it("throws SeatCountUnderflowError when the guard refuses a decrement", async () => {
    // Direct callers (the per-assignment cancel routes) still see the error —
    // only the member-cascade helper swallows it.
    const { tx } = makeTx({
      assignments: [],
      programs: { "prog-a": licensedProgram("sub-1", 0) },
      seatCounts: { "sub-1": 0 },
    });

    await expect(
      adjustActiveSeatCount(tx, { programId: "prog-a", delta: -1 }),
    ).rejects.toBeInstanceOf(SeatCountUnderflowError);
  });

  it("increments without a guard (two racing +1s both land)", async () => {
    const { tx, counts } = makeTx({
      assignments: [],
      programs: { "prog-a": licensedProgram("sub-1", 2) },
      seatCounts: { "sub-1": 2 },
    });

    const res = await adjustActiveSeatCount(tx, {
      programId: "prog-a",
      delta: 1,
    });

    expect(res).toEqual({ applied: true, balanceAfter: 3 });
    expect(counts["sub-1"]).toBe(3);
  });

  it("treats a zero delta as a no-op", async () => {
    const { tx, findUnique } = makeTx({ assignments: [], programs: {} });
    expect(
      await adjustActiveSeatCount(tx, { programId: "prog-a", delta: 0 }),
    ).toEqual({ applied: false, balanceAfter: null });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
