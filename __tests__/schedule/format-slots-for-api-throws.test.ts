/**
 * @jest-environment node
 */

/**
 * #1125 — `formatSlotsForApi` feeds a PUT body (SettingsTab.tsx:457), so
 * "degrade" here does not mean render less, it means SAVE less. It used to carry
 * three nested catches: a per-slot one dropped the offending slot from the
 * payload, and an outer one returned `[]` for the entire schedule — after which
 * SettingsTab refetched and displayed the wiped availability as "what was
 * actually saved". These pin the replacement contract: all of it, or an error
 * the caller can show the consultant.
 */
import { formatSlotsForApi } from "@/utils/schedule/formatting";
import type { SlotsType } from "@/utils/schedule/types";

const slot = (startTime: string, endTime: string) => ({
  id: `${startTime}-${endTime}`,
  startTime,
  endTime,
  isValid: true,
});

describe("formatSlotsForApi is all-or-nothing (#1125)", () => {
  it("formats every weekly slot it is given", () => {
    const slots: SlotsType = {
      monday: [slot("09:00", "10:00"), slot("14:00", "15:00")],
      tuesday: [slot("11:00", "12:00")],
    };

    const result = formatSlotsForApi(slots, true, "UTC");

    expect(result).toHaveLength(3);
  });

  it("formats every custom slot it is given", () => {
    const slots: SlotsType = {
      "2026-09-01": [slot("09:00", "10:00")],
      "2026-09-02": [slot("13:00", "14:30")],
    };

    const result = formatSlotsForApi(slots, false, "UTC");

    expect(result).toHaveLength(2);
  });

  it("throws rather than dropping a custom slot whose date key is unusable", () => {
    // The old behaviour returned the OTHER day's slots and silently omitted
    // this one, so the consultant saved a schedule missing a day they had set.
    const slots: SlotsType = {
      "2026-09-01": [slot("09:00", "10:00")],
      "not-a-date": [slot("09:00", "10:00")],
    };

    expect(() => formatSlotsForApi(slots, false, "UTC")).toThrow(
      /Invalid date format/,
    );
  });

  it("throws rather than wiping the whole schedule when a day key is unusable", () => {
    // The outer catch turned this into `[]`, which is indistinguishable from
    // "this consultant has no availability" once it reaches the API.
    const slots: SlotsType = {
      notaday: [slot("09:00", "10:00")],
    };

    expect(() => formatSlotsForApi(slots, true, "UTC")).toThrow();
  });

  it("still skips slots the caller already marked invalid", () => {
    // Distinct from a formatting FAILURE: `isValid: false` is the editor saying
    // the row is incomplete, which is an answer, not an error. Those must keep
    // being filtered rather than throwing.
    const slots: SlotsType = {
      monday: [
        slot("09:00", "10:00"),
        { ...slot("bad", "worse"), isValid: false },
      ],
    };

    const result = formatSlotsForApi(slots, true, "UTC");

    expect(result).toHaveLength(1);
  });
});
