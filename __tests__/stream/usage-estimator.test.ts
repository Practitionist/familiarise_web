/**
 * @jest-environment node
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meetingPresence: {
      findMany: jest.fn(),
    },
  },
}));

import prisma from "../../lib/prisma";
import {
  estimateStreamVideoUsage,
  MAX_INTERVAL_MINUTES,
  RATE_PER_1000_PM_480P_USD,
  RATE_PER_1000_PM_720P_USD,
} from "../../lib/stream/usage-estimator";

const mockFindMany = (
  prisma as unknown as { meetingPresence: { findMany: jest.Mock } }
).meetingPresence.findMany;

describe("estimateStreamVideoUsage", () => {
  const from = new Date("2026-10-01T00:00:00.000Z");
  const to = new Date("2026-10-31T23:59:59.999Z");
  const now = new Date("2026-10-15T12:00:00.000Z");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("queries MeetingPresence within [from, to] and aggregates 1:1 vs group minutes and cost", async () => {
    mockFindMany.mockResolvedValue([
      {
        joinedAt: new Date("2026-10-02T10:00:00.000Z"),
        leftAt: new Date("2026-10-02T11:00:00.000Z"), // 60m 1:1
        meeting: { endedAt: new Date("2026-10-02T11:00:00.000Z") },
        occurrence: {
          endsAt: new Date("2026-10-02T11:00:00.000Z"),
          appointment: {
            consultationId: "cons-1",
            subscriptionId: null,
            webinarId: null,
            classId: null,
          },
        },
      },
      {
        joinedAt: new Date("2026-10-03T14:00:00.000Z"),
        leftAt: new Date("2026-10-03T15:30:00.000Z"), // 90m webinar
        meeting: { endedAt: new Date("2026-10-03T15:30:00.000Z") },
        occurrence: {
          endsAt: new Date("2026-10-03T15:30:00.000Z"),
          appointment: {
            consultationId: null,
            subscriptionId: null,
            webinarId: "web-1",
            classId: null,
          },
        },
      },
    ]);

    const estimate = await estimateStreamVideoUsage({ from, to, now });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        joinedAt: { lte: to },
      },
      include: {
        meeting: { select: { endedAt: true } },
        occurrence: {
          select: {
            endsAt: true,
            appointment: {
              select: {
                consultationId: true,
                subscriptionId: true,
                webinarId: true,
                classId: true,
              },
            },
          },
        },
      },
    });

    expect(estimate.totalIntervals).toBe(2);
    expect(estimate.oneOnOneParticipantMinutes).toBe(60);
    expect(estimate.groupParticipantMinutes).toBe(90);
    expect(estimate.totalParticipantMinutes).toBe(150);

    const expectedCost =
      (60 / 1000) * RATE_PER_1000_PM_480P_USD +
      (90 / 1000) * RATE_PER_1000_PM_720P_USD;
    expect(estimate.estimatedCostUsd).toBeCloseTo(expectedCost, 4);
  });

  it("falls back to meeting.endedAt, occurrence.endsAt, then now when leftAt is null, and caps at MAX_INTERVAL_MINUTES", async () => {
    mockFindMany.mockResolvedValue([
      {
        // Falls back to meeting.endedAt (30m)
        joinedAt: new Date("2026-10-05T10:00:00.000Z"),
        leftAt: null,
        meeting: { endedAt: new Date("2026-10-05T10:30:00.000Z") },
        occurrence: {
          endsAt: new Date("2026-10-05T11:00:00.000Z"),
          appointment: {
            consultationId: null,
            subscriptionId: "sub-1",
            webinarId: null,
            classId: null,
          },
        },
      },
      {
        // Falls back to occurrence.endsAt (45m)
        joinedAt: new Date("2026-10-06T10:00:00.000Z"),
        leftAt: null,
        meeting: { endedAt: null },
        occurrence: {
          endsAt: new Date("2026-10-06T10:45:00.000Z"),
          appointment: {
            consultationId: null,
            subscriptionId: null,
            webinarId: null,
            classId: "cls-1",
          },
        },
      },
      {
        // Runaway interval > 240m capped at MAX_INTERVAL_MINUTES
        joinedAt: new Date("2026-10-15T00:00:00.000Z"),
        leftAt: null,
        meeting: { endedAt: null },
        occurrence: {
          endsAt: null,
          appointment: {
            consultationId: "cons-2",
            subscriptionId: null,
            webinarId: null,
            classId: null,
          },
        },
      },
    ]);

    const estimate = await estimateStreamVideoUsage({ from, to, now });

    expect(estimate.oneOnOneParticipantMinutes).toBe(30 + MAX_INTERVAL_MINUTES);
    expect(estimate.groupParticipantMinutes).toBe(45);
    expect(estimate.totalParticipantMinutes).toBe(
      30 + MAX_INTERVAL_MINUTES + 45,
    );
  });
});
