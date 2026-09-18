/**
 * #1703 F5 — the confirm dialog's pure half: a slot's verdict is matched on
 * the instant (the validate routes return a zone-less UTC prefix), the
 * summary reads as one sentence, and the dead-end hand-off pins the grid.
 */
import {
  allocateHrefAt,
  parseSlotInstant,
  resolvePrimaryTitle,
  summarizeVerdicts,
  verdictFor,
} from "@/components/dashboard/shared/requests/components/requested-slots-verdicts";

const requested = [
  "2026-09-24T08:30:00.000Z",
  "2026-09-24T09:00:00.000Z",
  "2026-09-24T09:30:00.000Z",
];

const result = {
  // Exactly the shape the validate route emits: no zone designator.
  conflicts: [
    {
      slot: "2026-09-24T08:30:00",
      existingAppointment: {
        type: "Consultation",
        with: "Another user",
        time: "",
      },
    },
  ],
  outsideAvailability: [{ slot: "2026-09-24T09:00:00" }],
  outsidePeriod: [],
  validSlots: [],
};

describe("requested-slot verdicts", () => {
  it("reads a zone-less validate slot as UTC and matches on the instant", () => {
    expect(parseSlotInstant("2026-09-24T08:30:00")).toBe(
      parseSlotInstant("2026-09-24T08:30:00.000Z"),
    );
    expect(verdictFor(requested[0], result)).toEqual({
      kind: "conflict",
      existing: "Consultation with another user",
    });
    expect(verdictFor(requested[1], result)).toEqual({
      kind: "outsideAvailability",
    });
    expect(verdictFor(requested[2], result)).toEqual({ kind: "free" });
    expect(verdictFor(requested[2], null)).toEqual({ kind: "checking" });
  });

  it("summarises as one sentence and stays quiet about zero counts", () => {
    const verdicts = requested.map((slot) => verdictFor(slot, result));
    expect(summarizeVerdicts(verdicts)).toBe(
      "3 slots requested · 1 conflicts with an existing booking · 1 outside availability",
    );
    expect(summarizeVerdicts([{ kind: "free" }])).toBe(
      "1 slot requested · free",
    );
    expect(summarizeVerdicts([{ kind: "checking" }, { kind: "free" }])).toBe(
      "2 slots requested · checking…",
    );
  });

  it("pins the allocate page on the blocked slot and names the primary's reason", () => {
    expect(
      allocateHrefAt(
        "/dashboard/consultant/c1/requests/r1/allocate?type=consultation",
        "2026-09-24T08:30:00",
      ),
    ).toBe(
      "/dashboard/consultant/c1/requests/r1/allocate?type=consultation&at=2026-09-24T08%3A30%3A00.000Z",
    );
    expect(resolvePrimaryTitle({ blocked: true, outsideHours: 0 })).toMatch(
      /pick another time/,
    );
    expect(resolvePrimaryTitle({ blocked: false, outsideHours: 2 })).toMatch(
      /2 slots are outside your published hours/,
    );
    expect(resolvePrimaryTitle({ blocked: false, outsideHours: 0 })).toBe(
      "Book every requested time.",
    );
  });
});
