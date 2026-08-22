"use client";

import { ReactLenis } from "lenis/react";

import { MotionRoot } from "./MotionRoot";

/**
 * Inertial smooth scrolling + shared motion config for the marketing surfaces
 * (landing, explore). Scoped per page tree rather than the root layout so
 * dashboard/app routes keep native scrolling. Lenis drives window scroll, so
 * sticky positioning, anchor links and scroll restoration all keep working.
 */
export function SmoothScroll({ children }: { children: React.ReactNode }) {
  return (
    <MotionRoot>
      <ReactLenis
        root
        options={{
          lerp: 0.11,
          smoothWheel: true,
          // Let touch devices use their native momentum — synthesised inertia
          // on mobile feels laggy and fights pull-to-refresh.
          syncTouch: false,
        }}
      >
        {children}
      </ReactLenis>
    </MotionRoot>
  );
}
