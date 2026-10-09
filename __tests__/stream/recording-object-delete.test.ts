/**
 * @jest-environment node
 */

const deleteR2Object = jest.fn();
const removeObjects = jest.fn();

jest.mock("../../lib/storage/r2-client", () => ({
  createR2PresignedGetUrl: jest.fn(),
  deleteR2Object: (...args: unknown[]) => deleteR2Object(...args),
  getR2RecordingsBucket: () => "r2-recordings",
  isR2Configured: () => true,
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: jest.fn(),
  removeObjects: (...args: unknown[]) => removeObjects(...args),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { deleteRecordingObject } from "../../lib/stream/recording-storage";

beforeEach(() => jest.clearAllMocks());

describe("deleteRecordingObject with R2 configured", () => {
  it("succeeds without touching the original bucket when R2 deleted the object", async () => {
    deleteR2Object.mockResolvedValue({ success: true, notFound: false });
    await expect(deleteRecordingObject("rec/a.mp4")).resolves.toEqual({
      success: true,
    });
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("succeeds when R2 has no object and the original bucket confirms removal", async () => {
    deleteR2Object.mockResolvedValue({ success: true, notFound: true });
    removeObjects.mockResolvedValue(true);
    await expect(deleteRecordingObject("rec/a.mp4")).resolves.toEqual({
      success: true,
    });
    expect(removeObjects).toHaveBeenCalledWith("recordings", ["rec/a.mp4"]);
  });

  it("fails when R2 has no object and the original bucket copy survives", async () => {
    deleteR2Object.mockResolvedValue({ success: true, notFound: true });
    removeObjects.mockResolvedValue(false);
    const result = await deleteRecordingObject("rec/a.mp4");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Recording object was not removed from storage");
  });
});
