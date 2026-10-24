/**
 * @jest-environment node
 */

const mockListRecordings = jest.fn();
const mockDeleteRecording = jest.fn();
let mockBreakerOpen = false;

jest.mock("../../lib/stream-client", () => {
  const actual = jest.requireActual("../../lib/stream-client");
  return {
    isExpectedStreamError: actual.isExpectedStreamError,
    isStreamConfigured: () => true,
    getStreamVideoClient: () => ({
      video: {
        call: () => ({
          listRecordings: mockListRecordings,
          deleteRecording: mockDeleteRecording,
        }),
      },
    }),
    withStreamCircuitBreaker: async (
      fn: () => Promise<unknown>,
      fallback?: () => unknown,
    ) => {
      if (mockBreakerOpen && fallback) return fallback();
      return fn();
    },
  };
});
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/stream/recording-handlers", () => ({}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { streamLogger } from "../../lib/stream-logger";
import { RecordingService } from "../../lib/stream/recording-service";
import { deleteStreamRecordingCopy } from "../../lib/stream/recording-stream-delete";

const streamError = (status: number, code?: number) =>
  Object.assign(new Error(`Stream ${status}`), {
    metadata: { responseCode: status },
    ...(code === undefined ? {} : { code }),
  });

describe("Stream recording listing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBreakerOpen = false;
  });

  it("reports a 404 as call-not-found and a 5xx, 429 or open breaker as unavailable, without Sentry", async () => {
    mockListRecordings
      .mockRejectedValueOnce(streamError(404, 16))
      .mockRejectedValueOnce(streamError(503))
      .mockRejectedValueOnce(streamError(429));

    await expect(
      RecordingService.getCallRecordingsFromStream("c1"),
    ).resolves.toEqual({ status: "call-not-found" });
    await expect(
      RecordingService.getCallRecordingsFromStream("c1"),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      RecordingService.getCallRecordingsFromStream("c1"),
    ).resolves.toMatchObject({ status: "unavailable" });
    mockBreakerOpen = true;
    await expect(
      RecordingService.getCallRecordingsFromStream("c1"),
    ).resolves.toMatchObject({ status: "unavailable" });

    expect(streamLogger.error).not.toHaveBeenCalled();
  });

  it("treats an unknown call as an already-deleted copy, but never an outage", async () => {
    mockListRecordings.mockRejectedValueOnce(streamError(404, 16));
    await expect(
      deleteStreamRecordingCopy({ streamCallId: "c1", streamRecordingId: "f" }),
    ).resolves.toEqual({ success: true });

    mockListRecordings.mockRejectedValueOnce(streamError(503));
    await expect(
      deleteStreamRecordingCopy({ streamCallId: "c1", streamRecordingId: "f" }),
    ).resolves.toMatchObject({ success: false });
    expect(mockDeleteRecording).not.toHaveBeenCalled();
  });

  it("deletes a listed copy by its session id", async () => {
    mockListRecordings.mockResolvedValueOnce({
      recordings: [{ filename: "f", session_id: "s", url: "u" }],
    });
    mockDeleteRecording.mockResolvedValueOnce({});

    await expect(
      deleteStreamRecordingCopy({ streamCallId: "c1", streamRecordingId: "f" }),
    ).resolves.toEqual({ success: true });
    expect(mockDeleteRecording).toHaveBeenCalledWith({
      session: "s",
      filename: "f",
    });
  });
});
