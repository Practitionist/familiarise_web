/**
 * @jest-environment node
 */
import {
  CANCEL_FREEZE_BEFORE_START_MS,
  cancelWindowRefusal,
  cancelWindowState,
  type WindowOccurrence,
} from "@/lib/booking/session-window";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function occ(
  startOffsetMs: number,
  durationMs: number,
  completionStatus = "SCHEDULED",
  isTentative = false,
): WindowOccurrence {
  const startsAt = new Date(NOW.getTime() + startOffsetMs);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
    completionStatus,
    isTentative,
  };
}

describe("cancelWindowState", () => {
  it("is BEFORE for a session more than 15 minutes away", () => {
    expect(cancelWindowState([occ(16 * MIN, HOUR)], NOW)).toBe("BEFORE");
  });

  it("freezes from 15 minutes before the start", () => {
    expect(
      cancelWindowState([occ(CANCEL_FREEZE_BEFORE_START_MS, HOUR)], NOW),
    ).toBe("IN_PROGRESS");
    expect(cancelWindowState([occ(10 * MIN, HOUR)], NOW)).toBe("IN_PROGRESS");
  });

  it("is IN_PROGRESS while a session runs, up to and including its end", () => {
    expect(cancelWindowState([occ(-30 * MIN, HOUR)], NOW)).toBe("IN_PROGRESS");
    expect(cancelWindowState([occ(-HOUR, HOUR)], NOW)).toBe("IN_PROGRESS");
  });

  it("is DELIVERED once the only session has ended, swept or not", () => {
    expect(cancelWindowState([occ(-2 * HOUR, HOUR)], NOW)).toBe("DELIVERED");
    expect(cancelWindowState([occ(-2 * HOUR, HOUR, "COMPLETED")], NOW)).toBe(
      "DELIVERED",
    );
    expect(cancelWindowState([occ(-2 * HOUR, HOUR, "UNVERIFIED")], NOW)).toBe(
      "DELIVERED",
    );
  });

  it("is BEFORE when a delivered session has a live one ahead", () => {
    expect(
      cancelWindowState(
        [occ(-7 * 24 * HOUR, HOUR, "COMPLETED"), occ(2 * 24 * HOUR, HOUR)],
        NOW,
      ),
    ).toBe("BEFORE");
  });

  it("is BEFORE when a delivered plan still has unscheduled sessions owed", () => {
    expect(
      cancelWindowState([occ(-7 * 24 * HOUR, HOUR, "COMPLETED")], NOW, {
        hasUnscheduledEntitlement: true,
      }),
    ).toBe("BEFORE");
  });

  it("treats a released (RESCHEDULED) session as still owed", () => {
    expect(
      cancelWindowState(
        [
          occ(-7 * 24 * HOUR, HOUR, "COMPLETED"),
          occ(-HOUR, HOUR, "RESCHEDULED", true),
        ],
        NOW,
      ),
    ).toBe("BEFORE");
  });

  it("ignores unpaid tentative holds and voided or cancelled sessions", () => {
    expect(
      cancelWindowState([occ(5 * MIN, HOUR, "SCHEDULED", true)], NOW),
    ).toBe("BEFORE");
    expect(cancelWindowState([occ(-2 * HOUR, HOUR, "VOIDED")], NOW)).toBe(
      "BEFORE",
    );
    expect(cancelWindowState([occ(-2 * HOUR, HOUR, "CANCELLED")], NOW)).toBe(
      "BEFORE",
    );
  });

  it("an in-progress session wins over everything else on the booking", () => {
    expect(
      cancelWindowState([occ(-10 * MIN, HOUR), occ(7 * 24 * HOUR, HOUR)], NOW, {
        hasUnscheduledEntitlement: true,
      }),
    ).toBe("IN_PROGRESS");
  });
});

describe("cancelWindowRefusal", () => {
  it("answers 409 with a coded, plain sentence for each frozen state", () => {
    const inProgress = cancelWindowRefusal("IN_PROGRESS");
    expect(inProgress?.code).toBe("SESSION_IN_PROGRESS");
    expect(inProgress?.httpStatus).toBe(409);
    const delivered = cancelWindowRefusal("DELIVERED");
    expect(delivered?.code).toBe("SESSION_ALREADY_DELIVERED");
    expect(delivered?.httpStatus).toBe(409);
    expect(delivered?.userMessage).not.toMatch(/SESSION_|[0-9a-f]{8}-/);
  });

  it("tells the host a session under way is settled from what happened", () => {
    expect(
      cancelWindowRefusal("IN_PROGRESS", undefined, "host")?.userMessage,
    ).toBe(
      "This session is in progress — end the call and we'll settle it from what happened.",
    );
  });

  it("lets a BEFORE booking through", () => {
    expect(cancelWindowRefusal("BEFORE")).toBeNull();
  });
});
