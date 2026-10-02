"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Radio, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import {
  attachHls,
  detachHls,
  type HlsAttachment,
  type HlsPlaybackState,
} from "@/lib/stream/hls-client";

/**
 * The watch side of a broadcast: plays a meeting's HLS egress, and says
 * something true when there is nothing to play.
 *
 * ## The playlist URL is never a prop
 *
 * `streamUrl` does not exist on this component, and that is the design. A prop
 * would have to be computed on the server to reach the client, which means it
 * lands in the RSC payload — i.e. in the HTML of a page that is very likely
 * statically or ISR cached, and in the browser's view-source for every
 * participant who opens it. The URL is a bearer credential: the CDN serves it
 * with no session and no membership check, so anyone holding it is watching,
 * and it is not rotated at the end of the broadcast.
 *
 * So it is fetched here, from
 * `GET /api/meetings/[id]/livestream/stream-url`, into component state and
 * nowhere else. It is never logged, never rendered as text, never put in an
 * `href`, and never written anywhere a crawler or a share sheet could pick it
 * up. The route's `Cache-Control: no-store` covers the response; the fetch
 * opts out of the HTTP cache as well rather than trusting a header that one
 * intermediary could drop.
 *
 * ## `unavailable` deliberately does not know why
 *
 * The route answers `hls_unavailable` both when the presenter has not gone live
 * and when nobody is entitled to a stream egress at all, and it cannot tell
 * them apart without disclosing the plan — which
 * `GET /api/meetings/[id]/livestream/stream-url` declines to do by design. This
 * component therefore does not invent a distinction either. It states the
 * observable fact, names broadcast streaming as the add-on it is, and offers a
 * "check again" that is genuinely useful for the far more common case of a
 * participant arriving before the presenter.
 *
 * A player that spun forever, or that said "unavailable" with no way to re-ask,
 * is what the alternatives produce — one is a lie about progress and the other
 * punishes the participant for arriving early.
 *
 * ## Native controls, deliberately
 *
 * No custom transport. The element gets `controls`, which brings play/pause, a
 * volume slider, fullscreen and — the reason this matters — the browser's own
 * caption switch, for free and correctly. This repo has no captions or
 * transcript surface in the meeting room to match, so there is nothing to
 * mirror; inventing a bespoke control bar here would be a new styling system
 * that the room's own Stream layout does not share. `hls.js` surfaces WebVTT
 * subtitle tracks from the playlist as native text tracks and its default
 * `enableCEA708Captions` is left alone, so a captioned broadcast works without
 * a line of code from us — provided `crossOrigin` is set, which is the one
 * thing that silently breaks it.
 */

export interface LivestreamPlayerProps {
  /**
   * The MEETING row id.
   *
   * Not the Stream call id. The call id is a call id of unknown vintage —
   * a room is rebuilt on a schedule and the URL in a participant's address bar
   * keeps pointing at the old one — and the row is what names the room that
   * exists now. The route resolves the same way.
   */
  meetingId: string;
  /** What to call the broadcast while it loads. */
  title?: string;
  /** Start playing without a press. Muted, because browsers block the rest. */
  autoPlay?: boolean;
  className?: string;
}

/**
 * Every state the box can be in.
 *
 * `HlsPlaybackState` is the engine's half, imported rather than restated so the
 * two cannot drift; the rest are decided by the route's answer, which is the
 * only thing that can tell "no stream exists" from "this browser cannot play
 * one".
 */
type PlayerState =
  HlsPlaybackState | "unavailable" | "denied" | "transient" | "unsupported";

const TITLES: Record<PlayerState, string> = {
  loading: "Getting the stream ready",
  manifest: "Starting playback",
  recovering: "Reconnecting to the stream",
  failed: "The stream stopped",
  unavailable: "No stream to watch",
  denied: "This session is not yours to watch",
  transient: "We could not reach the stream",
  unsupported: "This browser cannot play the stream",
};

interface Notice {
  state: PlayerState;
  /** Overrides {@link TITLES} when the reason is worth saying precisely. */
  detail?: string;
}

const NOTICES: Partial<Record<PlayerState, string>> = {
  unavailable:
    "This session is not being streamed at the moment. Broadcast streaming is an add-on, so if your plan does not include it there will not be a stream here either.",
  denied:
    "Only people booked into this session can watch it. If you think you should be able to, ask the practitioner who invited you.",
  transient:
    "Something on our side got in the way. Trying again usually works.",
  failed:
    "The broadcast ended or dropped. You can try again, but the presenter may have already wrapped up.",
  unsupported:
    "Your browser cannot play this kind of stream. Joining in a browser window rather than the in-app view usually works.",
  recovering:
    "The connection to the stream dropped. We are putting it back — stay on this page.",
};

