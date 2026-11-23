/**
 * @jest-environment node
 */

// Invariant: a report moves a negative verdict only when the right side filed
// it, on a personal case, between the booked end and the window's close; any
// counted dispute wins, and a neutral reason changes nothing.

import {
  judgeReports,
  type OutcomeReport,
  type ReportedVerdict,
} from "@/lib/booking/outcome-reports";
import type { NegativeMoneyOutcome } from "@/lib/booking/misses";

const END = new Date("2026-11-23T11:00:00Z");
const VERDICT_AT = new Date("2026-11-23T17:15:00Z");
const CLOSES = new Date("2026-11-25T17:15:00Z");

const verdict = (outcome: NegativeMoneyOutcome): ReportedVerdict => ({
  outcome,
  endsAt: END,
  windowClosesAt: CLOSES,
  hostUserIds: ["hannah"],
  learnerUserIds: ["priya"],
});

const report = (
  flowReason: string,
  by: string,
  overrides: Partial<OutcomeReport> = {},
): OutcomeReport => ({
  flowReason,
  requesterUserId: by,
  ownershipScope: "PERSONAL",
  createdAt: new Date("2026-11-24T09:00:00Z"),
  deletedAt: null,
  ...overrides,
});

describe("each row of the table", () => {
  it.each([
    ["HOST_ABSENT", "provider_join_issue", "hannah", "disputed"],
    ["HOST_ABSENT", "provider_attended", "hannah", "disputed"],
    ["HOST_ABSENT", "provider_no_show", "priya", "agreed"],
    ["CUT_SHORT", "provider_join_issue", "hannah", "disputed"],
    ["CUT_SHORT", "provider_attended", "hannah", "disputed"],
    ["CUT_SHORT", "provider_no_show", "priya", "agreed"],
    ["LEARNER_ABSENT", "attendee_join_issue", "priya", "disputed"],
    ["LEARNER_ABSENT", "attendee_attended", "priya", "disputed"],
    // The host saying the learner never came is neutral: the host gains from the verdict.
    ["LEARNER_ABSENT", "attendee_no_show", "hannah", "silent"],
    ["HOST_ABSENT", "attendee_no_show", "hannah", "silent"],
  ] as const)("%s with %s from %s is %s", (outcome, reason, by, judged) => {
    expect(judgeReports([report(reason, by)], verdict(outcome))).toBe(judged);
  });

  it("lets any counted dispute win over an agreement", () => {
    expect(
      judgeReports(
        [
          report("provider_no_show", "priya"),
          report("provider_attended", "hannah"),
        ],
        verdict("HOST_ABSENT"),
      ),
    ).toBe("disputed");
  });
});

describe("a report that does not count", () => {
  it("from the wrong side, including a host holding a learner seat", () => {
    const v = verdict("HOST_ABSENT");
    expect(judgeReports([report("provider_no_show", "hannah")], v)).toBe(
      "silent",
    );
    expect(judgeReports([report("provider_attended", "priya")], v)).toBe(
      "silent",
    );
    expect(
      judgeReports([report("provider_no_show", "hannah")], {
        ...v,
        learnerUserIds: ["priya", "hannah"],
      }),
    ).toBe("silent");
  });

  it("from an org operator's case", () => {
    expect(
      judgeReports(
        [
          report("provider_no_show", "priya", {
            ownershipScope: "ORG_OPERATIONS",
          }),
        ],
        verdict("HOST_ABSENT"),
      ),
    ).toBe("silent");
  });

  it("filed after the window closed, or before the booked end, or deleted", () => {
    const v = verdict("LEARNER_ABSENT");
    for (const overrides of [
      { createdAt: new Date(CLOSES.getTime() + 1) },
      { createdAt: new Date(END.getTime() - 1) },
      { deletedAt: VERDICT_AT },
    ]) {
      expect(
        judgeReports([report("attendee_attended", "priya", overrides)], v),
      ).toBe("silent");
    }
  });
});

it("counts a report filed before the verdict was written", () => {
  const early = new Date("2026-11-23T12:00:00Z");
  expect(early < VERDICT_AT).toBe(true);
  expect(
    judgeReports(
      [report("provider_no_show", "priya", { createdAt: early })],
      verdict("HOST_ABSENT"),
    ),
  ).toBe("agreed");
});
