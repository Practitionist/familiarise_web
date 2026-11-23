/**
 * @jest-environment node
 */

/**
 * A session parked for ops more than 7 days is escalated once per new id per
 * day, naming how many hold an ended plan's settlement. No money moves.
 */

const mockStanding = jest.fn(
  async (_args: unknown, report?: () => void): Promise<boolean> => {
    report?.();
    return true;
  },
);
const mockSentry = jest.fn();

jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: (args: unknown, report?: () => void) =>
    mockStanding(args, report),
}));
jest.mock("../../lib/observability/report", () => ({
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryMessage: (...a: unknown[]) => mockSentry(...a),
}));

import {
  agedNeedsHumanWhere,
  isAgedNeedsHuman,
  needsHumanWhere,
  NEEDS_HUMAN_ESCALATE_DAYS,
} from "@/lib/booking/misses";
import { escalateAgedNeedsHuman } from "@/lib/booking/session-outcome-sweep";

const NOW = new Date("2026-11-09T12:00:00Z");
const CUTOFF = new Date(NOW.getTime() - 7 * 24 * 3_600_000);

beforeEach(() => jest.clearAllMocks());

it("ages from the verdict, or from the call's end when none was written", () => {
  expect(NEEDS_HUMAN_ESCALATE_DAYS).toBe(7);
  expect(agedNeedsHumanWhere(NOW)).toEqual({
    AND: [
      needsHumanWhere(NOW),
      {
        OR: [
          { outcomeAt: { lt: CUTOFF } },
          { outcomeAt: null, endsAt: { lt: CUTOFF } },
        ],
      },
    ],
  });
  const before = new Date(CUTOFF.getTime() - 1);
  expect(isAgedNeedsHuman({ outcomeAt: before, endsAt: NOW }, NOW)).toBe(true);
  expect(isAgedNeedsHuman({ outcomeAt: null, endsAt: before }, NOW)).toBe(true);
  expect(isAgedNeedsHuman({ outcomeAt: NOW, endsAt: before }, NOW)).toBe(false);
});

it("escalates aged sessions as a standing finding with one Sentry warning", async () => {
  const count = jest
    .fn()
    .mockResolvedValueOnce(3) // aged
    .mockResolvedValueOnce(2); // on an ended plan
  const db = {
    appointmentOccurrence: {
      count,
      findMany: jest.fn(async () => [{ id: "o1" }, { id: "o2" }, { id: "o3" }]),
    },
  };

  expect(await escalateAgedNeedsHuman(db as never, NOW)).toBe(3);

  expect(mockStanding).toHaveBeenCalledWith(
    {
      key: "session-outcome-sweep:needs-human-escalation",
      ids: ["o1", "o2", "o3", "count:3"],
      message:
        "3 session(s) waited over 7 days for an ops decision; 2 hold an ended plan's settlement",
    },
    expect.any(Function),
  );
  expect(mockSentry).toHaveBeenCalledTimes(1);
  const [, blockingQuery] = count.mock.calls as unknown as [
    unknown,
    [{ where: { AND: unknown[] } }],
  ];
  expect(blockingQuery[0].where.AND[1]).toEqual({
    appointment: { subscription: { planEndsAt: { lte: NOW } } },
  });
});

it("reports nothing when no session has waited 7 days", async () => {
  const db = {
    appointmentOccurrence: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(),
    },
  };
  expect(await escalateAgedNeedsHuman(db as never, NOW)).toBe(0);
  expect(mockStanding).not.toHaveBeenCalled();
});
