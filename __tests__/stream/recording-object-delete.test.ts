/**
 * @jest-environment node
 */

const deleteR2Object = jest.fn();
const listR2Keys = jest.fn();
let r2Configured = false;
const removeObjects = jest.fn();
const list = jest.fn();

jest.mock("../../lib/storage/r2-client", () => ({
  createR2PresignedGetUrl: jest.fn(),
  deleteR2Object: (...args: unknown[]) => deleteR2Object(...args),
  listR2Keys: (...args: unknown[]) => listR2Keys(...args),
  isR2Configured: () => r2Configured,
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: () => ({ from: () => ({ list }) }),
  removeObjects: (...args: unknown[]) => removeObjects(...args),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import {
  deleteRecordingAssets,
  deleteRecordingObject,
} from "../../lib/stream/recording-storage";
import { streamLogger } from "../../lib/stream-logger";
import type { RunFailureReporter } from "../../lib/observability/run-failures";

beforeEach(() => jest.clearAllMocks());

it.each(["result", "throw"])(
  "delegates an R2 %s failure to the invocation reporter",
  async (mode) => {
    const error = new Error("R2 unavailable");
    if (mode === "throw") deleteR2Object.mockRejectedValueOnce(error);
    else
      deleteR2Object.mockResolvedValueOnce({
        success: false,
        error: error.message,
      });
    const reporter: RunFailureReporter = { add: jest.fn(), flush: jest.fn() };
    await expect(deleteRecordingObject("object-a", reporter)).resolves.toEqual({
      success: false,
      error: error.message,
    });
    expect(reporter.add).toHaveBeenCalledTimes(1);
    expect(reporter.flush).not.toHaveBeenCalled();
    expect(streamLogger.error).not.toHaveBeenCalled();
  },
);

describe("deleteRecordingAssets", () => {
  it("deletes the R2 copy and the preview folder from the previews bucket", async () => {
    deleteR2Object.mockResolvedValue({ success: true });
    list.mockResolvedValue({
      data: [{ name: "clip.mp4" }, { name: "thumb.jpg" }],
      error: null,
    });
    removeObjects.mockResolvedValue(true);

    await expect(
      deleteRecordingAssets({
        id: "rec-1",
        storagePath: "recordings/rec-1/a.mp4",
      }),
    ).resolves.toEqual({ success: true });
    expect(deleteR2Object).toHaveBeenCalledWith({
      key: "recordings/rec-1/a.mp4",
    });
    expect(removeObjects).toHaveBeenCalledWith("recordings-previews", [
      "rec-1/clip.mp4",
      "rec-1/thumb.jpg",
    ]);
  });

  it("fails without touching previews when the R2 delete fails", async () => {
    deleteR2Object.mockResolvedValue({
      success: false,
      error: "R2 DELETE failed",
    });
    const result = await deleteRecordingAssets({
      id: "rec-1",
      storagePath: "recordings/rec-1/a.mp4",
    });
    expect(result).toEqual({ success: false, error: "R2 DELETE failed" });
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("sweeps every object under the recording's prefix and fails while any survives", async () => {
    r2Configured = true;
    list.mockResolvedValue({ data: [], error: null });
    removeObjects.mockResolvedValue(true);
    listR2Keys.mockResolvedValue({
      keys: [
        "recordings/rec-1/attempt-1.mp4",
        "recordings/rec-1/attempt-2.mp4",
      ],
      truncated: false,
    });
    deleteR2Object
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "R2 DELETE failed" });
    const reporter: RunFailureReporter = { add: jest.fn(), flush: jest.fn() };

    const result = await deleteRecordingAssets(
      { id: "rec-1", storagePath: null },
      reporter,
    );

    expect(listR2Keys).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "recordings/rec-1/" }),
    );
    expect(deleteR2Object).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(reporter.add).toHaveBeenCalledTimes(1);
    expect(streamLogger.error).not.toHaveBeenCalled();
    r2Configured = false;
  });
});
