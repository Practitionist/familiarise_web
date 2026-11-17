/**
 * Checkout prints "Starts" and "First cycle" in the zone the server cuts the
 * cycle in (the feasibility response's `zone`), labelled, so a buyer in another
 * zone reads the same dates the server stores.
 */

import { firstCycleLines } from "@/app/checkout/plans/adapters/first-cycle-lines";

const plan = { sessionsPerWeek: 2, durationInMonths: 1 };

describe("firstCycleLines", () => {
  it("reads the start and the 7-day cycle in the expert's zone, with its label", () => {
    // 20:00 UTC on 16 Nov is 01:30 IST on 17 Nov.
    expect(
      firstCycleLines("2026-11-16T20:00:00.000Z", plan, "Asia/Kolkata"),
    ).toMatchObject({
      starts: "17 Nov 2026 IST",
      cycle: "17 Nov 2026 → 23 Nov 2026 IST",
    });
  });
});
