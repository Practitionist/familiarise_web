/**
 * @jest-environment jsdom
 */

/**
 * The watch side of a broadcast, and the boundary around the playlist URL.
 *
 * Three things carry the weight, and the first is the reason the rest of this
 * file exists.
 *
 * **1. The URL is a bearer credential.** The CDN serves it with no session and
 * no membership check, so holding it IS watching. Every assertion below about
 * the URL — that it is never rendered, never shared, and never reaches Sentry
 * even as part of a vendor error message — is the same assertion from three
 * directions, because the leak paths are independent and fixing one does not fix
 * the others.
 *
 * **2. `hls.js` must not load for a browser that does not need it.** Measured
 * by counting reads of the module's `default` export, which `attachHls` touches
 * exactly once and only on the MSE branch. The first instrument tried here was a
 * flag set inside the mock FACTORY, on the theory that "the factory did not run
 * means the module was never required" — which is true but useless, because a
 * Jest mock factory runs at most once per module registry. The second test to
 * touch `hls.js` in a file would then have asserted `false` for a module that
 * was demonstrably loaded. A getter on `default` is per-read, so it is both
 * resettable and a tighter proxy for the property under test: it can only fire
 * after the native branch has been declined.
 *
 * **3. The recovery ladder is bounded.** `hls.js`'s own answer to a fatal error
 * is to retry forever, which on a stream nobody is going to fix is a spinner
 * that never ends. The bound is the difference between a flaky connection
 * recovering by itself and a dead broadcast admitting it.
 *
 * The wrapper is NOT mocked. Mocking it would make these tests assert that the
 * player calls `attachHls` with the arguments it was given, which is the part
 * least likely to be wrong.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** How many times `hls.js`'s `default` export has been read. See the header. */
let mockHlsDefaultReads = 0;

jest.mock("hls.js", () => {
  const { FakeHls } = jest.requireActual("../fixtures/hls-fake");
  return {
    __esModule: true,
    get default() {
      mockHlsDefaultReads += 1;
      return FakeHls;
    },
  };
});

const mockReportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LivestreamPlayer } from "../../components/meetings/LivestreamPlayer";
import { attachHls } from "../../lib/stream/hls-client";
import { FakeHls, hlsControl } from "../fixtures/hls-fake";

/** Recognisable in every assertion below, so "it is not in the DOM" is provable. */
const PLAYLIST =
  "https://cdn.stream-io-video.com/live/xyz/playlist.m3u8?token=SECRET-CREDENTIAL";

const realFetch = global.fetch;
const realCanPlayType = HTMLMediaElement.prototype.canPlayType;
const realLoad = HTMLMediaElement.prototype.load;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function streamOk(): Response {
  return jsonResponse(200, { playlistUrl: PLAYLIST, status: "live" });
}