export function LivestreamPlayer({
  meetingId,
  title = "Live broadcast",
  autoPlay = true,
  className,
}: Readonly<LivestreamPlayerProps>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The live attachment, kept in a ref rather than state: it is a mutable
  // external resource with no render output, and putting it in state would make
  // every attach and detach a re-render.
  const attachmentRef = useRef<HlsAttachment | null>(null);

  const [url, setUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Bumped to re-run the URL fetch after a "check again".
  const [attempt, setAttempt] = useState(0);

  const streamUrlPath = `/api/meetings/${encodeURIComponent(
    meetingId,
  )}/livestream/stream-url`;

  // ── The credential ────────────────────────────────────────────────────────
  useEffect(() => {
    // Aborted on unmount and whenever the deps change, which also covers React
    // 19's StrictMode double-invoke: the first pass is cancelled rather than
    // left to resolve into a setState on a component that has moved on.
    const controller = new AbortController();

    async function load() {
      setNotice({ state: "loading" });
      let response: Response;
      try {
        response = await fetch(streamUrlPath, {
          signal: controller.signal,
          // Belt and braces with the route's `no-store`: a proxy that drops the
          // header must not be the thing that decides a credential is
          // cacheable.
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        // A thrown fetch is the network, not the server. Retryable.
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setNotice({ state: "transient" });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
          playlistUrl?: unknown;
        } | null;
        const playlistUrl =
          typeof body?.playlistUrl === "string" ? body.playlistUrl : null;
        if (!playlistUrl) {
          setNotice({ state: "unavailable" });
          return;
        }
        setNotice(null);
        setUrl(playlistUrl);
        return;
      }

      // A 404 from this endpoint is deliberately indistinguishable between "not
      // a broadcast", "no room yet" and "no egress", so all of them land in the
      // one honest state. 403 is the membership refusal; everything else is
      // somebody else's problem and worth retrying.
      if (response.status === 404) {
        setUrl(null);
        setNotice({ state: "unavailable" });
        return;
      }
      if (response.status === 403) {
        setUrl(null);
        setNotice({ state: "denied" });
        return;
      }
      setUrl(null);
      setNotice({ state: "transient" });
    }

    void load();
    return () => controller.abort();
  }, [streamUrlPath, attempt]);

  // ── The engine ────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!url || !video) return;

    // A URL change or an unmount destroys the previous instance first, so a
    // presenter going live again does not leave two MediaSources fighting over
    // one element.
    detachHls(attachmentRef.current);
    attachmentRef.current = null;

    const controller = new AbortController();
    let cancelled = false;

    void attachHls(video, url, {
      signal: controller.signal,
      onState: (state) => {
        if (cancelled) return;
        setNotice(state === "manifest" ? null : { state });
      },
      onFatal: (kind) => {
        if (cancelled) return;
        setNotice({
          state: kind === "unsupported" ? "unsupported" : "failed",
        });
      },
    }).then((attachment) => {
      if (cancelled || controller.signal.aborted) {
        // Arrived after the component moved on, or the abort listener already
        // destroyed it. Handing it back here is what keeps the last reference
        // from outliving the element.
        detachHls(attachment);
        return;
      }
      attachmentRef.current = attachment;
    });

    return () => {
      cancelled = true;
      controller.abort();
      detachHls(attachmentRef.current);
      attachmentRef.current = null;
    };
  }, [url]);

  const retry = useCallback(() => {
    detachHls(attachmentRef.current);
    attachmentRef.current = null;
    setUrl(null);
    setAttempt((n) => n + 1);
  }, []);

  const state = notice?.state ?? "loading";
  const isSpinning = state === "loading";

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950",
        className,
      )}
    >
      {/* `aspect-video` rather than a fixed height: the box is the thing that
          stops the layout jumping when the broadcast starts, and 16:9 is the
          shape every egress is authored at. */}
      <div className="aspect-video w-full">
        {url && (
          <video
            ref={videoRef}
            // Required for MSE against a cross-origin CDN, and for the text
            // tracks to be readable at all. Without it a captioned broadcast
            // silently has no captions.
            crossOrigin="anonymous"
            autoPlay={autoPlay}
            // Autoplay only survives a browser's policy while muted, so this is
            // not a preference: an unmuted autoPlay is a video that refuses to
            // start with no explanation. The native controls give the volume
            // back the moment the viewer wants it.
            muted
            playsInline
            controls
            aria-label={title}
            className="h-full w-full bg-black"
          />
        )}

        {notice && (
          <div
            // A status region, not an alert: a broadcast that has not started is
            // a normal state of the page, and announcing it assertively on every
            // poll would interrupt whatever the viewer was doing.
            role="status"
            aria-live="polite"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950 px-6 text-center"
          >
            {isSpinning ? (
              <Loader2
                className="h-7 w-7 animate-spin text-zinc-400 motion-reduce:animate-none"
                aria-hidden
              />
            ) : state === "unavailable" ? (
              <Radio className="h-7 w-7 text-zinc-600" aria-hidden />
            ) : (
              <TriangleAlert className="h-7 w-7 text-amber-400" aria-hidden />
            )}

            <p className="text-sm font-medium text-zinc-200">
              {notice.detail ?? TITLES[state]}
            </p>
            <p className="max-w-md text-xs text-zinc-500">{NOTICES[state]}</p>

            {(state === "unavailable" || state === "transient") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={retry}
                className="mt-1 border-zinc-700 bg-transparent text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800"
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden />
                Check again
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default LivestreamPlayer;
