"use client";

import { type PropsWithChildren, useCallback } from "react";
import { BackgroundFiltersProvider, useCall } from "@stream-io/video-react-sdk";

import { toast } from "@/components/ui/use-toast";

/**
 * Where the background-filter engine gets its model and WASM from.
 *
 * The SDK defaults to `https://unpkg.com/@stream-io/video-filters-web@…`, i.e.
 * a third-party CDN fetched at runtime by every participant. We copy the same
 * files out of node_modules into `public/mediapipe` at install time (see the
 * `postinstall` chain) and point the provider at ourselves, which keeps the CSP
 * `connect-src` closed and removes a third party from the call path. The assets
 * are version-matched to the installed SDK by construction, because they are
 * copied from it.
 */
const MEDIAPIPE_BASE_PATH = "/mediapipe";

/**
 * Background filters for the meeting surface (#1134).
 *
 * Mounted around the lobby AND the room so the filter registered on
 * `call.camera` survives the hand-off between them — the provider unmounting in
 * between would unregister it and the blur would drop the moment you joined.
 *
 * Cost note: mounting this provider eagerly fetches only the 250KB segmentation
 * model. The 9.6MB WASM fileset is fetched by MediaPipe itself on first use, so
 * a participant who never turns blur on never pays for it.
 *
 * Safari is deliberately NOT force-enabled. The SDK excludes it because Safari
 * throttles background timers and the filtered frame rate collapses to a freeze
 * — `forceSafariSupport` would ship a broken camera to those users rather than
 * the honest "not available on this browser".
 */
export function CallFiltersProvider({ children }: PropsWithChildren) {
  const call = useCall();

  // The SDK unregisters a failed filter itself and says nothing. Without this
  // the user is left transmitting an unfiltered picture of their room believing
  // it is blurred — so the camera goes off and they are told.
  const handleFilterError = useCallback(
    (error: unknown) => {
      console.error("Background filter failed", error);
      void call?.camera.disable();
      toast({
        title: "Background blur stopped",
        description:
          "We could not keep the blur running, so your camera has been turned off. Turn it back on when you are ready.",
        variant: "destructive",
      });
    },
    [call],
  );

  return (
    <BackgroundFiltersProvider
      basePath={MEDIAPIPE_BASE_PATH}
      onError={handleFilterError}
    >
      {children}
    </BackgroundFiltersProvider>
  );
}
