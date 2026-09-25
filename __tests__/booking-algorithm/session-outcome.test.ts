/**
 * @jest-environment node
 */
import { classifySessionOutcome } from "@/lib/booking/session-outcome";

// #1569 D1 — the void rule's table; minutes are offsets from 10:00.
const at = (m: number) => new Date(Date.UTC(2026, 8, 25, 10, 0) + m * 60_000);
const seg = (userId: string, from: number, to: number) => ({
  userId,
  joinedAt: at(from),
  leftAt: at(to),
});
const run = (
  booked: number,
  intervals: ReturnType<typeof seg>[],
  meeting = { endedAt: at(booked), endedReason: "session_timeout" },
  hostUserIds = ["host", "cohost"],
) =>
  classifySessionOutcome({
    startsAt: at(0),
    endsAt: at(booked),
    hostUserIds,
    intervals,
    meeting,
    report: null,
    maintenanceWindows: [],
  });

describe("classifySessionOutcome (#1569 D1)", () => {
  it.each([
    [
      "a late learner never voids",
      60,
      [seg("host", 0, 60), seg("l", 40, 60)],
      "HELD",
    ],
    [
      "host drops 16 min",
      60,
      [seg("host", 0, 20), seg("host", 36, 60), seg("l", 0, 60)],
      "CUT_SHORT",
    ],
    [
      "a co-presenter covers the drop",
      60,
      [
        seg("host", 0, 20),
        seg("cohost", 19, 40),
        seg("host", 39, 60),
        seg("l", 0, 60),
      ],
      "HELD",
    ],
    [
      "everyone drops together",
      60,
      [seg("host", 0, 30), seg("l", 0, 31)],
      "PLATFORM_OUTAGE",
    ],
    [
      "25-min session, 13 min lost (50% arm)",
      25,
      [seg("host", 0, 12), seg("l", 0, 25)],
      "CUT_SHORT",
    ],
    [
      "a 20-min overrun repays a 15-min drop",
      60,
      [seg("host", 0, 20), seg("host", 35, 80), seg("l", 0, 80)],
      "HELD",
    ],
    ["host never joined", 60, [seg("l", 0, 30)], "HOST_ABSENT"],
    ["learner never joined", 60, [seg("host", 0, 60)], "LEARNER_ABSENT"],
    [
      "the learner left first",
      60,
      [seg("host", 0, 30), seg("l", 0, 20)],
      "HELD",
    ],
  ])("%s", (_name, booked, intervals, outcome) => {
    expect(run(booked, intervals).outcome).toBe(outcome);
  });

  it("a host's mid-session End for everyone is CUT_SHORT; no host side on record is INCONCLUSIVE", () => {
    const together = [seg("host", 0, 30), seg("l", 0, 30)];
    const hostEnded = { endedAt: at(30), endedReason: "call_ended" };
    expect(run(60, together, hostEnded).outcome).toBe("CUT_SHORT");
    expect(run(60, [seg("l", 0, 60)], undefined, []).outcome).toBe(
      "INCONCLUSIVE",
    );
  });

  it("parks INCONCLUSIVE when Stream saw more people than our rows", () => {
    const v = classifySessionOutcome({
      startsAt: at(0),
      endsAt: at(60),
      hostUserIds: ["host"],
      intervals: [seg("l", 0, 60)],
      meeting: { endedAt: at(60), endedReason: "call_ended" },
      report: { unique: 2 },
      maintenanceWindows: [],
    });
    expect(v).toMatchObject({
      outcome: "INCONCLUSIVE",
      completionStatus: "UNVERIFIED",
    });
  });
});
