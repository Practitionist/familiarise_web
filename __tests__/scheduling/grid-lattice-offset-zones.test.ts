/**
 * Every grid cell starts on the absolute UTC half-hour lattice, whatever the
 * viewer's offset: a :45 viewer (Kathmandu, Eucla) whose midnight falls inside
 * a published block keeps every atom, keyed by the viewer day it starts on.
 */
import {
  processAvailabilitySlots,
  type WeeklySlot,
} from "../../utils/scheduling-engine/intervals";

const ATOM_MS = 30 * 60_000;

// New York Saturday 7 Nov 2026, 09:00–17:00 EST = 14:00–22:00Z.
const newYorkSaturday: WeeklySlot = {
  id: "row-ny-sat",
  timezone: "America/New_York",
  localStartDay: "SATURDAY",
  localStartMinutes: 9 * 60,
  localEndMinutes: 17 * 60,
  localEndDay: "SATURDAY",
};
const rangeStart = new Date("2026-11-06T00:00:00.000Z");
const rangeEnd = new Date("2026-11-09T00:00:00.000Z");

const cellsFor = (zone: string) =>
  processAvailabilitySlots(
    [newYorkSaturday],
    [],
    [],
    rangeStart,
    rangeEnd,
    zone,
  );

describe.each(["Asia/Kathmandu", "Australia/Eucla", "Asia/Kolkata"])(
  "a %s viewer of a New York expert",
  (zone) => {
    it("gets all 16 atoms of the block, each on the UTC lattice", () => {
      const starts = Object.values(cellsFor(zone))
        .flat()
        .map((c) => new Date(c.startsAt).getTime());
      expect(starts).toHaveLength(16);
      for (const ms of starts) expect(ms % ATOM_MS).toBe(0);
      expect(starts).toContain(Date.parse("2026-11-07T18:00:00.000Z"));
      expect(starts[0]).toBe(Date.parse("2026-11-07T14:00:00.000Z"));
    });
  },
);

it("keys each atom by the viewer day its own start falls on", () => {
  const byDay = cellsFor("Asia/Kathmandu");
  // Kathmandu midnight is 18:15Z: 14:00–18:00Z starts are Saturday, 18:30Z on Sunday.
  const saturday = byDay["2026-11-07"]?.map((c) => c.startsAt) ?? [];
  const sunday = byDay["2026-11-08"]?.map((c) => c.startsAt) ?? [];
  expect(saturday.at(-1)).toBe("2026-11-07T18:00:00.000Z");
  expect(sunday[0]).toBe("2026-11-07T18:30:00.000Z");
  expect(byDay["2026-11-08"]?.[0]?.dayOfWeek).toBe("SUNDAY");
});
