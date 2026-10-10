/**
 * @jest-environment node
 */

const deleteR2Object = jest.fn();
const removeObjects = jest.fn();
const list = jest.fn();

jest.mock("../../lib/storage/r2-client", () => ({
  createR2PresignedGetUrl: jest.fn(),
  deleteR2Object: (...args: unknown[]) => deleteR2Object(...args),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: () => ({ from: () => ({ list }) }),
  removeObjects: (...args: unknown[]) => removeObjects(...args),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { deleteRecordingAssets } from "../../lib/stream/recording-storage";

beforeEach(() => jest.clearAllMocks());

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
});
