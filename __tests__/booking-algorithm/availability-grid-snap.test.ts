/**
 * @jest-environment node
 */

/**
 * The client half of the availability-grid defect.
 *
 * The server refuses a published window whose boundaries are not on the
 * 30-minute booking grid (`lib/scheduling/availability-contract`, code GRID),
 * because the grid generator and the allocator step 30 minutes FROM THE ROW'S
 * OWN START and `slotStartRefusal` then answers SLOT_NOT_ON_GRID for every mint
 * they produce. Availability is published in LOCAL time and converted to UTC on
 * the way out, so in a zone whose offset is not a whole number of 30 minutes the
 * consultant's round hour lands on :15 or :45 in UTC and their whole calendar
 * becomes 100% unbookable — silently, before this work.
 *
 * The other half of the same decision: the server refuses, the client snaps.
 * These pins are about the answer the client gives, and about the two
 * properties that make it acceptable to a consultant — it never moves an hour
 * EARLIER than they typed, and it never changes how long their session is.
 */

import "../booking-algorithm/setup";
import {
  validateCustomWindow,
  validateWeeklyWindow,
} from "../../lib/scheduling/availability-contract";
import {
  buildCustomSlotsForSave,
  buildWeeklySlotsForSave,
  formatSlotsForApi,
  gridSnapDeltaMs,
  normaliseSlotToSchedulingGrid,
  snapInstantsToSchedulingGrid,
  weeklySlotForSave,
  type WeeklySlotApiFormat,
} from "../../utils/schedule/formatting";
import type { SlotType, SlotsType } from "../../utils/schedule/types";

const IST = "Asia/Kolkata"; // +05:30, a whole number of 30-minute atoms
const NPT = "Asia/Kathmandu"; // +05:45, carrying a 15-minute remainder
const HALF_HOUR = 30 * 60 * 1000;
const NOW = new Date("2026-09-01T00:00:00Z");

const row = (startTime: string, endTime: string) => ({
  startTime,
  endTime,
  isValid: true,
});
const day = (rows: SlotType[]): SlotsType => ({ monday: rows });

/** Minutes since midnight UTC, the way the server reads a published row. */
const utcMinute = (iso: string) => {
  const at = new Date(iso);
  return at.getUTCHours() * 60 + at.getUTCMinutes();
};
const onGrid = (iso: string) => new Date(iso).getTime() % HALF_HOUR === 0;
const ms = (iso: string) => new Date(iso).getTime();

/** A Monday weekly row, converted exactly as every save path converts it. */
const save = (startTime: string, endTime: string, timezone: string) =>
  weeklySlotForSave({ startTime, endTime }, "monday", timezone);

/** The contract's own answer for a built row, not a restatement of it. */
const accepts = (built: ReturnType<typeof save>) =>
  validateWeeklyWindow({
    startDay: built.startDay,
    endDay: built.endDay,
    startTimeUtc: built.startTimeUtc,
    endTimeUtc: built.endTimeUtc,
  });

// ─── 1. The snap itself ─────────────────────────────────────────────────────

describe("the snap is the smallest forward move onto the grid", () => {
  it("is zero for an instant that is already aligned", () => {
    const aligned = [
      "2026-09-20T00:00:00.000Z",
      "2026-09-20T09:30:00.000Z",
      "2026-09-20T23:00:00.000Z",
    ];
    for (const iso of aligned) {
      expect(gridSnapDeltaMs(ms(iso))).toBe(0);
    }
  });

  it("never returns a negative delta, in any era", () => {
    // A weekly row is carried through the 1970 epoch, so a naive `ms % GRID` is
    // NEGATIVE for every IST row starting before 05:30 local — and a negative
    // snap would move those rows backwards in time.
    const offsets = [0, 1, 29, 30, 44, HALF_HOUR - 1, -1, -15 * 60_000];
    for (const start of offsets) {
      const delta = gridSnapDeltaMs(start);
      expect(delta).toBeGreaterThanOrEqual(0);
      expect((start + delta) % HALF_HOUR).toBe(0);
    }
  });

  it("moves a half-atom start by one half-atom, not by two", () => {
    // 03:15Z → 03:30Z. Rounding to the nearest would need a tie-break on
    // precisely this residue, which is the only one a real zone produces.
    const halfAtom = ms("2026-09-20T03:15:00.000Z");
    expect(gridSnapDeltaMs(halfAtom)).toBe(15 * 60_000);
  });
});

