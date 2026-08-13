/**
 * #1169 PR 1 — trial slot integrity + interval-granular locking.
 *
 * Three contracts, each of which has silently failed before:
 * 1. slotAtomStarts makes OVERLAPPING intervals share lock keys even when
 *    their start instants differ (the double-charge shape: 10:00–12:00 vs
 *    11:00–12:00).
 * 2. The trial route writes consultantProfileId on its slot (without it the
 *    slot escapes the slot_no_confirmed_overlap exclusion constraint, #1093
 *    §1) and locks under the SHARED slot-booking namespace (the retired
 *    trial-slot-booking namespace contended with nothing).
 * 3. Capacity reads whose query forgot the user include throw loudly instead
 *    of silently counting zero registrants for a sold-out event.
 */

import fs from "fs";
import path from "path";

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: jest.fn(async (fn: () => unknown) => fn()),
  checkRedisHealth: jest.fn(async () => true),
}));

import { slotAtomStarts } from "../../utils/appointmentlock";
import { getWebinarCapacity, getClassCapacity } from "../../lib/events/capacity";

describe("slotAtomStarts — interval → 30-minute atom keys", () => {
  const at = (iso: string) => new Date(iso);

  it("covers an aligned interval with one atom per half hour", () => {
    const atoms = slotAtomStarts(
      at("2026-09-01T10:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    );
    expect(atoms.map((a) => a.toISOString())).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:30:00.000Z",
      "2026-09-01T11:00:00.000Z",
      "2026-09-01T11:30:00.000Z",
    ]);
  });

  it("makes overlapping intervals with different starts share atoms", () => {
    const a = slotAtomStarts(
      at("2026-09-01T10:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    ).map((d) => d.toISOString());
    const b = slotAtomStarts(
      at("2026-09-01T11:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    ).map((d) => d.toISOString());
    const shared = b.filter((atom) => a.includes(atom));
    expect(shared).toEqual([
      "2026-09-01T11:00:00.000Z",
      "2026-09-01T11:30:00.000Z",
    ]);
  });

  it("floors an unaligned start to the half-hour grid so it still collides", () => {
    const atoms = slotAtomStarts(
      at("2026-09-01T10:10:00.000Z"),
      at("2026-09-01T10:40:00.000Z"),
    ).map((d) => d.toISOString());
    expect(atoms).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:30:00.000Z",
    ]);
  });

  it("returns no atoms for an empty interval", () => {
    const t = at("2026-09-01T10:00:00.000Z");
    expect(slotAtomStarts(t, t)).toHaveLength(0);
  });
});

describe("trial route source contract (#1093 §1)", () => {
  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/trials/[trialId]/route.ts"),
    "utf8",
  );

  it("stamps consultantProfileId on the trial slot create", () => {
    // The line only exists inside the slot-create block, so a whole-file
    // containment check is exact enough.
    expect(routeSource).toContain(
      "consultantProfileId: existingTrial.consultantProfileId",
    );
  });

  it("locks under the shared slot-booking namespace, not a trial-only one", () => {
    expect(routeSource).toContain("lockSlotBooking");
    expect(routeSource).not.toContain("trial-slot-booking");
    expect(routeSource).not.toContain("lockTrialSlot");
  });

  it("validates availability on the transaction client, not the global one", () => {
    expect(routeSource).toContain("db: Tx");
    expect(routeSource).toMatch(/validateSlotAvailability\(\s*tx,/);
  });
});

describe("lock module source contract", () => {
  const lockSource = fs.readFileSync(
    path.join(process.cwd(), "utils/appointmentlock.ts"),
    "utf8",
  );

  it("has retired the trial-slot-booking namespace entirely", () => {
    // Key CONSTRUCTION is what must be gone; the tombstone comment may still
    // name the namespace.
    expect(lockSource).not.toContain("`trial-slot-booking:${");
    expect(lockSource).not.toContain("export async function lockTrialSlot");
  });
});

describe("capacity include-trap (#676 CN-4)", () => {
  const plan = { maxParticipants: 10 };

  it("throws when webinar slots were loaded without the user relation", () => {
    expect(() =>
      getWebinarCapacity({
        webinar: {
          maxParticipants: null,
          appointment: { slotsOfAppointment: [{ startsAt: "x" }] },
        },
        plan,
      }),
    ).toThrow(/user was not included/);
  });

  it("counts normally when the user relation is present", () => {
    const capacity = getWebinarCapacity({
      webinar: {
        maxParticipants: null,
        appointment: {
          slotsOfAppointment: [
            { user: [{ id: "u1" }, { id: "u2" }] },
            { user: [{ id: "u1" }] },
          ],
        },
      },
      plan,
    });
    expect(capacity.registered).toBe(2);
    expect(capacity.remaining).toBe(8);
    expect(capacity.isFull).toBe(false);
  });

  it("throws for class capacity with a missing user relation on any session", () => {
    expect(() =>
      getClassCapacity({
        classInstance: {
          maxParticipants: 1,
          appointments: [
            { slotsOfAppointment: [{ user: [{ id: "u1" }] }] },
            { slotsOfAppointment: [{ notUser: true }] },
          ],
        },
        plan,
      }),
    ).toThrow(/user was not included/);
  });
});
