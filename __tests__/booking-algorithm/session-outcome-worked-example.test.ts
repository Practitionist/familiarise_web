/**
 * @jest-environment node
 */
import {
  classifySessionOutcome,
  RECONNECT_GRACE_MINUTES,
  VOID_LOSS_MINUTES,
} from "@/lib/booking/session-outcome";

// The settled-record decision's worked example: Hannah hosts Priya, Mon 23 Nov
// 2026 10:00-11:00 IST (04:30-05:30 UTC). Offsets are seconds from 10:00 IST.
const START = Date.UTC(2026, 10, 23, 4, 30);
const at = (seconds: number) => new Date(START + seconds * 1000);
const stay = (userId: string, from: number, to: number) => ({
  userId,
  joinedAt: at(from),
  leftAt: at(to),
});
const M = 60;

const priyaWithDrop = (gapSeconds: number) => [
  stay("priya", -117, 20 * M + 10),
  stay("priya", 20 * M + 10 + gapSeconds, 59 * M + 50),
];

const classify = (intervals: ReturnType<typeof stay>[]) =>
  classifySessionOutcome({
    startsAt: at(0),
    endsAt: at(60 * M),
    hostUserIds: ["hannah"],
    intervals,
    meeting: { endedAt: at(64 * M + 50), endedReason: "session_timeout" },
    maintenanceWindows: [],
  });

it("Hannah 2 minutes late with Priya's 3-minute drop merged is HELD: 58 delivered, 2 lost", () => {
  expect(3 * M).toBeLessThan(RECONNECT_GRACE_MINUTES * M);
  expect(
    classify([
      ...priyaWithDrop(3 * M + 2),
      stay("hannah", 2 * M + 10, 59 * M + 40),
    ]),
  ).toMatchObject({
    outcome: "HELD",
    completionStatus: "COMPLETED",
    deliveredMinutes: 58,
    lostMinutes: 2,
  });
});

it("Hannah's own 3-minute drop merges too: still HELD, 58 delivered", () => {
  expect(
    classify([
      ...priyaWithDrop(3 * M + 2),
      stay("hannah", 2 * M + 10, 30 * M),
      stay("hannah", 33 * M, 59 * M + 40),
    ]),
  ).toMatchObject({ outcome: "HELD", deliveredMinutes: 58 });
});

it("Hannah away 10:10-10:24 loses 14 + 2 minutes, at or over the void line: CUT_SHORT, host-attributed", () => {
  expect(14 + 2).toBeGreaterThanOrEqual(VOID_LOSS_MINUTES);
  expect(
    classify([
      ...priyaWithDrop(3 * M + 2),
      stay("hannah", 2 * M + 10, 10 * M),
      stay("hannah", 24 * M, 59 * M + 40),
    ]),
  ).toMatchObject({
    outcome: "CUT_SHORT",
    completionStatus: "VOIDED",
    lostMinutes: 16,
    deliveredMinutes: 44,
    hostAttributed: true,
  });
});

it("a call Stream affirms nobody joined is NOBODY_JOINED", () => {
  expect(classify([])).toMatchObject({ outcome: "NOBODY_JOINED" });
});