describe("one shared shift, so the typed duration survives", () => {
  const start = ms("2026-09-20T03:15:00.000Z");
  const end = ms("2026-09-20T04:15:00.000Z");

  it("carries the end by the same delta as the start", () => {
    const snapped = snapInstantsToSchedulingGrid(start, end);
    expect(snapped.deltaMs).toBe(15 * 60_000);
    expect(snapped.endsAtMs - snapped.startsAtMs).toBe(end - start);
  });

  it("is what makes both ends legal, not just the start", () => {
    // The server's duration rule is only [30, 720] minutes; the "whole number of
    // 30-minute atoms" requirement arrives only as a GRID refusal of endsAt,
    // and an end of 04:15Z is exactly that refusal.
    const offGridEnd = {
      startDay: "MONDAY",
      endDay: "MONDAY",
      startTimeUtc: 195,
      endTimeUtc: 255,
    } as Parameters<typeof validateWeeklyWindow>[0];
    expect(validateWeeklyWindow(offGridEnd)?.code).toBe("GRID");
  });
});

// ─── 2. The arithmetic, in both offsets ─────────────────────────────────────

describe("a :30 offset — Asia/Kolkata, the launch market", () => {
  // Offset +330, and 330 % 30 === 0, so the consultant's local lattice IS the
  // grid: a legal local minute L maps to UTC minute L - 330, and subtracting a
  // multiple of 30 cannot change L % 30. Round hours need no movement at all.
  it("publishes a round hour untouched", () => {
    const built = save("09:00", "17:00", IST);
    expect(utcMinute(built.startsAtUtc)).toBe(210); // 540 - 330 = 03:30Z
    expect(utcMinute(built.endsAtUtc)).toBe(690); // 17:30Z
    expect(accepts(built)).toBeNull();
  });

  it("moves a :15 wall clock forward to the half hour, not back", () => {
    // 615 - 330 = 285, and 285 % 30 === 15. Ceiling gives 300 (05:00Z), which
    // is 10:30 local. Flooring would give 270 — 09:30 local, half an hour of
    // availability the consultant never said they had.
    const built = save("10:15", "11:45", IST);
    expect(utcMinute(built.startsAtUtc)).toBe(300);
    expect(utcMinute(built.endsAtUtc)).toBe(405);
    expect(built.endTimeUtc - built.startTimeUtc).toBe(90);
    expect(accepts(built)).toBeNull();
  });
});

