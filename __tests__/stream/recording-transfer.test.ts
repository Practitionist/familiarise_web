/**
 * @jest-environment node
 */

/** A verified copy publishes AVAILABLE; failures release only the matching claim. */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateManyAndReturn: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $disconnect: jest.fn(),
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
  isR2Configured: () => false,
}));

import prisma from "../../lib/prisma";
import { RecordingStatus, RecordingStorageType } from "@prisma/client";
import { reportSentryMessage } from "../../lib/observability/report";
import {
  deleteR2Object,
  headR2Object,
  streamMultipartToR2,
} from "../../lib/storage/r2-client";
import {
  MAX_TRANSFER_ATTEMPTS,
  isAllowedStreamRecordingUrl,
  transferRecording,
  transferRecordings,
  transferRetryBackoffMs,
} from "../../lib/stream/recording-transfer-service";

const recording = (
  prisma as unknown as {
    recording: {
      updateMany: jest.Mock;
      updateManyAndReturn: jest.Mock;
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
  recording.updateManyAndReturn.mockImplementation(
    async ({ where }: { where: { id: string } }) => [
      {
        id: where.id,
        recordingUrl: STREAM_URL,
        transferAttempts: 1,
        updatedAt: new Date("2026-10-22T10:00:00.000Z"),
      },
    ],
  );
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
    const completion = dataOf(0);
    expect(completion.where).toMatchObject({
      id: "rec-1",
      status: "TRANSFERRING",
      transferAttempts: 1,
      updatedAt: new Date("2026-10-22T10:00:00.000Z"),
    });
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
    const failure = dataOf(0);
    expect(failure.where).toMatchObject({
      id: "rec-1",
      status: "TRANSFERRING",
      transferAttempts: 1,
    });
    expect(failure.data).toMatchObject({
      status: "READY",
      lastTransferError: expect.any(String),
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
    recording.updateManyAndReturn.mockResolvedValueOnce([]);
    await expect(transferRecording("rec-1")).resolves.toEqual({
      status: "skipped",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("recording claim ownership", () => {
  it.each([
    {
      failure: "unsuccessful delete result",
      arrange: () =>
        jest.mocked(deleteR2Object).mockResolvedValueOnce({
          success: false,
          error: "R2 DELETE failed (503 Service Unavailable)",
        }),
    },
    {
      failure: "delete rejection",
      arrange: () =>
        jest
          .mocked(deleteR2Object)
          .mockRejectedValueOnce(new Error("delete reset")),
    },
  ])(
    "fails lost-publication cleanup on $failure without releasing the row",
    async ({ arrange }) => {
      jest.mocked(headR2Object).mockResolvedValueOnce({ contentLength: 100 });
      recording.updateMany.mockResolvedValueOnce({ count: 0 });
      arrange();

      await expect(
        transferRecording("lost-publication"),
      ).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining(
          "Unpublished recording attempt cleanup failed",
        ),
      });
      expect(deleteR2Object).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "recordings/lost-publication/attempt-1.mp4",
        }),
      );
      expect(recording.updateMany).toHaveBeenCalledTimes(1);
      expect(dataOf(0).data).toMatchObject({ status: "AVAILABLE" });
    },
  );

  it.each([{ success: true }, { success: true, notFound: true }])(
    "skips lost-publication cleanup only after a confirmed delete: %j",
    async (deleted) => {
      jest.mocked(headR2Object).mockResolvedValueOnce({ contentLength: 100 });
      recording.updateMany.mockResolvedValueOnce({ count: 0 });
      jest.mocked(deleteR2Object).mockResolvedValueOnce(deleted);

      await expect(transferRecording("lost-publication")).resolves.toEqual({
        status: "skipped",
      });
      expect(recording.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("fails the lost-publication run when deletion of its object is unconfirmed", async () => {
    recording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "lost-publication" }])
      .mockResolvedValueOnce([]);
    jest.mocked(headR2Object).mockResolvedValueOnce({ contentLength: 100 });
    recording.updateMany.mockResolvedValueOnce({ count: 0 });
    jest.mocked(deleteR2Object).mockResolvedValueOnce({
      success: false,
      error: "R2 DELETE failed (503 Service Unavailable)",
    });

    await expect(transferRecordings()).resolves.toMatchObject({
      success: false,
      processed: 1,
      failed: 1,
      succeeded: 0,
      errors: [
        expect.stringContaining("Unpublished recording attempt cleanup failed"),
      ],
    });
    expect(recording.updateMany).toHaveBeenCalledTimes(1);
  });

  it("cannot publish or delete a newer worker's object after its claim was reclaimed", async () => {
    let finishOld: (value: {
      key: string;
      size: number;
      parts: number;
    }) => void = () => {
      throw new Error("Old upload did not start");
    };
    const oldUpload = new Promise<{ key: string; size: number; parts: number }>(
      (resolve) => {
        finishOld = resolve;
      },
    );
    recording.updateManyAndReturn
      .mockResolvedValueOnce([
        {
          id: "rec-race",
          recordingUrl: STREAM_URL,
          transferAttempts: 1,
          updatedAt: new Date("2026-10-22T10:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "rec-race",
          recordingUrl: STREAM_URL,
          transferAttempts: 2,
          updatedAt: new Date("2026-10-22T10:20:00Z"),
        },
      ]);
    (streamMultipartToR2 as jest.Mock).mockReturnValueOnce(oldUpload);
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });
    const oldRun = transferRecording("rec-race");
    await new Promise(setImmediate);
    expect(streamMultipartToR2).toHaveBeenCalledTimes(1);
    recording.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(transferRecording("rec-race")).resolves.toEqual({
      status: "copied",
    });
    finishOld({ key: "k", size: 100, parts: 1 });
    await expect(oldRun).resolves.toEqual({ status: "skipped" });
    expect(dataOf(0).where).toMatchObject({
      transferAttempts: 2,
      updatedAt: new Date("2026-10-22T10:20:00Z"),
    });
    expect(dataOf(1).where).toMatchObject({
      transferAttempts: 1,
      updatedAt: new Date("2026-10-22T10:00:00Z"),
    });
    expect(deleteR2Object).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "recordings/rec-race/attempt-2.mp4" }),
    );
  });

  it("does not copy a successfully published recording on sequential replay", async () => {
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });
    recording.updateManyAndReturn
      .mockResolvedValueOnce([
        {
          id: "replay",
          recordingUrl: STREAM_URL,
          transferAttempts: 1,
          updatedAt: new Date("2026-10-22T10:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([]);
    await expect(transferRecording("replay")).resolves.toEqual({
      status: "copied",
    });
    await expect(transferRecording("replay")).resolves.toEqual({
      status: "skipped",
    });
    expect(streamMultipartToR2).toHaveBeenCalledTimes(1);
  });

  it("cannot publish after the recording is removed while a copy is in flight", async () => {
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });
    recording.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(transferRecording("expired-during-copy")).resolves.toEqual({
      status: "skipped",
    });
    expect(dataOf(0).where).toMatchObject({
      id: "expired-during-copy",
      status: "TRANSFERRING",
      transferAttempts: 1,
    });
    expect(deleteR2Object).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "recordings/expired-during-copy/attempt-1.mp4",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(recording.updateMany).toHaveBeenCalledTimes(1);
  });

  it("counts the attempt atomically when claiming, including a later crashed copy", async () => {
    recording.updateManyAndReturn.mockResolvedValueOnce([]);
    await transferRecording("claimed-by-another-worker");
    expect(recording.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "READY",
          streamUrlExpiresAt: { gt: expect.any(Date) },
        }),
        data: { status: "TRANSFERRING", transferAttempts: { increment: 1 } },
      }),
    );
    expect(streamMultipartToR2).not.toHaveBeenCalled();
  });
});

