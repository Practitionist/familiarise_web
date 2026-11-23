/**
 * @jest-environment node
 */
import type { OccurrenceOutcome } from "@prisma/client";

import { judgeOutcomeEvidence } from "@/lib/booking/outcome-evidence";
import {
  classifySessionOutcome,
  type OutageWindow,
  type SessionOutcomeInput,
} from "@/lib/booking/session-outcome";

// The report-window record's worked example: Hannah hosts Priya, Mon 23 Nov
// 2026 10:00-11:00 IST (04:30-05:30 UTC). Offsets are minutes from 10:00 IST.
const START = Date.UTC(2026, 10, 23, 4, 30);
const at = (minutes: number) => new Date(START + minutes * 60_000);
const stay = (userId: string, from: number, to: number) => ({
  userId,
  joinedAt: at(from),
  leftAt: at(to),
});

const session = (
  intervals: SessionOutcomeInput["intervals"],
  overrides: Partial<SessionOutcomeInput> = {},
): SessionOutcomeInput => ({
  startsAt: at(0),
  endsAt: at(60),
  hostUserIds: ["hannah"],
  intervals,
  meeting: { endedAt: at(65), endedReason: "session_timeout" },
  maintenanceWindows: [],
  ...overrides,
});

/** The classifier's verdict and the evidence judged for it, as the sweep will pair them. */
const judge = (input: SessionOutcomeInput, everySessionAnnounced = true) => {
  const { outcome } = classifySessionOutcome(input);
  return {
    outcome,
    evidence: judgeOutcomeEvidence(
      { ...input, everySessionAnnounced },
      outcome,
    ),
  };
};

describe("the record's four worked variants", () => {
  it("1. both attended: HELD has no evidence gate", () => {
    expect(
      judge(session([stay("priya", -2, 60), stay("hannah", 2, 60)])),
    ).toEqual({ outcome: "HELD", evidence: null });
  });

  it("2. the expert is absent and Priya waited the hour, every session announced: strong", () => {
    expect(judge(session([stay("priya", -2, 60)]))).toEqual({
      outcome: "HOST_ABSENT",
      evidence: { strong: true, failed: [] },
    });
  });

  it("3. the learner is absent and Hannah waited 28 minutes: strong", () => {
    expect(judge(session([stay("hannah", 2, 30)]))).toEqual({
      outcome: "LEARNER_ABSENT",
      evidence: { strong: true, failed: [] },
    });
  });

  it("4. Stream lists only Hannah's four-minute session A: LEARNER_ABSENT on weak evidence", () => {
    expect(judge(session([stay("hannah", 0, 4)]))).toEqual({
      outcome: "LEARNER_ABSENT",
      evidence: { strong: false, failed: ["counterpart-waited"] },
    });
  });
});

describe("each strong-evidence condition", () => {
  it("1. a session read on corroboration alone, not announced ready, is weak", () => {
    expect(judge(session([stay("priya", -2, 60)]), false).evidence).toEqual({
      strong: false,
      failed: ["announced"],
    });
  });

  it.each([
    ["before the classifier's early horizon", -40, -30],
    ["after its overrun horizon", 95, 100],
  ])(
    "2. a host stay %s leaves the classifier at HOST_ABSENT but the evidence weak",
    (_case, from, to) => {
      expect(
        judge(session([stay("priya", -2, 60), stay("hannah", from, to)])),
      ).toEqual({
        outcome: "HOST_ABSENT",
        evidence: { strong: false, failed: ["accused-absent"] },
      });
    },
  );

  it("2. a learner stay outside the horizons makes a learner-absent verdict weak", () => {
    expect(
      judge(session([stay("hannah", 2, 30), stay("priya", 100, 102)])),
    ).toEqual({
      outcome: "LEARNER_ABSENT",
      evidence: { strong: false, failed: ["accused-absent"] },
    });
  });

  it("3. a learner who left after 10 minutes of a 60-minute session did not wait the 15-minute line", () => {
    expect(judge(session([stay("priya", 0, 10)]))).toEqual({
      outcome: "HOST_ABSENT",
      evidence: { strong: false, failed: ["counterpart-waited"] },
    });
  });

  it("3. on a 20-minute session the line is half the booked length, 10 minutes", () => {
    const short = (leftAt: number) =>
      judge(session([stay("priya", 0, leftAt)], { endsAt: at(20) }));
    expect(short(10).evidence).toEqual({ strong: true, failed: [] });
    expect(short(9).evidence).toEqual({
      strong: false,
      failed: ["counterpart-waited"],
    });
  });

  it("3. presence is the union of real stays: a reconnect gap is not waiting time", () => {
    // Two 7-minute stays 4 minutes apart: the classifier's grace would merge them into 18.
    expect(
      judge(session([stay("hannah", 0, 7), stay("hannah", 11, 18)])).evidence,
    ).toEqual({ strong: false, failed: ["counterpart-waited"] });
  });

  it("3. any host-side person counts towards the host's wait", () => {
    expect(
      judge(
        session([stay("hannah", 0, 8), stay("arjun", 6, 16)], {
          hostUserIds: ["hannah", "arjun"],
        }),
      ).evidence,
    ).toEqual({ strong: true, failed: [] });
  });

  const maintenance: OutageWindow = {
    startsAt: at(50),
    endsAt: at(55),
    source: "maintenance",
  };

  it("4. a maintenance window over the booked time makes a learner-absent verdict weak", () => {
    expect(
      judge(
        session([stay("hannah", 2, 30)], { maintenanceWindows: [maintenance] }),
      ),
    ).toEqual({
      outcome: "LEARNER_ABSENT",
      evidence: { strong: false, failed: ["no-outage"] },
    });
  });

  it("4. a drain that ended the call counts as an outage too", () => {
    expect(
      judge(
        session([stay("hannah", 2, 30)], {
          meeting: { endedAt: at(40), endedReason: "maintenance" },
        }),
      ).evidence,
    ).toEqual({ strong: false, failed: ["no-outage"] });
  });

  it("4. a maintenance window outside the booked time does not count", () => {
    expect(
      judge(
        session([stay("hannah", 2, 30)], {
          maintenanceWindows: [
            { startsAt: at(70), endsAt: at(80), source: "maintenance" },
          ],
        }),
      ).evidence,
    ).toEqual({ strong: true, failed: [] });
  });
});

describe("CUT_SHORT", () => {
  // Hannah away 10:10-10:30 while Priya waits: 20 host minutes lost.
  const cut = [
    stay("priya", 0, 60),
    stay("hannah", 0, 10),
    stay("hannah", 30, 60),
  ];

  it("needs only the announcements and no outage, since both sides were there", () => {
    expect(judge(session(cut))).toEqual({
      outcome: "CUT_SHORT",
      evidence: { strong: true, failed: [] },
    });
  });

  it("is weak with a corroborated session or an outage, and reports both", () => {
    const outage: OutageWindow = {
      startsAt: at(58),
      endsAt: at(59),
      source: "maintenance",
    };
    expect(
      judge(session(cut, { maintenanceWindows: [outage] }), false),
    ).toEqual({
      outcome: "CUT_SHORT",
      evidence: { strong: false, failed: ["announced", "no-outage"] },
    });
  });
});

it.each<OccurrenceOutcome>([
  "HELD",
  "PLATFORM_OUTAGE",
  "NOBODY_JOINED",
  "INCONCLUSIVE",
  "OFFLINE",
])("%s is outside the evidence gate", (outcome) => {
  expect(
    judgeOutcomeEvidence(
      { ...session([]), everySessionAnnounced: true },
      outcome,
    ),
  ).toBeNull();
});
