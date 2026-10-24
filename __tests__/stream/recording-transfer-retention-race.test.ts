/** @jest-environment node */

import { RecordingStatus } from "@prisma/client";

const mockFindMany = jest.fn();
const mockClaim = jest.fn();
const mockUpdate = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: { findMany: () => Promise.resolve([]) },
    recording: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      updateMany: (...args: unknown[]) => mockUpdate(...args),
      updateManyAndReturn: (...args: unknown[]) => mockClaim(...args),
    },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, run: () => unknown) => run(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock("../../lib/storage/r2-client", () => ({
  streamMultipartToR2: jest.fn(),
  headR2Object: jest.fn().mockResolvedValue({ contentLength: 100 }),
  deleteR2Object: jest.fn().mockResolvedValue({ success: true }),
}));

import { transferRecording } from "../../lib/stream/recording-transfer-service";
import { expireRecordings } from "../../lib/stream/recording-retention";
import { deleteRecordingAssets } from "../../lib/stream/recording-storage";
import {
  streamMultipartToR2,
  deleteR2Object,
} from "../../lib/storage/r2-client";

const oldDate = new Date("2000-01-01T00:00:00Z");
const candidate = {
  id: "race",
  recordedAt: oldDate,
  organizationId: null,
  organization: null,
  meeting: {
    endedAt: oldDate,
    occurrence: {
      endsAt: oldDate,
      appointment: {
        consultationId: "c",
        webinarId: null,
        classId: null,
        subscription: null,
        trial: null,
        occurrences: [],
      },
    },
  },
};

type Update = {
  where: {
    status?: string | { in: string[] };
    transferAttempts?: number;
    updatedAt?: Date;
  };
  data: { status?: RecordingStatus; storagePath?: string | null };
};

function prepareRace() {
  const state: {
    status: RecordingStatus;
    transferAttempts: number;
    updatedAt: Date;
    storagePath: string | null;
  } = {
    status: RecordingStatus.READY,
    transferAttempts: 0,
    updatedAt: oldDate,
    storagePath: null,
  };
  mockClaim.mockImplementation(async () => {
    if (state.status !== RecordingStatus.READY) return [];
    state.status = RecordingStatus.TRANSFERRING;
    state.transferAttempts++;
    state.updatedAt = new Date();
    return [
      {
        id: "race",
        recordingUrl: "https://test.stream-io-cdn.com/r.mp4",
        transferAttempts: state.transferAttempts,
        updatedAt: state.updatedAt,
      },
    ];
  });
  mockUpdate.mockImplementation(async ({ where, data }: Update) => {
    if (typeof where.status === "string" && where.status !== state.status)
      return { count: 0 };
    if (
      typeof where.status === "object" &&
      !where.status.in.includes(state.status)
    )
      return { count: 0 };
    if (
      where.transferAttempts !== undefined &&
      where.transferAttempts !== state.transferAttempts
    )
      return { count: 0 };
    if (
      where.updatedAt &&
      where.updatedAt.getTime() !== state.updatedAt.getTime()
    )
      return { count: 0 };
    if (data.status) state.status = data.status;
    if (data.storagePath !== undefined) state.storagePath = data.storagePath;
    return { count: 1 };
  });
  mockFindMany.mockImplementation(
    async ({ where }: { where: { status: string | { in: string[] } } }) => {
      if (where.status === RecordingStatus.READY) return [];
      if (where.status === RecordingStatus.EXPIRED) {
        return state.status === RecordingStatus.EXPIRED && state.storagePath
          ? [{ id: "race", storagePath: state.storagePath }]
          : [];
      }
      // A due scan may have read this candidate just before the transfer claim.
      return [candidate];
    },
  );
  global.fetch = jest
    .fn()
    .mockResolvedValue(
      new Response(new Uint8Array(), { headers: { "content-length": "100" } }),
    );
  let finish: (value: {
    key: string;
    size: number;
    parts: number;
  }) => void = () => {
    throw new Error("Upload not started");
  };
  const upload = new Promise<{ key: string; size: number; parts: number }>(
    (resolve) => {
      finish = resolve;
    },
  );
  jest.mocked(streamMultipartToR2).mockReturnValueOnce(upload);
  return { state, finish };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it("defers retention after a transfer claim, then expires and purges the completed object", async () => {
  const { state, finish } = prepareRace();
  const copy = transferRecording("race");
  await new Promise(setImmediate);
  expect(state.status).toBe(RecordingStatus.TRANSFERRING);
  expect((await expireRecordings({ limit: 1 })).expired).toBe(0);
  expect(state.status).toBe(RecordingStatus.TRANSFERRING);
  expect(deleteRecordingAssets).not.toHaveBeenCalled();

  finish({ key: "k", size: 100, parts: 1 });
  await expect(copy).resolves.toEqual({ status: "copied" });
  expect(state.status).toBe(RecordingStatus.AVAILABLE);
  expect((await expireRecordings({ limit: 1 })).expired).toBe(1);
  expect(deleteRecordingAssets).toHaveBeenCalledWith({
    id: "race",
    storagePath: "recordings/race/attempt-1.mp4",
  });
  expect(state.status).toBe(RecordingStatus.EXPIRED);
  expect(state.storagePath).toBeNull();
});

it("cannot resurrect a row erased while its upload is in flight", async () => {
  const { state, finish } = prepareRace();
  const copy = transferRecording("race");
  await new Promise(setImmediate);
  state.status = RecordingStatus.EXPIRED;
  finish({ key: "k", size: 100, parts: 1 });
  await expect(copy).resolves.toEqual({ status: "skipped" });
  expect(state.status).toBe(RecordingStatus.EXPIRED);
  expect(state.storagePath).toBeNull();
  expect(deleteR2Object).toHaveBeenCalledWith(
    expect.objectContaining({ key: "recordings/race/attempt-1.mp4" }),
  );
});
