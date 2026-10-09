/**
 * @jest-environment node
 */

/**
 * A verified copy flips the row to AVAILABLE; any failure deletes the object
 * and returns the row to READY with the attempt counted, never FAILED.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $disconnect: jest.fn(),
  },
}));
jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(),
}));
jest.mock("../../lib/observability/job-sentry", () => ({ runJob: jest.fn() }));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/storage/r2-client", () => ({
  streamMultipartToR2: jest.fn(),
  headR2Object: jest.fn(),
  deleteR2Object: jest.fn().mockResolvedValue({ success: true }),
}));

import prisma from "../../lib/prisma";
import { runJob } from "../../lib/observability/job-sentry";
import { reportSentryMessage } from "../../lib/observability/report";
import {
  deleteR2Object,
  headR2Object,
  streamMultipartToR2,
} from "../../lib/storage/r2-client";
import {
  isAllowedStreamRecordingUrl,
  transferRecording,
  transferRecordings,
} from "../../lib/stream/recording-transfer-service";

const recording = (
  prisma as unknown as {
    recording: {
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
  }
).recording;
const STREAM_URL = "https://us-east.stream-io-cdn.com/rec_1.mp4";

function streamResponse(contentLength: string | null) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream<Uint8Array>(),
    headers: {
      get: (h: string) =>
        h === "content-length"
          ? contentLength
          : h === "content-type"
            ? "video/mp4"
            : null,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  recording.updateMany.mockResolvedValue({ count: 1 });
  recording.findUnique.mockResolvedValue({ recordingUrl: STREAM_URL });
  recording.findMany.mockResolvedValue([]);
  (streamMultipartToR2 as jest.Mock).mockResolvedValue({
    key: "k",
    size: 100,
    parts: 1,
  });
  global.fetch = jest
    .fn()
    .mockResolvedValue(streamResponse("100")) as unknown as typeof fetch;
});

const dataOf = (call: number) =>
  recording.updateMany.mock.calls[call][0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };

describe("transferRecording", () => {
  it("marks the row AVAILABLE once the stored size matches the streamed and source bytes", async () => {
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });

    await expect(transferRecording("rec-1")).resolves.toEqual({
      status: "copied",
    });
    const completion = dataOf(1);
    expect(completion.where).toEqual({ id: "rec-1", status: "TRANSFERRING" });
    expect(completion.data).toMatchObject({
      status: "AVAILABLE",
      storageType: "PLATFORM",
      fileSize: BigInt(100),
    });
    expect(deleteR2Object).not.toHaveBeenCalled();
  });

  it("hands the copy's abort signal to every R2 call so the timeout cancels uploads too", async () => {
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });

    await transferRecording("rec-1");

    const fetchSignal = (global.fetch as jest.Mock).mock.calls[0][1]
      .signal as AbortSignal;
    expect(fetchSignal).toBeInstanceOf(AbortSignal);
    expect(streamMultipartToR2).toHaveBeenCalledWith(
      expect.objectContaining({ signal: fetchSignal }),
    );
    expect(headR2Object).toHaveBeenCalledWith(
      expect.objectContaining({ signal: fetchSignal }),
    );
  });

  it("deletes the object and leaves the row READY when the stored size differs", async () => {
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 99 });

    const outcome = await transferRecording("rec-1");

    expect(outcome.status).toBe("failed");
    expect(deleteR2Object).toHaveBeenCalledTimes(1);
    const failure = dataOf(1);
    expect(failure.where).toEqual({ id: "rec-1", status: "TRANSFERRING" });
    expect(failure.data).toMatchObject({
      status: "READY",
      transferAttempts: { increment: 1 },
    });
    expect(String(failure.data.lastTransferError)).toMatch(/Size mismatch/);
  });

  it("fails on a source Content-Length mismatch and never writes FAILED", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(streamResponse("120")) as unknown as typeof fetch;
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });

    expect((await transferRecording("rec-1")).status).toBe("failed");
    const statuses = recording.updateMany.mock.calls.map(
      ([arg]) => (arg as { data: { status?: string } }).data.status,
    );
    expect(statuses).not.toContain("FAILED");
  });

  it("skips a row it cannot claim", async () => {
    recording.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(transferRecording("rec-1")).resolves.toEqual({
      status: "skipped",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("transferRecordings", () => {
  type CandidateQuery = {
    where: { id?: unknown; OR?: unknown };
    take: number;
    orderBy?: unknown;
  };
  const candidateQueries = () =>
    recording.findMany.mock.calls
      .map((c) => c[0] as CandidateQuery)
      .filter((q) => q.orderBy !== undefined);

  it("keeps fetching keyset pages until the backlog is empty, never retrying a row", async () => {
    const tX = new Date("2026-10-10T00:00:00.000Z");
    const tY = new Date("2026-10-11T00:00:00.000Z");
    recording.updateMany.mockResolvedValue({ count: 0 });
    recording.findMany
      .mockResolvedValueOnce([{ id: "x", streamUrlExpiresAt: tX }])
      .mockResolvedValueOnce([{ id: "y", streamUrlExpiresAt: tY }]);

    await transferRecordings();

    const queries = candidateQueries();
    expect(queries).toHaveLength(3);
    // The filter stays constant-size: no growing id list.
    for (const q of queries) expect(q.where.id).toBeUndefined();
    expect(queries[0].where.OR).toBeUndefined();
    expect(queries[1].where.OR).toEqual([
      { streamUrlExpiresAt: { gt: tX } },
      { streamUrlExpiresAt: tX, id: { gt: "x" } },
    ]);
    expect(queries[2].where.OR).toEqual([
      { streamUrlExpiresAt: { gt: tY } },
      { streamUrlExpiresAt: tY, id: { gt: "y" } },
    ]);
  });

  it("logs how many stale claims the run reclaimed", async () => {
    recording.updateMany.mockResolvedValueOnce({ count: 3 });

    const result = await transferRecordings();

    expect(result.reclaimedStale).toBe(3);
  });

  it("stops at an explicit row limit", async () => {
    recording.updateMany.mockResolvedValue({ count: 0 });
    recording.findMany.mockResolvedValueOnce([
      { id: "x", streamUrlExpiresAt: new Date("2026-10-10T00:00:00.000Z") },
    ]);

    await transferRecordings({ limit: 1 });

    const queries = candidateQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0].take).toBe(1);
  });

  it("reports exhausted rows to Sentry once per run and stamps them", async () => {
    recording.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "a", lastTransferError: "x" },
      { id: "b", lastTransferError: "y" },
    ]);

    const result = await transferRecordings();

    expect(result.exhaustedReported).toBe(2);
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    const stamp = recording.updateMany.mock.calls.at(-1)?.[0] as {
      where: { id: { in: string[] } };
    };
    expect(stamp.where.id.in).toEqual(["a", "b"]);
  });
});

describe("transfer-recordings job", () => {
  it("fails the run for exhausted rows but not for a copy that will retry", async () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    await import("../../jobs/stream/transfer-recordings");
    const job = (runJob as jest.Mock).mock.calls[0][1] as () => Promise<void>;
    const priorExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      recording.findMany
        .mockResolvedValueOnce([{ id: "c" }])
        .mockResolvedValueOnce([]);
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("reset")) as unknown as typeof fetch;
      await job();
      expect(process.exitCode).toBeUndefined();

      recording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "a", lastTransferError: "x" }]);
      await job();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});

it("validates Stream recording URLs against the SSRF host allowlist", () => {
  expect(isAllowedStreamRecordingUrl(STREAM_URL)).toBe(true);
  expect(
    isAllowedStreamRecordingUrl(
      "https://stream-recordings.s3.us-east-1.amazonaws.com/rec_1.mp4",
    ),
  ).toBe(true);
  expect(
    isAllowedStreamRecordingUrl("http://us-east.stream-io-cdn.com/rec_1.mp4"),
  ).toBe(false);
  expect(
    isAllowedStreamRecordingUrl("https://169.254.169.254/latest/meta-data/"),
  ).toBe(false);
});