describe("a :45 offset — Asia/Kathmandu, the brief's example", () => {
  // Offset +345, and 345 % 30 === 15, so the local lattice is shifted off
  // :00/:30: a local minute L is publishable only when L % 30 === 15, i.e. the
  // :15 and :45 values. A consultant's 09:00 is therefore structurally
  // unpublishable and has to move; 09:15 is the first value that maps on.
  it("moves 09:00 to 09:15 and keeps the session the same length", () => {
    const built = save("09:00", "10:00", NPT);
    // 540 - 345 = 195 (03:15Z), half an atom off → 210 (03:30Z) = 09:15 local.
    expect(utcMinute(built.startsAtUtc)).toBe(210);
    expect(utcMinute(built.endsAtUtc)).toBe(270);
    expect(built.endTimeUtc - built.startTimeUtc).toBe(60);
    expect(accepts(built)).toBeNull();
  });

  it("leaves a :15 wall clock alone — that lattice starts at :15", () => {
    const built = save("10:15", "11:45", NPT);
    expect(utcMinute(built.startsAtUtc)).toBe(270); // 04:30Z
    expect(utcMinute(built.endsAtUtc)).toBe(360); // 06:00Z
    expect(built.endTimeUtc - built.startTimeUtc).toBe(90);
    expect(accepts(built)).toBeNull();
  });

  it("is why no fixed picker step can also be the publishing step", () => {
    // The publishable local values are :15/:45 in a :45 zone and :00/:30 in a
    // :30 zone, i.e. `L ≡ offset (mod 30)` — a lattice with a different PHASE
    // per consultant, which a `step` attribute cannot express.
    expect(gridSnapDeltaMs(ms("2026-09-20T09:00:00.000Z"))).toBe(0);
    const picked = normaliseSlotToSchedulingGrid(row("09:00", "10:00"), NPT);
    expect(picked).toMatchObject({ startTime: "09:15", endTime: "10:15" });
  });
});

// ─── 3. Every client save path ──────────────────────────────────────────────

describe("all four client save paths publish a bookable row", () => {
  it("the settings PUT, weekly", () => {
    const [wire] = formatSlotsForApi(
      day([row("09:00", "12:00")]),
      true,
      NPT,
    ) as WeeklySlotApiFormat[];
    expect(onGrid(wire.startsAt)).toBe(true);
    expect(onGrid(wire.endsAt)).toBe(true);
    // #1343 — the day key is the consultant's LOCAL day, and snapping the
    // minutes must not change which day they said they meant.
    expect(wire.dayOfWeekforStartTimeInUTC).toBe("MONDAY");
  });

  it("the settings PUT, custom", () => {
    const [wire] = formatSlotsForApi(
      { "2026-09-20": [row("09:00", "12:00")] },
      false,
      NPT,
    ) as { startsAt: string; endsAt: string }[];
    expect(onGrid(wire.startsAt)).toBe(true);
    expect(onGrid(wire.endsAt)).toBe(true);
    const refusal = validateCustomWindow(wire, 0, NOW);
    expect(refusal).toBeNull();
  });

  it("the onboarding sync, weekly", () => {
    const [built] = buildWeeklySlotsForSave(
      day([row("09:00", "12:00")]),
      NPT,
    );
    expect(built.startTimeUtc % 30).toBe(0);
    expect(built.endTimeUtc % 30).toBe(0);
  });

  it("the onboarding sync, custom — same answer, one converter", () => {
    // These were two near-identical converters and only one had the snap, so the
    // two surfaces would have disagreed about the consultant's own hours.
    const [onboarding] = buildCustomSlotsForSave(
      { "2026-09-20": [row("09:00", "12:00")] },
      NPT,
    );
    const [settings] = formatSlotsForApi(
      { "2026-09-20": [row("09:00", "12:00")] },
      false,
      NPT,
    ) as { startsAt: string; endsAt: string }[];
    expect(onboarding.startsAt).toBe("2026-09-20T03:30:00.000Z");
    expect(onboarding.startsAt).toBe(settings.startsAt);
    expect(onboarding.endsAt).toBe(settings.endsAt);
  });

  it("is idempotent — re-saving what the form re-read cannot drift", () => {
    // The settings loader converts stored UTC minutes back to local HH:MM, so a
    // second save of an untouched form must reproduce the same row. A snap that
    // is not a fixed point would creep a :45 zone 15 minutes forward per save,
    // which is the same class of bug #1343 was filed for the day key.
    const first = save("09:00", "12:00", NPT);
    const second = save("09:15", "12:15", NPT); // 03:30Z and 06:30Z re-read
    expect(second.startTimeUtc).toBe(first.startTimeUtc);
    expect(second.endTimeUtc).toBe(first.endTimeUtc);
    expect(second.startsAtUtc).toBe(first.startsAtUtc);
  });
});

