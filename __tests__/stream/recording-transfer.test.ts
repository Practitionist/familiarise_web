/**
 * @jest-environment node
 */

/**
 * The copy job: a verified copy flips the row to AVAILABLE; any failure
 * (including a size mismatch after upload) deletes the object and returns the
 * row to READY with the attempt counted. The transfer path never writes FAILED.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));
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
