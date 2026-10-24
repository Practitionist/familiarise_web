"use client";

import { ScreenShareButton } from "@stream-io/video-react-sdk";

/** Feature-detected, never user-agent sniffed: iOS Safari has no `getDisplayMedia`. */
export function canShareScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getDisplayMedia)
  );
}

/** The SDK's screen-share toggle, rendered only where the browser can capture a screen. */
export function ScreenShareControl() {
  if (!canShareScreen()) return null;
  return <ScreenShareButton />;
}