// ─── 4. Midnight ────────────────────────────────────────────────────────────

describe("a row that crosses midnight keeps its shape", () => {
  it("an IST late block is untouched and reads as overnight in UTC", () => {
    // 22:00 local is 16:30Z (aligned) and 00:00 the next day is 18:30Z, which is
    // minute-of-day 0 — so the row reads as overnight in UTC, as it always did.
    const built = save("22:00", "00:00", IST);
    expect(built.startTimeUtc).toBe(990);
    expect(built.endTimeUtc).toBe(1110);
    expect(built.endDay).toBe("TUESDAY");
  });

  it("a :45 zone's late block needs no shift — :15 IS its lattice", () => {
    const built = save("22:15", "23:45", NPT);
    expect(built.startTimeUtc).toBe(990); // 16:30Z
    expect(built.endTimeUtc).toBe(1080); // 18:00Z
  });

  it("a shift that crosses UTC midnight carries the row's real date", () => {
    // The settings PUT reads a custom row's `startsAt` as a Date, so the DAY
    // part is load-bearing there even though the weekly wire discards it. 05:15
    // IST on 2026-09-20 is 2026-09-19T23:45Z, so the ceiling must land the row
    // on 2026-09-20T00:00Z — silently keeping 09-19 would book a day early.
    const [custom] = formatSlotsForApi(
      { "2026-09-20": [row("05:15", "06:15")] },
      false,
      IST,
    ) as { startsAt: string; endsAt: string }[];
    expect(custom.startsAt).toBe("2026-09-20T00:00:00.000Z");
    expect(custom.endsAt).toBe("2026-09-20T01:00:00.000Z");
  });

  it("the weekly twin of that row stays same-day and legal", () => {
    // The weekly wire keeps only the UTC minute-of-day, so the date roll is
    // absorbed — but the row must not turn into an overnight one to absorb it.
    const built = save("05:15", "06:15", IST);
    expect(built.startTimeUtc).toBe(0);
    expect(built.endTimeUtc).toBe(60);
    expect(built.endDay).toBe("MONDAY");
    expect(accepts(built)).toBeNull();
  });
});

// ─── 5. What the consultant sees ────────────────────────────────────────────

describe("the snapped value is visible in the input itself", () => {
  it("rewrites the pair the picker just produced", () => {
    // 15 minutes is the ENTRY step (PICKER_STEP_SECONDS); 30 is the publish
    // step. Normalising on selection is what makes the consultant's 09:00 read
    // 09:15 immediately, instead of watching it change under a refetch.
    const picked = normaliseSlotToSchedulingGrid(row("09:00", "10:00"), NPT);
    expect(picked).toEqual({
      startTime: "09:15",
      endTime: "10:15",
      isValid: true,
    });
  });

  it("leaves a publishable row alone, in either zone", () => {
    const ist = row("09:00", "10:00");
    expect(normaliseSlotToSchedulingGrid(ist, IST)).toEqual(ist);
    const npt = row("09:15", "10:15");
    expect(normaliseSlotToSchedulingGrid(npt, NPT)).toEqual(npt);
  });

  it("does not touch a row that is still being filled in", () => {
    // handleUpdateSlot runs on every keystroke; a blank boundary is the
    // consultant mid-edit, not a value to snap.
    const half = { startTime: "09:00", endTime: "", isValid: false };
    expect(normaliseSlotToSchedulingGrid(half, NPT)).toBe(half);
  });

  it("keeps an overnight row overnight", () => {
    // 22:15 IST is 16:45Z, half an atom off → 17:00Z = 22:30 local, and the end
    // moves with it so 00:15 becomes 00:30 and the row still crosses midnight.
    const picked = normaliseSlotToSchedulingGrid(row("22:15", "00:15"), IST);
    expect(picked).toMatchObject({ startTime: "22:30", endTime: "00:30" });
  });
});