describe("transferRecordings", () => {
  it.each([0, 11])(
    "keeps a crashed claim consumed through stale reclaim from %i prior attempts",
    async (priorAttempts) => {
      jest.useFakeTimers({ doNotFake: ["setTimeout", "clearTimeout"] });
      jest.setSystemTime(new Date("2026-10-25T00:00:00Z"));
      const row = {
        id: "crashed",
        status: RecordingStatus.READY,
        storageType: RecordingStorageType.STREAM_S3,
        transferAttempts: priorAttempts,
        updatedAt: new Date(),
        recordingUrl: STREAM_URL,
      };
      let databaseUnavailable = true;
      const claimedAttempts: number[] = [];
      recording.updateManyAndReturn.mockImplementation(async ({ data }) => {
        if (row.status !== RecordingStatus.READY) return [];
        row.status = data.status;
        row.transferAttempts += data.transferAttempts.increment;
        claimedAttempts.push(row.transferAttempts);
        row.updatedAt = new Date();
        return [{ ...row }];
      });
      recording.updateMany.mockImplementation(async ({ where, data }) => {
        if (databaseUnavailable)
          throw new Error("process lost database connection");
        if (
          where.status !== row.status ||
          (where.updatedAt &&
            where.updatedAt.getTime() !== row.updatedAt.getTime())
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      });
      recording.findMany.mockImplementation(async ({ where, take }) => {
        if (where.status !== row.status) return [];
        if (take === 100) return row.transferAttempts >= 3 ? [{ ...row }] : [];
        if (
          where.status === RecordingStatus.READY &&
          row.transferAttempts >= MAX_TRANSFER_ATTEMPTS
        )
          return [];
        return [{ ...row }];
      });
      jest.mocked(headR2Object).mockResolvedValue({ contentLength: 100 });
      try {
        await expect(transferRecording(row.id)).rejects.toThrow(
          "lost database connection",
        );
        expect(row.status).toBe(RecordingStatus.TRANSFERRING);
        expect(row.transferAttempts).toBe(priorAttempts + 1);
        const firstClaimAt = row.updatedAt;
        databaseUnavailable = false;
        jest.setSystemTime(new Date(Date.now() + 20 * 60 * 1000));
        const result = await transferRecordings();
        expect(result).toMatchObject({
          reclaimedStale: 1,
          succeeded: priorAttempts === 0 ? 1 : 0,
        });
        expect(recording.updateMany.mock.calls[2][0].data).toEqual({
          status: RecordingStatus.READY,
          updatedAt: firstClaimAt,
        });
        expect(claimedAttempts).toEqual(priorAttempts === 0 ? [1, 2] : [12]);
        const expectedKeys =
          priorAttempts === 0
            ? [
                "recordings/crashed/attempt-1.mp4",
                "recordings/crashed/attempt-2.mp4",
              ]
            : ["recordings/crashed/attempt-12.mp4"];
        expect(
          jest
            .mocked(streamMultipartToR2)
            .mock.calls.map(([input]) => input.key),
        ).toEqual(expectedKeys);
        expect(row.status).toBe(
          priorAttempts === 0
            ? RecordingStatus.AVAILABLE
            : RecordingStatus.READY,
        );
        expect(result.exhaustedReported).toBe(priorAttempts === 11 ? 1 : 0);
        expect(recording.updateManyAndReturn).toHaveBeenCalledTimes(
          priorAttempts === 11 ? 1 : 2,
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it("alarms once for near-expiry and repeated-attempt READY sources even when the copy slice is empty", async () => {
    recording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "near-expiry", transferAttempts: 0 },
        { id: "repeated", transferAttempts: 3 },
      ]);
    const result = await transferRecordings();
    expect(result).toMatchObject({
      success: true,
      processed: 0,
      exhaustedReported: 0,
    });
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    expect(recording.findMany.mock.calls[2][0]).toMatchObject({
      where: {
        status: "READY",
        storageType: "STREAM_S3",
        streamUrlExpiresAt: { gt: expect.any(Date) },
        AND: [
          {
            OR: [
              { transferFailureAlertedAt: null },
              { transferFailureAlertedAt: { lte: expect.any(Date) } },
            ],
          },
        ],
        OR: [
          { streamUrlExpiresAt: { lte: expect.any(Date) } },
          { transferAttempts: { gte: 3 } },
        ],
      },
      take: 100,
    });
    const horizon =
      recording.findMany.mock.calls[2][0].where.OR[0].streamUrlExpiresAt.lte;
    expect(horizon.getTime() - Date.now()).toBeGreaterThan(
      72 * 60 * 60 * 1000 - 1000,
    );
    expect(recording.updateMany).toHaveBeenCalledTimes(2);
  });

  it("conditionally claims each alarm without changing retry time and suppresses a lost claim", async () => {
    const updatedAt = new Date("2026-10-25T00:00:00Z");
    const candidates = [{ id: "risk", transferAttempts: 3, updatedAt }];
    recording.findMany.mockImplementation(async ({ select }) =>
      select?.lastTransferError ? candidates : [],
    );
    await transferRecordings();
    const claim = dataOf(0);
    expect(claim.where).toMatchObject({
      id: "risk",
      status: "READY",
      storageType: "STREAM_S3",
      updatedAt,
      streamUrlExpiresAt: { gt: expect.any(Date) },
      OR: [
        { transferFailureAlertedAt: null },
        { transferFailureAlertedAt: { lte: expect.any(Date) } },
      ],
    });
    expect(claim.data.updatedAt).toEqual(updatedAt);
    const stamp =
      recording.updateMany.mock.calls[0][0].data.transferFailureAlertedAt;
    const cooldown =
      recording.updateMany.mock.calls[0][0].where.OR[1].transferFailureAlertedAt
        .lte;
    expect(stamp.getTime() - cooldown.getTime()).toBe(6 * 60 * 60 * 1000);
    recording.updateMany.mockResolvedValueOnce({ count: 0 });
    await transferRecordings();
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  });
  it("drains 25 obligations across 25 one-copy invocations", async () => {
    (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });
    for (let index = 0; index < 25; index++) {
      recording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: `recording-${index}` }])
        .mockResolvedValueOnce([]);
      const result = await transferRecordings();
      expect(result).toMatchObject({
        success: true,
        processed: 1,
        succeeded: 1,
      });
    }
    expect(streamMultipartToR2).toHaveBeenCalledTimes(25);
    expect(
      recording.updateManyAndReturn.mock.calls.map(([arg]) => arg.where.id),
    ).toEqual(Array.from({ length: 25 }, (_, index) => `recording-${index}`));
    const queries = recording.findMany.mock.calls.filter(
      (_, index) => index % 3 === 1,
    );
    for (const [query] of queries) {
      expect(query.take).toBe(1);
      expect(query.where.OR).toContainEqual({ transferAttempts: 0 });
      expect(query.where.streamUrlExpiresAt.gt).toBeInstanceOf(Date);
    }
  });

  it("bounds stale reclamation and checks the stale predicate again before releasing claims", async () => {
    const claimedAt = new Date("2026-10-22T09:00:00.000Z");
    recording.findMany.mockResolvedValueOnce([
      { id: "a", updatedAt: claimedAt },
    ]);
    recording.updateMany.mockResolvedValueOnce({ count: 1 });
    const result = await transferRecordings();
    expect(result.reclaimedStale).toBe(1);
    expect(recording.findMany.mock.calls[0][0]).toMatchObject({ take: 1 });
    expect(dataOf(0).where).toMatchObject({
      id: "a",
      status: "TRANSFERRING",
      updatedAt: claimedAt,
    });
    expect(dataOf(0).data.updatedAt).toEqual(claimedAt);
  });

  it("records a retryable copy failure as an unsuccessful execution", async () => {
    recording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "x" }]);
    (streamMultipartToR2 as jest.Mock).mockRejectedValueOnce(
      new Error("reset"),
    );
    const result = await transferRecordings();
    expect(result).toMatchObject({ success: false, processed: 1, failed: 1 });
  });

  it("reports exhausted rows once per run and stamps them", async () => {
    recording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "a",
          transferAttempts: 12,
          transferFailureAlertedAt: null,
          lastTransferError: "x",
        },
        {
          id: "b",
          transferAttempts: 12,
          transferFailureAlertedAt: null,
          lastTransferError: "y",
        },
      ]);
    const result = await transferRecordings();
    expect(result).toMatchObject({ success: false, exhaustedReported: 2 });
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    expect(dataOf(0).where).toMatchObject({ id: "a" });
    expect(dataOf(1).where).toMatchObject({ id: "b" });
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

