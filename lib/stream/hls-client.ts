/**
 * The one place in the app that knows `hls.js` exists.
 *
 * Four things it has to get right, and each one is a decision rather than a
 * detail:
 *
 * 1. **`hls.js` is 400 KB and only some browsers need it.** Safari plays HLS
 *    natively, and on any browser that can play natively, loading the library
 *    anyway means shipping a second HLS engine to do nothing. So the import is
 *    `await import("hls.js")` inside a function, and the native branch is
 *    reached before that line — a Safari viewer never resolves the promise and
 *    never downloads the chunk. It is also its own webpack chunk, so it is not
 *    in the route's initial payload.
 *
 * 2. **Nothing runs at module scope.** No `window`, no `document`, no
 *    `MediaSource`, and no top-level `await import`. A server component that
 *    imports this for its types must not pull a browser library into the RSC
 *    graph, and the cheapest way to guarantee that is for the file to be
 *    incapable of touching a browser until it is handed an element.
 *
 * 3. **Every fatal error is recoverable, up to a point.** `hls.js` reports a
 *    fatal network error on a flaky mobile connection and a fatal network
 *    error on a dead CDN identically. The library's own answer is to retry
 *    forever, which on a stream nobody is going to fix is a spinner that never
 *    ends. So the ladder is bounded and the last rung hands the decision back
 *    to the caller, which can show something honest.
 *
 * 4. **The playlist URL is a bearer credential and nothing here logs it.**
 *    More than the obvious `console.log` — see {@link reportFatal} for the part
 *    that is easy to get wrong.
 */

import { reportSentryError } from "@/lib/observability/report";
import type Hls from "hls.js";

/**
 * Type-only import of the class.
 *
 * `import type` is erased at compile time, so this contributes nothing to any
 * bundle — the runtime class arrives solely through the dynamic import below.
 * It buys the real `Hls` instance type, `ErrorTypes` discrimination and the
 * event emitter signatures, all of which are worth more here than the ~40 lines
 * a hand-written structural stand-in would cost to keep in step with a
 * dependency whose types move.
 */

/**
 * How many times a fatal error of one kind is retried before the caller is
 * told to give up.
 *
 * Two is enough for the real cases — a segment that 504s once, and the
 * buffer-overrun that `recoverMediaError` exists to fix — and small enough that
 * a genuinely dead stream surfaces in seconds rather than minutes. It is
 * per-kind, not a shared budget, because the two failures are independent: a
 * network that is up can still have a broken decoder, and vice versa.
 */
export const HLS_RECOVERY_LIMIT = 2;

/** What the player should be showing. */
export type HlsPlaybackState =
  /** Fetching the manifest. Nothing has been decoded yet. */
  | "loading"
  /** The manifest resolved — the stream exists, frames are on their way. */
  | "manifest"
  /** A fatal error is being worked through by the ladder. */
  | "recovering"
  /** The ladder is exhausted. Terminal. */
  | "failed";

/** Which fatal class ran out of attempts. */
export type HlsFatalKind = "network" | "media";

/**
 * The three ways attaching a playlist can go, and the one that is not a bug.
 *
 * A discriminated union rather than a nullable handle because the three demand
 * different things from the caller and only one of them has a teardown: a
 * native attachment must have its `src` cleared or the element keeps fetching
 * the last broadcast after the component is gone, and collapsing that into a
 * bare `null` is how a stale stream outlives its page.
 */
export type HlsAttachment =
  /** The browser played it itself. `hls.js` was never loaded. */
  | { readonly mode: "native"; readonly video: HTMLVideoElement }
  /** Media Source Extensions. `destroy()` is mandatory. */
  | { readonly mode: "mse"; readonly hls: Hls }
  /** No HLS here: neither native support nor MSE. Show something. */
  | { readonly mode: "unsupported" };

export interface HlsAttachOptions {
  /**
   * Aborted on unmount and on a URL change.
   *
   * The dynamic import is a real await, so a component can be gone before it
   * resolves. Without this the late resolution attaches an `hls.js` instance to
   * a detached `<video>` and the MediaSource lives until the tab closes.
   */
  signal?: AbortSignal;
  onState?: (state: HlsPlaybackState) => void;
  /**
   * The ladder is exhausted, or the browser cannot play HLS at all.
   * `kind` is absent for the second: nothing failed, nothing is retryable.
   */
  onFatal?: (kind: HlsFatalKind | "unsupported") => void;
}

