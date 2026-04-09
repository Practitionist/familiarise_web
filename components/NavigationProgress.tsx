"use client";

import { AppProgressBar } from "next-nprogress-bar";

/**
 * Top-of-page navigation progress bar.
 *
 * Renders a thin animated bar at the top of the viewport whenever the
 * Next.js App Router is mid-navigation. Without this, slow RSC fetches
 * (200-800ms is common) make the UI feel completely unresponsive after
 * a click — the user clicks a Link, sees nothing change for half a
 * second, and assumes the click didn't register.
 *
 * Configured to match the rest of the brand chrome (zinc-900). The
 * progress bar is purely a visual feedback layer; it does not affect
 * routing behavior in any way.
 */
export default function NavigationProgress() {
  return (
    <AppProgressBar
      color="#18181b"
      height="3px"
      shallowRouting
      options={{ showSpinner: false }}
    />
  );
}
