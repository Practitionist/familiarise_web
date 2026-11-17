/**
 * @jest-environment node
 */

/** One pin per refusal sentence: each names what happened and the next step. */

import { OccurrenceCompletionStatus } from "@prisma/client";

import { makeUpWindowRefusal } from "@/lib/booking/class-sessions";
import {
  CANCEL_FREEZE_LINE,
  ladderSentence,
  purchaseCancellationCopy,
} from "@/components/booking/CancellationPolicyNote";
import { PLATFORM_DEFAULT_TERMS } from "@/lib/payments/operations/cancellation-policy";
import {
  allocationFailed,
  allocationFailedWithCode,
  soldEventMoveCopy,
} from "@/lib/scheduling/allocationMessages";
import { saveFailedTitle } from "@/components/offerings/editor/feasibility-feedback";

const IST = { zone: "Asia/Kolkata", own: true };
const NOW = new Date("2026-11-18T06:00:00Z");
const cancelled = {
  completionStatus: OccurrenceCompletionStatus.CANCELLED,
  hostCancelledAt: new Date("2026-11-10T04:30:00Z"),
  voidedAt: null,
  seatsSettledAt: null,
};
const refusal = (over: Partial<Parameters<typeof makeUpWindowRefusal>[0]>) =>
  makeUpWindowRefusal({
    source: cancelled,
    startsAt: new Date("2026-11-20T04:30:00Z"),
    now: NOW,
    bypass: false,
    viewer: IST,
    ...over,
  });

describe("MAKEUP_WINDOW_LAPSED: one sentence per condition", () => {
  it("a session outside the class", () => {
    expect(refusal({ source: null })).toBe(
      "That session isn't part of this class.",
    );
  });

  it("a session that was not cancelled or voided", () => {
    expect(
      refusal({
        source: {
          ...cancelled,
          completionStatus: OccurrenceCompletionStatus.SCHEDULED,
        },
      }),
    ).toBe("Only a session that was cancelled or voided can have a make-up.");
  });

  it("a session already refunded", () => {
    expect(refusal({ source: { ...cancelled, seatsSettledAt: NOW } })).toBe(
      "This session was already refunded, so it can no longer have a make-up.",
    );
  });

  it("past the deadline, which is 14 days from the cancellation, in the viewer's zone", () => {
    // Cancelled 10 Nov 10:00 IST, so the window closes 24 Nov 10:00 IST.
    expect(refusal({ startsAt: new Date("2026-11-25T04:30:00Z") })).toBe(
      "A make-up must start by Tue 24 Nov, 10:00 AM, 14 days after the session was cancelled. Pick an earlier time.",
    );
  });

  it("a window that already closed", () => {
    expect(
      refusal({
        now: new Date("2026-11-26T00:00:00Z"),
        startsAt: new Date("2026-11-27T04:30:00Z"),
      }),
    ).toBe(
      "The make-up window closed on Tue 24 Nov, 10:00 AM, 14 days after the session was cancelled.",
    );
  });

  it("a time in the past", () => {
    expect(refusal({ startsAt: new Date("2026-11-18T05:00:00Z") })).toBe(
      "Pick a make-up time in the future.",
    );
  });

  it("a time inside the window passes", () => {
    expect(refusal({})).toBeNull();
  });
});

describe("the cancellation note names the zero tier and the freeze", () => {
  it("reads the real tiers", () => {
    expect(ladderSentence(PLATFORM_DEFAULT_TERMS)).toBe(
      "100% back with 24 hours or more notice — including before a time is agreed at all · 50% back with 2 hours or more notice · 0% back with less than 2 hours notice",
    );
  });

  it("names the 15-minute freeze on a 1:1", () => {
    expect(CANCEL_FREEZE_LINE).toBe(
      "Cancelling closes 15 minutes before a session starts.",
    );
    expect(
      purchaseCancellationCopy({
        eventKind: "individual",
        funding: { kind: "gateway" },
      }).lines,
    ).toContain(CANCEL_FREEZE_LINE);
  });
});

describe("USE_RETIME explains the inside-24-hour case", () => {
  it("a webinar", () => {
    expect(soldEventMoveCopy("webinar", 3)).toBe(
      'This webinar already has 3 booked seats, so its times can\'t be re-planned here. Use "Move to a new date" on the event page: attendees are told and may leave with a full refund. Inside 24 hours of the start it can\'t be moved at all: cancel it instead, and everyone is refunded in full.',
    );
  });

  it("a class", () => {
    expect(soldEventMoveCopy("class")).toMatch(
      /^This class already has booked seats.*"Move upcoming sessions".*A session that starts within 24 hours can't be moved: cancel that session and schedule a make-up instead\.$/,
    );
  });
});

describe("failed-save titles name the action", () => {
  it("an approval from the request callout is not titled as saving timings", () => {
    expect(
      allocationFailed("Network down", "Couldn't approve this request").title,
    ).toBe("Couldn't approve this request");
    expect(
      allocationFailedWithCode("x", "UNLISTED", "Couldn't approve this request")
        .title,
    ).toBe("Couldn't approve this request");
    expect(allocationFailed("x").title).toBe("Couldn't save timings");
  });

  it("an edit of a live plan says changes, never publish", () => {
    expect(
      saveFailedTitle({ publish: true, wasPublished: true, notFeasible: false }),
    ).toBe("Couldn't save your changes");
    expect(
      saveFailedTitle({ publish: true, wasPublished: false, notFeasible: false }),
    ).toBe("Couldn't publish");
    expect(
      saveFailedTitle({ publish: true, wasPublished: true, notFeasible: true }),
    ).toBe("Your open hours can't fit this plan");
  });
});