/**
 * Does this element play HLS on its own?
 *
 * `canPlayType` is the only detection that is honest, because it asks the
 * engine that will actually decode rather than sniffing a user-agent — the
 * check every HLS guide reaches for first is a user-agent test, and it is
 * wrong on iPadOS (reports as Mac), wrong on Chrome for Android behind a flag
 * and wrong on every future browser. Safari answers `"maybe"` or `"probably"`;
 * everyone else answers `""`.
 *
 * Not guarded on the argument, because the argument IS the evidence: there is
 * no `<video>` to ask on a server, and a caller that has one has a DOM.
 */
export function canPlayNativeHls(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return (
    video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    video.canPlayType("application/x-mpegURL") !== ""
  );
}

/**
 * Report a dead stream, carrying nothing the vendor produced.
 *
 * The reason this is not `reportSentryError(data.error, ...)` is the whole
 * reason it is worth a function. `hls.js` builds its `Error` messages from the
 * request that failed, so a fatal manifest error routinely reads
 * `… 404 https://<cdn>/…/playlist.m3u8?token=…` — and that playlist URL is the
 * bearer credential from
 * `GET /api/meetings/[id]/livestream/stream-url`. Forwarding the message to
 * Sentry would put a working watch-key in a third-party event store, tagged
 * with the meeting, readable by anyone with project access and outliving the
 * broadcast by however long our retention is set to.
 *
 * So the only things that leave the browser are: that it was a stream, which
 * kind of failure, and how many attempts the ladder spent. `expected: true`
 * because a CDN that stops answering is an answer, not a defect in this code.
 */
function reportFatal(args: {
  kind: HlsFatalKind | "unsupported";
  attempts: number;
}): void {
  reportSentryError(new Error(`HLS playback failed: ${args.kind}`), {
    subsystem: "stream",
    op: "meetings.livestream.hls",
    expected: true,
    // The credential is deliberately not here, and neither is the vendor's
    // message. See above.
    extra: { kind: args.kind, attempts: args.attempts },
  });
}

/**
 * Wire the bounded recovery ladder onto an instance.
 *
 * The two rungs and the ceiling are the documented hls.js recovery path, plus a
 * bound:
 *
 *   - a fatal NETWORK error means the manifest or a segment did not arrive, and
 *     `startLoad()` restarts the loader from where it stopped. Correct for a
 *     dropped connection; the reason it must be capped is that `startLoad()`
 *     also "succeeds" against a 404, so an unbounded ladder turns a dead stream
 *     into an infinite retry.
 *   - a fatal MEDIA error means the bytes arrived and the decoder could not
 *     make a buffer out of them, which `recoverMediaError()` fixes by flushing
 *     the buffer and re-appending from the last good fragment. Its own
 *     documented escalation is `swapAudioCodec()` — a browser that demuxes the
 *     wrong codec reports the same error forever, and swapping is the only
 *     thing that can clear it. So the last attempt swaps and then stops: a
 *     second swap would be a third guess at a decoder we do not control.
 *
 * Non-fatal errors are ignored deliberately. They are the library doing its
 * job — a skipped fragment, a level switch — and surfacing them would put a
 * "something went wrong" on screen for a stream that is playing fine.
 */
function wireRecovery(
  HlsCtor: typeof Hls,
  hls: Hls,
  options: HlsAttachOptions,
): void {
  let networkAttempts = 0;
  let mediaAttempts = 0;
  let gaveUp = false;

  // The event and error-type names are read off the constructor rather than
  // imported, for the same reason the class is: a static import of `hls.js`
  // would defeat the whole dynamic-import half of this file.
  hls.on(HlsCtor.Events.ERROR, (_event, data) => {
    if (!data.fatal || gaveUp || options.signal?.aborted) return;

    const isNetwork = data.type === HlsCtor.ErrorTypes.NETWORK_ERROR;
    const isMedia = data.type === HlsCtor.ErrorTypes.MEDIA_ERROR;

    if (isNetwork) {
      if (networkAttempts >= HLS_RECOVERY_LIMIT) {
        gaveUp = true;
        options.onState?.("failed");
        reportFatal({ kind: "network", attempts: networkAttempts });
        options.onFatal?.("network");
        return;
      }
      networkAttempts += 1;
      options.onState?.("recovering");
      hls.startLoad();
      return;
    }

    if (isMedia) {
      if (mediaAttempts >= HLS_RECOVERY_LIMIT) {
        gaveUp = true;
        options.onState?.("failed");
        reportFatal({ kind: "media", attempts: mediaAttempts });
        options.onFatal?.("media");
        return;
      }
      mediaAttempts += 1;
      // The final rung before giving up: a misdemuxed audio track reports a
      // media error that recovery alone cannot clear.
      if (mediaAttempts === HLS_RECOVERY_LIMIT) hls.swapAudioCodec();
      else hls.recoverMediaError();
      options.onState?.("recovering");
      return;
    }

    // KEY_SYSTEM_ERROR, MUX_ERROR, OTHER_ERROR. Nothing here can be retried into
    // working, and reloading would not help: the stream is being served in a
    // shape this browser will not decode.
    gaveUp = true;
    options.onState?.("failed");
    reportFatal({ kind: "unsupported", attempts: 0 });
    options.onFatal?.("unsupported");
  });

  hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
    if (gaveUp || options.signal?.aborted) return;
    options.onState?.("manifest");
  });
}

