/**
 * @jest-environment node
 */

// Invariant: the exit waits for the series' unconfirmed negative void that
// settles last, an unknown verdict time last of all, and for none otherwise.

import { exitWaitOf } from "@/lib/booking/class-exit-wait";

const voided = (startsAt: string, outcomeAt: string | null, over = {}) => ({
  startsAt,
  completionStatus: "VOIDED",
  deletedAt: null,
  seatsSettledAt: null,
  outcome: "CUT_SHORT" as const,
  outcomeAt,
  outcomeConfirmedAt: null,
  ...over,
});

it("waits for none when no void is pending", () => {
  expect(exitWaitOf([])).toBeNull();
  expect(
    exitWaitOf([
      voided("2026-11-12T04:30:00Z", "2026-11-12T11:45:00Z", {
        outcomeConfirmedAt: "2026-11-13T00:00:00Z",
      }),
      voided("2026-11-12T04:30:00Z", "2026-11-12T11:45:00Z", {
        outcome: "PLATFORM_OUTAGE",
      }),
    ]),
  ).toBeNull();
});

it("waits for the void that settles last, and an unknown verdict time last of all", () => {
  const early = voided("2026-11-10T04:30:00Z", "2026-11-10T11:45:00Z");
  const late = voided("2026-11-12T04:30:00Z", "2026-11-12T11:45:00Z");
  expect(exitWaitOf([late, early])).toEqual({
    sessionStartsAt: new Date("2026-11-12T04:30:00Z"),
    settlesBy: new Date("2026-11-14T11:45:00Z"),
  });
  const unknown = voided("2026-11-11T04:30:00Z", null);
  expect(exitWaitOf([early, unknown, late])).toEqual({
    sessionStartsAt: new Date("2026-11-11T04:30:00Z"),
    settlesBy: null,
  });
});