it("uses attempt-scoped R2 keys (attempt-N.mp4), cleans up prior attempts on success, and spaces 12 retry attempts with exponential backoff", async () => {
  (headR2Object as jest.Mock).mockResolvedValue({ contentLength: 100 });
  recording.updateManyAndReturn.mockResolvedValueOnce([
    {
      id: "rec-det",
      recordingUrl: STREAM_URL,
      transferAttempts: 3,
      updatedAt: new Date("2026-10-22T10:00:00.000Z"),
    },
  ]);

  await transferRecording("rec-det");

  expect(streamMultipartToR2).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "recordings/rec-det/attempt-3.mp4",
    }),
  );
  expect(deleteR2Object).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "recordings/rec-det/attempt-1.mp4",
    }),
  );
  expect(deleteR2Object).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "recordings/rec-det/attempt-2.mp4",
    }),
  );
  expect(deleteR2Object).not.toHaveBeenCalledWith(
    expect.objectContaining({
      key: "recordings/rec-det/attempt-3.mp4",
    }),
  );
  expect(MAX_TRANSFER_ATTEMPTS).toBe(12);
  expect(transferRetryBackoffMs(0)).toBe(0);
  expect(transferRetryBackoffMs(1)).toBe(15 * 60 * 1000);
  expect(transferRetryBackoffMs(2)).toBe(60 * 60 * 1000);
  expect(transferRetryBackoffMs(3)).toBe(6 * 60 * 60 * 1000);
  expect(transferRetryBackoffMs(4)).toBe(24 * 60 * 60 * 1000);
  expect(transferRetryBackoffMs(11)).toBe(24 * 60 * 60 * 1000);
});

