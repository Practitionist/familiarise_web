/**
 * @jest-environment node
 */

/**
 * A consultee who gives up a subscription session inside 24 h of its start
 * forfeits it: no consultee door can hand it back to the plan, so plan-end
 * settlement counts it as delivered and never refunds it.
 *  - A return to the plan needs 24 h of notice (`returnBlock`).
 *  - Inside 24 h a session moves only when the other side accepts proposed
 *    times (rescheduleCancel.test.ts pins the route); otherwise it stands.
 *  - The only single-session cancel is the class host's; a subscription is
 *    cancelled whole, on the notice ladder, and never reaches plan end.
 *  - A consultee who simply misses the session is LEARNER_ABSENT, which the
 *    outcome sweep writes as COMPLETED: delivered in the entitlement and in the
 *    plan-end count.
 */

import fs from "node:fs";
import path from "node:path";

import {
  isCompletedOccurrence,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  RETURN_BLOCK_COPY,
  returnBlock,
} from "@/lib/booking/session-return-rules";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-09T12:00:00Z");
const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("no consultee door returns a session inside 24 h", () => {
  it("refuses a return 23 h out and says the session counts as delivered", () => {
    const startsAt = new Date(NOW.getTime() + 23 * HOUR);
    expect(
      returnBlock({
        startsAt,
        now: NOW,
        sessionsReturned: 0,
        rescheduleOpen: false,
      }),
    ).toBe("WINDOW_CLOSED");
    expect(RETURN_BLOCK_COPY.WINDOW_CLOSED).toMatch(/counts as delivered/);
    expect(
      returnBlock({
        startsAt: new Date(NOW.getTime() + 24 * HOUR),
        now: NOW,
        sessionsReturned: 0,
        rescheduleOpen: false,
      }),
    ).toBeNull();
  });

  it("offers no single-session cancel on a subscription", () => {
    const src = read(
      "app/api/appointments/[appointmentId]/occurrences/[occurrenceId]/cancel/route.ts",
    );
    expect(src).toContain("cancelClassSession");
    expect(src).toContain("hostOnly: true");
  });
});

describe("a missed session stays delivered at plan end", () => {
  it("counts a learner-absent COMPLETED session as delivered, leaving only unplaced sessions unused", () => {
    const sessions = [
      { startsAt: new Date(NOW.getTime() - 72 * HOUR), status: "COMPLETED" },
      // The consultee did not join: the outcome sweep writes LEARNER_ABSENT as COMPLETED.
      { startsAt: new Date(NOW.getTime() - 24 * HOUR), status: "COMPLETED" },
    ].map((s) => ({
      startsAt: s.startsAt,
      endsAt: new Date(s.startsAt.getTime() + HOUR),
      completionStatus: s.status,
      isTentative: false,
      deletedAt: null,
    }));
    const ent = subscriptionEntitlement({
      sessionsTotal: 4,
      sessionsRefunded: 0,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      occurrences: sessions,
      schedulingPeriodStartsAt: new Date(NOW.getTime() - 20 * 24 * HOUR),
      schedulingTimezone: "UTC",
      now: NOW,
    });
    expect(ent.completed).toBe(2);
    // settle-cancelled-sessions' plan-end pass: unused = total − delivered.
    const delivered = sessions.filter(isCompletedOccurrence).length;
    expect(Math.max(0, 4 - delivered)).toBe(2);
    expect(read("scripts/appointments/settle-cancelled-sessions.ts")).toContain(
      "rows.filter(isCompletedOccurrence).length",
    );
  });
});
