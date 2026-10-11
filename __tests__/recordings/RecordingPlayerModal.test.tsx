/**
 * @jest-environment jsdom
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RecordingPlayerModal } from "../../components/recordings/RecordingPlayerModal";

describe("RecordingPlayerModal mid-stream presigned URL recovery", () => {
  const originalFetch = global.fetch;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("captures currentTime on video error, refreshes URL without unmounting <video>, restores currentTime on metadata load, and surfaces retryable error if refresh fails again", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => refreshPromise) as unknown as typeof fetch;

    await act(async () => {
      root.render(
        <RecordingPlayerModal
          open={true}
          onOpenChange={jest.fn()}
          recording={{
            id: "rec-long-session",
            title: "120-Minute Architecture Deep Dive",
            playbackUrl:
              "https://acct.r2.cloudflarestorage.com/recordings/rec-long-session/composite.mp4?X-Amz-Expires=14400&sig=expired",
            storageType: "PLATFORM",
            durationInMinutes: 120,
          }}
        />,
      );
    });

    // Radix Dialog renders into document.body portal
    const video = document.body.querySelector("video") as HTMLVideoElement;
    expect(video).toBeTruthy();

    // Simulate watching 58 minutes (3480 seconds) into the recording before URL expires
    Object.defineProperty(video, "currentTime", {
      writable: true,
      value: 3480,
    });

    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });

    // While refreshing in background, <video> MUST stay mounted (no full-screen spinner unmount!)
    expect(document.body.querySelector("video")).toBe(video);
    expect(document.body.textContent).not.toContain(
      "Preparing secure video stream...",
    );

    // Complete background presigned URL refresh
    await act(async () => {
      resolveRefresh({
        ok: true,
        json: async () => ({
          recording: {
            playbackUrl:
              "https://acct.r2.cloudflarestorage.com/recordings/rec-long-session/composite.mp4?X-Amz-Expires=14400&sig=fresh",
            previewTranscript: null,
          },
        }),
      });
      await refreshPromise;
    });

    expect(video.getAttribute("src")).toContain("sig=fresh");

    // Simulate browser resetting currentTime to 0 when src swaps, then firing loadedmetadata
    video.currentTime = 0;
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.currentTime).toBe(3480);

    // Once playback resumes (canplay), retriedOnError resets to false
    await act(async () => {
      video.dispatchEvent(new Event("canplay"));
    });

    const brokenRefresh = Promise.resolve({
      ok: true,
      json: async () => ({
        recording: {
          playbackUrl:
            "https://acct.r2.cloudflarestorage.com/recordings/rec-long-session/composite.mp4?X-Amz-Expires=14400&sig=broken",
          previewTranscript: null,
        },
      }),
    });
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => brokenRefresh) as unknown as typeof fetch;

    await act(async () => {
      video.dispatchEvent(new Event("error"));
      await brokenRefresh;
    });
    expect(video.getAttribute("src")).toContain("sig=broken");

    // Second consecutive error before canplay surfaces the retryable error card
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(document.body.textContent).toContain(
      "Playback stream interrupted and could not be automatically refreshed.",
    );
    expect(document.body.textContent).toContain("Retry");
  });
});