/**
 * Play a playlist on `video`, choosing the engine the browser actually needs.
 *
 * Resolves rather than throwing: every failure here is a state the caller
 * renders, and an attachment that rejects on a browser with no HLS at all would
 * push a `try`/`catch` into every call site for one enumerated outcome. The
 * `unsupported` variant is that outcome.
 */
export async function attachHls(
  video: HTMLVideoElement,
  url: string,
  options: HlsAttachOptions = {},
): Promise<HlsAttachment> {
  options.onState?.("loading");

  if (canPlayNativeHls(video)) {
    // Checked before the import on purpose, not after: this is the branch that
    // makes `hls.js` optional at all. Safari never reaches the `await` below.
    video.src = url;
    video.load();
    options.onState?.("manifest");
    return { mode: "native", video };
  }

  if (options.signal?.aborted) return { mode: "unsupported" };

  let HlsCtor: typeof Hls;
  try {
    const mod = await import("hls.js");
    // `hls.js` ships a CJS build with a default export, and the bundler's
    // interop for a dynamic import is not the same as `esModuleInterop` for a
    // static one — under some conditions the namespace itself is the class.
    // Reading `.default` alone returns `undefined` on exactly the browser that
    // can least afford it, so both shapes are accepted.
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (typeof candidate !== "function") {
      throw new Error("hls.js loaded without a constructor");
    }
    HlsCtor = candidate as typeof Hls;
  } catch {
    // The chunk failed to arrive — an offline first load, or a deploy that
    // swapped the asset out under a cached page. Not fatal for the user, who is
    // on a browser with no native HLS and now no library either.
    options.onState?.("failed");
    reportFatal({ kind: "unsupported", attempts: 0 });
    options.onFatal?.("unsupported");
    return { mode: "unsupported" };
  }

  if (!HlsCtor.isSupported()) {
    options.onState?.("failed");
    reportFatal({ kind: "unsupported", attempts: 0 });
    options.onFatal?.("unsupported");
    return { mode: "unsupported" };
  }

  // Between the await and here the component can have unmounted, or the URL can
  // have changed. Attaching now would bind a MediaSource to a detached element.
  if (options.signal?.aborted) return { mode: "unsupported" };

  const hls = new HlsCtor();
  wireRecovery(HlsCtor, hls, options);

  // No abort listener here, on purpose. The signal's job is to stop work that
  // has NOT started — the two `aborted` guards above — and everything after
  // this line is synchronous, so there is no window left to close. An abort
  // listener that called `destroy()` looked like the tidier ownership but made
  // teardown happen twice: once from the listener, once from the caller's
  // `detachHls`, and `hls.js` does not promise a second `destroy()` is
  // harmless. One owner for destruction: `detachHls`.
  hls.loadSource(url);
  hls.attachMedia(video);

  return { mode: "mse", hls };
}

/**
 * Release an attachment. Safe to call twice and safe to call with `null`.
 *
 * Idempotent because the two call sites that matter — unmount and URL change —
 * can both fire for one instance, and an unguarded second `destroy()` throws
 * inside a React cleanup, where it surfaces as an error boundary over a
 * component that was working.
 */
export function detachHls(attachment: HlsAttachment | null): void {
  if (!attachment) return;

  if (attachment.mode === "native") {
    // `removeAttribute` rather than `src = ""`: assigning the empty string makes
    // the element resolve its own document URL and fire a spurious request, and
    // leaves a native playback session running. `load()` then tears down the
    // resource selection, which is what actually stops the fetches.
    attachment.video.removeAttribute("src");
    attachment.video.load();
    return;
  }

  if (attachment.mode === "mse") {
    try {
      attachment.hls.destroy();
    } catch {
      // Already destroyed. Nothing to do, and a throw here would mask whatever
      // the caller was unmounting.
    }
  }
}
