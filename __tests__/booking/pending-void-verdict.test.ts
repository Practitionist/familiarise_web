/**
 * @jest-environment node
 */

// Invariant: a class remedy waits for the unconfirmed negative void that
// settles last, an unknown verdict time last of all, and for none otherwise.

import {
  pendingVerdictMessage,
  pendingVoidVerdict,
} from "@/lib/booking/pending-void-verdict";

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
  expect(pendingVoidVerdict([])).toBeNull();
  expect(
    pendingVoidVerdict([
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
  expect(pendingVoidVerdict([late, early])).toEqual({
    sessionStartsAt: new Date("2026-11-12T04:30:00Z"),
    settlesBy: new Date("2026-11-14T11:45:00Z"),
  });
  const unknown = voided("2026-11-11T04:30:00Z", null);
  expect(pendingVoidVerdict([early, unknown, late])).toEqual({
    sessionStartsAt: new Date("2026-11-11T04:30:00Z"),
    settlesBy: null,
  });
});

it("names the session and its window's close for each remedy, in the reader's zone", () => {
  const wait = {
    // 12 Nov 10:00 IST; its report window closes 14 Nov 17:15 IST.
    sessionStartsAt: new Date("2026-11-12T04:30:00Z"),
    settlesBy: new Date("2026-11-14T11:45:00Z"),
  };
  const now = new Date("2026-11-13T00:00:00Z");
  expect(pendingVerdictMessage(wait, "Asia/Kolkata", now, "cancel")).toBe(
    "We're confirming what happened in the 12 Nov session. You can cancel the class once it's settled; the report window closes 14 Nov, 5:15 pm IST, and if it needs a review our team will decide.",
  );
  expect(pendingVerdictMessage(wait, "Asia/Kolkata", now, "skip")).toBe(
    "We're confirming what happened in your 12 Nov session. Its refund waits until it's settled; the report window closes 14 Nov, 5:15 pm IST, and if it needs a review our team will decide.",
  );
});

it("tells whoever cancels a consultation what waits, by when, and that the session is refunded in full once confirmed", () => {
  const wait = {
    sessionStartsAt: new Date("2026-11-12T04:30:00Z"),
    settlesBy: new Date("2026-11-14T11:45:00Z"),
  };
  const open = new Date("2026-11-13T00:00:00Z");
  const passed = new Date("2026-11-15T00:00:00Z");
  expect(
    pendingVerdictMessage(wait, "Asia/Kolkata", open, "cancelBooking"),
  ).toBe(
    "We're confirming what happened in the 12 Nov session. You can cancel this booking once that's confirmed, with the session then refunded in full; the report window closes 14 Nov, 5:15 pm IST, and if it needs a review our team will decide.",
  );
  expect(
    pendingVerdictMessage(wait, "Asia/Kolkata", passed, "cancelBooking"),
  ).toBe(
    "We're confirming what happened in the 12 Nov session. Our team is reviewing it, and you can cancel this booking once that's confirmed, with the session then refunded in full.",
  );
});