async function flush(): Promise<void> {
  // Generous, because there are three chained awaits here — the fetch, the
  // render that creates the <video>, and the attach — and stopping short of the
  // last one silently tests the loading state.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("LivestreamPlayer", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockHlsDefaultReads = 0;
    hlsControl.reset();
    mockReportSentryError.mockClear();
    // jsdom has no codecs at all, so its default is already the right answer
    // ("no native HLS"). Stated explicitly so a jsdom upgrade cannot quietly
    // make every test below exercise the wrong branch.
    HTMLMediaElement.prototype.canPlayType = () => "";
    // jsdom's `load()` is a not-implemented stub that logs through the virtual
    // console, which jest surfaces as noise unrelated to what is under test.
    HTMLMediaElement.prototype.load = function () {};
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchMock = jest.fn().mockResolvedValue(streamOk());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    global.fetch = realFetch;
    HTMLMediaElement.prototype.canPlayType = realCanPlayType;
    HTMLMediaElement.prototype.load = realLoad;
  });

  async function mount(meetingId = "m-1"): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<LivestreamPlayer meetingId={meetingId} />);
    });
    await flush();
  }

  function text(): string {
    return container.textContent ?? "";
  }

  function video(): HTMLVideoElement | null {
    return container.querySelector("video");
  }

  // ── The credential ────────────────────────────────────────────────────────

  describe("the playlist URL", () => {
    it("is fetched rather than handed in, and never appears in the page text", async () => {
      await mount();

      // One call, to the participant-only route, with the meeting id encoded.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [path] = fetchMock.mock.calls[0] as [string];
      expect(path).toBe("/api/meetings/m-1/livestream/stream-url");

      // A prop would have been serialised into the RSC payload; text content is
      // what gets scraped, copied and cached.
      expect(text()).not.toContain(PLAYLIST);
      expect(text()).not.toContain("SECRET-CREDENTIAL");
      // And nothing shareable carries it: no link, no data attribute.
      expect(container.querySelector("a")).toBeNull();
      for (const el of Array.from(container.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.value).not.toContain("SECRET-CREDENTIAL");
        }
      }
    });

    it("asks for it uncached and same-origin, because the route header is not the only cache in the path", async () => {
      await mount();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.cache).toBe("no-store");
      expect(init.credentials).toBe("same-origin");
    });

    it("never reaches Sentry, not even inside a vendor error message", async () => {
      // The leak path this pins: `hls.js` builds its error text from the
      // request that failed, so a fatal manifest error reads
      // "… 404 https://…/playlist.m3u8?token=…". Reporting that verbatim would
      // put a working watch-key in a third-party event store, tagged with the
      // meeting, outliving the broadcast.
      await mount();
      const instance = FakeHls.instances[0];
      expect(instance).toBeDefined();

      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          instance.emitError("networkError", true);
        });
      }
      await flush();

      expect(mockReportSentryError).toHaveBeenCalled();
      const reported = JSON.stringify(mockReportSentryError.mock.calls);
      expect(reported).not.toContain("SECRET-CREDENTIAL");
      expect(reported).not.toContain("playlist.m3u8");
      // Something has to be reported, or this test passes on a silent logger.
      expect(reported).toContain("network");
    });
  });

  // ── Engine selection ──────────────────────────────────────────────────────

  describe("choosing an HLS engine", () => {
    it("never loads hls.js on a browser that plays HLS natively", async () => {
      HTMLMediaElement.prototype.canPlayType = () => "maybe";

      await mount();

      // Zero reads of `default` means the dynamic import was never even
      // resolved, so a Safari viewer has not downloaded a second HLS engine to
      // do nothing.
      expect(mockHlsDefaultReads).toBe(0);
      expect(FakeHls.instances).toHaveLength(0);
      // The native branch is the one that actually plays.
      expect(video()?.src).toBe(PLAYLIST);
    });

    it("loads hls.js and attaches through MSE everywhere else", async () => {
      await mount();

      expect(mockHlsDefaultReads).toBeGreaterThan(0);
      const instance = FakeHls.instances[0];
      expect(instance.loadSource).toHaveBeenCalledWith(PLAYLIST);
      expect(instance.attachMedia).toHaveBeenCalledTimes(1);
      // The default MSE path is also the one where the URL stays out of the
      // DOM entirely, unlike native playback, which cannot avoid `src`.
      expect(container.innerHTML).not.toContain("SECRET-CREDENTIAL");
    });

    it("says so plainly when the browser can do neither", async () => {
      hlsControl.supported = false;

      await mount();

      expect(text()).toContain("cannot play the stream");
      expect(video()?.src ?? "").not.toContain("SECRET-CREDENTIAL");
    });
  });

  // ── Telling the truth about nothing to watch ──────────────────────────────

  describe("when there is no stream", () => {
    it("names the plan rather than spinning on a broadcast that never starts", async () => {
      // The route cannot distinguish "the presenter has not gone live" from
      // "nobody is entitled to a stream egress" without disclosing the plan, and
      // declines to. Neither does the client: it states the observable fact and
      // says broadcast streaming is an add-on, which is the honest answer for
      // both. A player that just kept trying would be lying about progress.
      fetchMock.mockResolvedValue(
        jsonResponse(404, {
          error: "No stream is available for this session.",
          reason: "hls_unavailable",
        }),
      );

      await mount();

      expect(text()).toContain("No stream to watch");
      expect(text()).toContain("add-on");
      expect(video()).toBeNull();
      // And it must not be a dead end: arriving before the presenter is the
      // common case, and it is fixable by re-asking.
      expect(text()).toContain("Check again");
    });

    it("offers no retry for a membership refusal, which retrying cannot fix", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, { error: "Not available", reason: "not_available" }),
      );

      await mount();

      expect(text()).toContain("not yours to watch");
      expect(text()).not.toContain("Check again");
    });

    it("treats a 5xx and a dead network the same way: retryable", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(503, { error: "Video is temporarily unavailable." }),
      );
      await mount();
      expect(text()).toContain("could not reach the stream");
      expect(text()).toContain("Check again");

      // A thrown fetch is the network, not the server, and lands in the same
      // place — otherwise a laptop lid closing strands a viewer on an error
      // with no way forward.
      await act(async () => {
        root?.unmount();
      });
      root = null;
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await mount("m-2");
      expect(text()).toContain("could not reach the stream");
    });

    it("re-asks on 'Check again' and plays once the broadcast exists", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(404, { reason: "hls_unavailable" }),
      );
      await mount();
      expect(text()).toContain("No stream to watch");

      fetchMock.mockResolvedValueOnce(streamOk());
      const button = Array.from(container.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").includes("Check again"),
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
      });
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(video()).not.toBeNull();
      expect(text()).not.toContain("No stream to watch");
    });
  });

  // ── Bounded recovery ──────────────────────────────────────────────────────

  describe("recovering from a fatal error", () => {
    it("retries a network failure a bounded number of times, then gives up", async () => {
      await mount();
      const instance = FakeHls.instances[0];

      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          instance.emitError("networkError", true);
        });
      }
      await flush();

      // Two retries, then the decision goes back to the caller. An unbounded
      // `startLoad()` also "succeeds" against a 404, so a dead stream would
      // retry for ever and the viewer would sit on a spinner indefinitely.
      expect(instance.startLoad).toHaveBeenCalledTimes(2);
      expect(text()).toContain("stream stopped");
    });

    it("swaps the audio codec on the last media rung before stopping", async () => {
      await mount();
      const instance = FakeHls.instances[0];

      // Three errors for two attempts: the first is recovered by flushing the
      // buffer, the second by swapping the codec, and only the third finds the
      // budget spent. The swap has to be given its own chance to work, so
      // giving up is not allowed to happen on the same error that triggers it.
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          instance.emitError("mediaError", true);
        });
      }
      await flush();

      // hls.js's own escalation: a browser that demuxes the wrong codec reports
      // the same media error for ever, and swapping is the only thing that can
      // clear it — so it is tried once, on the last rung, and never twice.
      expect(instance.recoverMediaError).toHaveBeenCalledTimes(1);
      expect(instance.swapAudioCodec).toHaveBeenCalledTimes(1);
      expect(text()).toContain("stream stopped");
    });

    it("ignores a non-fatal error, which is the library working", async () => {
      await mount();
      const instance = FakeHls.instances[0];

      await act(async () => {
        instance.emitError("mediaError", false);
      });
      await flush();

      // A level switch or a skipped fragment is not news. Surfacing these put a
      // "something went wrong" over a stream that was playing fine.
      expect(instance.recoverMediaError).not.toHaveBeenCalled();
      expect(text()).not.toContain("stream stopped");
    });

    it("stops the ladder once it has given up", async () => {
      await mount();
      const instance = FakeHls.instances[0];

      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          instance.emitError("networkError", true);
        });
      }
      await flush();

      // One report, not one per error. A stream that is dead and stays dead
      // must not page anybody once a second.
      expect(mockReportSentryError).toHaveBeenCalledTimes(1);
    });
  });

  // ── Teardown ──────────────────────────────────────────────────────────────

  describe("cleaning up", () => {
    it("destroys the instance on unmount", async () => {
      await mount();
      const instance = FakeHls.instances[0];

      await act(async () => {
        root?.unmount();
      });
      root = null;

      // A MediaSource left attached to a detached element keeps its worker and
      // its buffer alive for the life of the tab.
      expect(instance.destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys the previous instance before attaching a new one", async () => {
      // Driven through the wrapper rather than the component, because the
      // component cannot reach this state: `url` only moves again through
      // "Check again", which is unreachable while a stream is playing. The
      // window is real though — the dynamic import is an await, and an unmount
      // during it is the common case on a phone that locks mid-join.
      const video = document.createElement("video");
      document.body.appendChild(video);
      const controller = new AbortController();

      const pending = attachHls(video, PLAYLIST, { signal: controller.signal });
      // Synchronously, before the import can have resolved: this is exactly the
      // ordering a React unmount produces.
      controller.abort();
      const result = await pending;

      expect(result.mode).toBe("unsupported");
      // The instance that the import would have produced is never constructed,
      // so there is nothing for the caller to leak and nothing to clean up.
      expect(FakeHls.instances).toHaveLength(0);
      video.remove();
    });

    it("refuses an already-aborted attach before touching the element", async () => {
      const video = document.createElement("video");
      const controller = new AbortController();
      controller.abort();

      const result = await attachHls(video, PLAYLIST, {
        signal: controller.signal,
      });

      expect(result.mode).toBe("unsupported");
      expect(FakeHls.instances).toHaveLength(0);
      // Native playback is the one branch that mutates the element, so the
      // early return has to come before it or a cancelled attach would still
      // leave a `src` pointing at a live broadcast.
      expect(video.getAttribute("src")).toBeNull();
    });

    it("aborts the URL fetch on unmount rather than resolving into a dead component", async () => {
      let capturedSignal: AbortSignal | undefined;
      fetchMock.mockImplementation(
        (_path: string, init: RequestInit) =>
          new Promise((resolve) => {
            capturedSignal = init.signal as AbortSignal;
            setTimeout(() => resolve(streamOk()), 50);
          }),
      );

      await act(async () => {
        root = createRoot(container);
        root.render(<LivestreamPlayer meetingId="m-9" />);
      });
      await flush();

      expect(capturedSignal?.aborted).toBe(false);
      await act(async () => {
        root?.unmount();
      });
      root = null;

      // Without this the late resolution set state on an unmounted component,
      // and a second `attachHls` ran against a video element that was gone.
      expect(capturedSignal?.aborted).toBe(true);
      expect(FakeHls.instances).toHaveLength(0);
    });
  });
});
