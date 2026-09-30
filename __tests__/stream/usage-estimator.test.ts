/**
 * @jest-environment node
 */

/**
 * #E5 — the participant-minute / peak-concurrency estimator.
 *
 * Both figures are computed from `MeetingAttendance` rows we already store, and
 * both are UPPER BOUNDS. That is the correct direction for a ceiling alarm (see
 * the module docblock) and it is only correct if the arithmetic is, because an
 * estimator that under-counts is worse than no estimator: it silences the alarm
 * it exists to raise.
 *
 * So these cases pin the two ways a sweep-line goes wrong — double-counting
 * intervals that merely TOUCH, and counting a zero/negative length as a
 * contribution — and the two ways the end of an interval is chosen.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { meetingAttendance: { findMany: jest.fn() } },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import prisma from "../../lib/prisma";
import { estimateStreamUsage } from "../../lib/stream/usage-estimator";

const findMany = prisma.meetingAttendance.findMany as unknown as jest.Mock;

const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);
const at = (minutesFromT0: number) => new Date(T0 + minutesFromT0 * 60_000);

type Row = {
  firstJoinedAt: Date;
  lastLeftAt: Date | null;
  meeting: { endedAt: Date | null };
};

const row = (
  startMin: number,
  endMin: number | null,
  meetingEndedMin: number | null = null,
): Row => ({
  firstJoinedAt: at(startMin),
  lastLeftAt: endMin === null ? null : at(endMin),
  meeting: { endedAt: meetingEndedMin === null ? null : at(meetingEndedMin) },
});

function withRows(rows: Row[], nowMinutes = 10_000) {
  findMany.mockResolvedValue(rows);
  return new Date(T0 + nowMinutes * 60_000);
}

beforeEach(() => {
  jest.clearAllMocks();
  findMany.mockReset();
});

describe("estimateStreamUsage — participant-minutes (#E5)", () => {
  it("sums each participant's own interval", async () => {
    // 30 min + 60 min.
    const now = withRows([row(0, 30), row(0, 60)]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.participantMinutes).toBe(90);
  });

  it("counts to the MEETING's end when the participant never left", async () => {
    // A participant whose `lastLeftAt` never arrived (a lost `left` webhook, a
    // tab that closed) is counted to the end of the call rather than to now, so
    // one missing webhook cannot inflate the figure by the age of the table.
    const now = withRows([row(0, null, 45)]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.participantMinutes).toBe(45);
  });

  it("counts to NOW when neither the participant nor the call has ended", async () => {
    // The deliberate upper bound: an open call's occupants are billed against
    // the window until the call actually closes.
    const now = withRows([row(0, null, null)], 120);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.participantMinutes).toBe(120);
  });

  it("clamps a leave that precedes the join to zero, never negative", async () => {
    // A negative contribution to a bill is a bug in the estimator, and the bias
    // has to stay upward.
    const now = withRows([row(30, 10)]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.participantMinutes).toBe(0);
  });

  it("only looks at the trailing 30 days, and says so in the query", async () => {
    const now = withRows([]);
    await estimateStreamUsage(now);

    const [args] = findMany.mock.calls[0];
    // 30 days back, to the millisecond. The window is the billing window; a
    // wider one would report a month of usage for a month that has not happened.
    expect(args.where.firstJoinedAt.gte.getTime()).toBe(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
    // Newest first, so the row cap keeps the MOST RECENT activity rather than
    // an arbitrary slice, and the result set is bounded by the cap plus one row
    // so "did we hit it" is answerable without a second query.
    expect(args.orderBy).toEqual({ firstJoinedAt: "desc" });
    expect(args.take).toBe(20_001);
  });
});

describe("estimateStreamUsage — peak concurrency (#E5)", () => {
  it("finds the largest overlap, not the row count", async () => {
    // Three participants, never more than two at once: the first two overlap,
    // the third is a separate booking two hours later.
    const now = withRows([row(0, 100), row(10, 110), row(120, 130)]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.peakConcurrency).toBe(2);
  });

  it("does NOT count two intervals that merely TOUCH as overlapping", async () => {
    // A participant leaving exactly as another joins is not a second
    // simultaneous participant. Counting it would inflate the peak for every
    // back-to-back booking in the org's schedule — which is most of them.
    const now = withRows([row(0, 30), row(30, 60)]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.peakConcurrency).toBe(1);
    // Both are still billed, though.
    expect(snapshot.participantMinutes).toBe(60);
  });

  it("is zero for an empty window rather than undefined", async () => {
    const now = withRows([]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.peakConcurrency).toBe(0);
    expect(snapshot.participantMinutes).toBe(0);
  });
});

describe("estimateStreamUsage — the row cap is reported, never hidden (#E5)", () => {
  it("flags a truncated run so the figure reads as a FLOOR", async () => {
    // Over the cap. The most recent rows are the ones `orderBy desc` kept, so
    // the figure is a lower bound — and a quietly under-counted bill ceiling is
    // worse than a loud wrong one, because the alarm would not fire.
    const rows = Array.from({ length: 20_001 }, () => row(0, 1));
    findMany.mockResolvedValue(rows);

    const { snapshot, droppedRows, examinedRows } = await estimateStreamUsage(
      new Date(T0),
    );

    expect(droppedRows).toBe(1);
    expect(examinedRows).toBe(20_000);
    expect(snapshot.estimated).toBe(true);
    // `estimated` is the flag the health route surfaces, so a consumer can
    // refuse to treat a truncated night as a clean reading.
    expect(snapshot.estimated).not.toBe(false);
  });

  it("reports estimated:false on a normal night", async () => {
    const now = withRows([row(0, 30)]);
    const { snapshot } = await estimateStreamUsage(now);
    expect(snapshot.estimated).toBe(false);
  });
});