it("keeps a stuck source quiet until its six-hour alarm cooldown elapses", async () => {
  jest.useFakeTimers({ doNotFake: ["setTimeout", "clearTimeout"] });
  jest.setSystemTime(new Date("2026-10-25T00:00:00Z"));
  let alertedAt: Date | null = null;
  const updatedAt = new Date("2026-10-24T00:00:00Z");
  try {
    recording.findMany.mockImplementation(async ({ select }) =>
      select?.lastTransferError
        ? [{ id: "stuck", transferAttempts: 3, updatedAt }]
        : [],
    );
    recording.updateMany.mockImplementation(async ({ where, data }) => {
      const cooldown = where.OR[1].transferFailureAlertedAt.lte;
      if (alertedAt && alertedAt > cooldown) return { count: 0 };
      alertedAt = data.transferFailureAlertedAt;
      return { count: 1 };
    });
    await transferRecordings();
    jest.setSystemTime(new Date("2026-10-25T05:59:59Z"));
    await transferRecordings();
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date("2026-10-25T06:00:00Z"));
    await transferRecordings();
    expect(reportSentryMessage).toHaveBeenCalledTimes(2);
    for (const [arg] of recording.updateMany.mock.calls)
      expect(arg.data.updatedAt).toEqual(updatedAt);
    expect(
      recording.findMany.mock.calls[8][0].where.streamUrlExpiresAt.gt,
    ).toEqual(new Date("2026-10-25T06:00:00Z"));
  } finally {
    jest.useRealTimers();
  }
});
