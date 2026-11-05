/**
 * The manual pre-lock probe asks about each picked interval, never the
 * envelope from the first to the last pick: a confirmed session that sits
 * between two picked sessions is not a conflict.
 */

const mockFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import {
  mergeContiguousIntervals,
  probeConfirmedOverlap,
} from "@/lib/booking/allocation/guards";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";

const MON_10 = "2030-01-07T10:00:00.000Z";
const MON_1030 = "2030-01-07T10:30:00.000Z";
const FRI_10 = "2030-01-11T10:00:00.000Z";
const FRI_1030 = "2030-01-11T10:30:00.000Z";

/** An in-memory occurrence store answering the probe's OR-arms like Postgres. */
function answerFrom(rows: Array<{ startsAt: Date; endsAt: Date }>) {
  mockFindFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { OR: Array<{ startsAt: { lt: Date }; endsAt: { gt: Date } }> };
    }) =>
      rows.find((row) =>
        where.OR.some(
          (arm) => row.startsAt < arm.startsAt.lt && row.endsAt > arm.endsAt.gt,
        ),
      ) ?? null,
  );
}

describe("probeConfirmedOverlap — one arm per picked interval", () => {
  beforeEach(() => mockFindFirst.mockReset());

  it("merges contiguous atoms into whole sessions", () => {
    expect(
      mergeContiguousIntervals([FRI_1030, MON_10, FRI_10, MON_1030]).map(
        (i) => [i.start.toISOString(), i.end.toISOString()],
      ),
    ).toEqual([
      [MON_10, "2030-01-07T11:00:00.000Z"],
      [FRI_10, "2030-01-11T11:00:00.000Z"],
    ]);
  });

  it("does not refuse a session that sits between two picked sessions", async () => {
    // Another client's confirmed Wednesday 10:00 session.
    answerFrom([
      {
        startsAt: new Date("2030-01-09T10:00:00.000Z"),
        endsAt: new Date("2030-01-09T11:00:00.000Z"),
      },
    ]);
    await expect(
      probeConfirmedOverlap("cp-1", "subscription", "sub-1", [
        MON_10,
        MON_1030,
        FRI_10,
        FRI_1030,
      ]),
    ).resolves.toBeUndefined();
    const { where } = mockFindFirst.mock.calls[0][0];
    expect(where.OR).toHaveLength(2);
    expect(where.startsAt).toBeUndefined();
  });

  it("refuses a picked session that overlaps a confirmed one, without an ISO in the copy", async () => {
    answerFrom([
      {
        startsAt: new Date("2030-01-11T10:30:00.000Z"),
        endsAt: new Date("2030-01-11T11:30:00.000Z"),
      },
    ]);
    const refusal = await probeConfirmedOverlap(
      "cp-1",
      "subscription",
      "sub-1",
      [MON_10, MON_1030, FRI_10, FRI_1030],
    ).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AllocationConflictError);
    const error = refusal as AllocationConflictError;
    expect(error.errorCode).toBe("SLOT_TAKEN");
    expect(error.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(error.details).toEqual({ takenStartsAt: FRI_1030 });
  });

  it("keeps rows of other event types (NULL relation) in scope", async () => {
    answerFrom([]);
    await probeConfirmedOverlap("cp-1", "subscription", "sub-1", [MON_10]);
    expect(mockFindFirst.mock.calls[0][0].where.appointment).toEqual({
      OR: [{ subscriptionId: null }, { subscriptionId: { not: "sub-1" } }],
    });
  });
});
