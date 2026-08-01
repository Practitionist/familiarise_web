/**
 * #1071 — contiguous N×30min slot runs for planner create/update.
 */

import "./setup";

import {
  assertSingleContiguousLiveRun,
  buildContiguousSlotAtoms,
  SLOT_DURATION_MS,
} from "@/lib/appointments/contiguous-slot-run";

describe("buildContiguousSlotAtoms", () => {
  const startsAt = new Date("2026-08-10T10:00:00.000Z");

  it("creates one atom for a 30-minute session", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 0.5,
      consultantProfileId: "cp_1",
    });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].startsAt.toISOString()).toBe("2026-08-10T10:00:00.000Z");
    expect(atoms[0].endsAt.toISOString()).toBe("2026-08-10T10:30:00.000Z");
  });

  it("creates four contiguous atoms for a 2-hour session", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 2,
      consultantProfileId: "cp_1",
      isTentative: false,
    });
    expect(atoms).toHaveLength(4);
    for (let i = 0; i < atoms.length; i++) {
      const expectedStart = startsAt.getTime() + i * SLOT_DURATION_MS;
      expect(atoms[i].startsAt.getTime()).toBe(expectedStart);
      expect(atoms[i].endsAt.getTime()).toBe(expectedStart + SLOT_DURATION_MS);
      if (i > 0) {
        expect(atoms[i].startsAt.getTime()).toBe(atoms[i - 1].endsAt.getTime());
      }
    }
  });

  it("creates two atoms for a 60-minute session (allocator parity)", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 1,
      consultantProfileId: "cp_1",
    });
    expect(atoms).toHaveLength(2);
    expect(atoms[1].endsAt.getTime() - atoms[0].startsAt.getTime()).toBe(
      60 * 60 * 1000,
    );
  });

  it("attaches user connects when userIds are provided", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 1,
      consultantProfileId: "cp_1",
      userIds: ["u1", "u2", "u1"],
    });
    expect(atoms[0].user?.connect).toEqual([{ id: "u1" }, { id: "u2" }]);
  });

  it("rejects non-positive duration", () => {
    expect(() =>
      buildContiguousSlotAtoms({
        startsAt,
        durationInHours: 0,
        consultantProfileId: "cp_1",
      }),
    ).toThrow(/durationInHours/);
  });
});

describe("assertSingleContiguousLiveRun", () => {
  it("accepts a contiguous 2-hour run", () => {
    const startsAt = new Date("2026-08-10T10:00:00.000Z");
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 2,
      consultantProfileId: "cp_1",
    });
    expect(() =>
      assertSingleContiguousLiveRun(
        atoms.map((a, i) => ({
          id: `s${i}`,
          appointmentId: "a1",
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          isTentative: false,
          completionStatus: "SCHEDULED",
        })),
      ),
    ).not.toThrow();
  });

  it("rejects the old #1071 failure mode (first atom moved, rest stranded)", () => {
    expect(() =>
      assertSingleContiguousLiveRun([
        {
          id: "s0",
          appointmentId: "a1",
          startsAt: new Date("2026-08-14T10:00:00.000Z"),
          endsAt: new Date("2026-08-14T10:30:00.000Z"),
          completionStatus: "SCHEDULED",
        },
        {
          id: "s1",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T10:30:00.000Z"),
          endsAt: new Date("2026-08-10T11:00:00.000Z"),
          completionStatus: "SCHEDULED",
        },
        {
          id: "s2",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T11:00:00.000Z"),
          endsAt: new Date("2026-08-10T11:30:00.000Z"),
          completionStatus: "SCHEDULED",
        },
      ]),
    ).toThrow(/exactly one contiguous run/);
  });

  it("ignores CANCELLED / RESCHEDULED rows when checking contiguity", () => {
    expect(() =>
      assertSingleContiguousLiveRun([
        {
          id: "dead",
          appointmentId: "a1",
          startsAt: new Date("2026-08-01T10:00:00.000Z"),
          endsAt: new Date("2026-08-01T10:30:00.000Z"),
          completionStatus: "RESCHEDULED",
        },
        {
          id: "s0",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T10:00:00.000Z"),
          endsAt: new Date("2026-08-10T10:30:00.000Z"),
          completionStatus: "SCHEDULED",
        },
        {
          id: "s1",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T10:30:00.000Z"),
          endsAt: new Date("2026-08-10T11:00:00.000Z"),
          completionStatus: "SCHEDULED",
        },
      ]),
    ).not.toThrow();
  });
});
