/**
 * @jest-environment node
 */

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: jest.fn(),
  removeObjects: jest.fn(),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import {
  getBestRecordingUrl,
  playbackUrlTtlSeconds,
} from "../../lib/stream/recording-storage";

const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "k",
    R2_SECRET_ACCESS_KEY: "s",
    R2_BUCKET: "recordings",
  };
});

afterEach(() => {
  process.env = originalEnv;
});

describe("presigned playback URL lifetime", () => {
  it("outlives a two-hour recording watched with pauses", () => {
    const url = getBestRecordingUrl({
      status: "AVAILABLE",
      storagePath: "recordings/r/a.mp4",
      recordingUrl: null,
      durationInMinutes: 120,
    });

    const expires = Number(
      new URL(url ?? "").searchParams.get("X-Amz-Expires"),
    );
    // Twice the length plus an hour.
    expect(expires).toBe(5 * 3600);
  });

  it("keeps one hour for an unknown length and caps a very long one at a day", () => {
    expect(playbackUrlTtlSeconds(null)).toBe(3600);
    expect(playbackUrlTtlSeconds(0)).toBe(3600);
    expect(playbackUrlTtlSeconds(100_000)).toBe(24 * 3600);
  });
});
