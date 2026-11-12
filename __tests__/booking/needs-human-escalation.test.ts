/**
 * @jest-environment node
 */

/**
 * A session parked for ops more than 7 days is escalated once per new id per
 * day, naming how many hold an ended plan's settlement, and the ops list shows
 * those sessions first so its cap never hides them. No money moves.
 */

const mockStanding = jest.fn(
  async (_args: unknown, report?: () => void): Promise<boolean> => {
    report?.();
    return true;
  },
);
const mockSentry = jest.fn();
const mockFindMany = jest.fn();

jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: (args: unknown, report?: () => void) =>
    mockStanding(args, report),
}));
jest.mock("../../lib/observability/report", () => ({
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryMessage: (...a: unknown[]) => mockSentry(...a),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
    },
  },
}));

import {
  agedNeedsHumanWhere,
  NEEDS_HUMAN,
  NEEDS_HUMAN_ESCALATE_DAYS,
} from "@/lib/booking/misses";
import { escalateAgedNeedsHuman } from "@/lib/booking/session-outcome-sweep";
import { readSessionsNeedingHuman } from "@/lib/backoffice/session-outcomes";

const NOW = new Date("2026-11-09T12:00:00Z");
const CUTOFF = new Date(NOW.getTime() - 7 * 24 * 3_600_000);

beforeEach(() => jest.clearAllMocks());

it("ages from the verdict, or from the call's end when none was written", () => {
  expect(NEEDS_HUMAN_ESCALATE_DAYS).toBe(7);
  expect(agedNeedsHumanWhere(NOW)).toEqual({
    AND: [
      NEEDS_HUMAN,
      {
        OR: [
          { outcomeAt: { lt: CUTOFF } },
          { outcomeAt: null, endsAt: { lt: CUTOFF } },
        ],
      },
    ],
  });
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

it("lists aged sessions first, so the cap never hides them", async () => {
  mockFindMany
    .mockResolvedValueOnce([{ id: "old-1" }])
    .mockResolvedValueOnce([{ id: "new-1" }, { id: "new-2" }]);

  const items = await readSessionsNeedingHuman(3, NOW);

  expect(items.map((i) => [i.id, i.aged])).toEqual([
    ["old-1", true],
    ["new-1", false],
    ["new-2", false],
  ]);
  const calls = mockFindMany.mock.calls as unknown as [
    { where: unknown; orderBy: unknown; take: number },
  ][];
  expect(calls[0][0]).toMatchObject({
    where: agedNeedsHumanWhere(NOW),
    orderBy: { endsAt: "asc" },
    take: 3,
  });
  expect(calls[1][0]).toMatchObject({
    where: { AND: [NEEDS_HUMAN, { id: { notIn: ["old-1"] } }] },
    take: 2,
  });
});
