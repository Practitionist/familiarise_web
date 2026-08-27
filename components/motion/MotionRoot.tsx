"use client";

import { MotionConfig } from "framer-motion";

/**
 * Shared motion environment for the marketing surfaces. Wraps children in
 * MotionConfig reducedMotion="user" so every framer-motion animation in the
 * tree honours the OS reduce-motion setting.
 *
 * Server components must never import framer-motion directly — their client
 * bindings can resolve undefined during hydration ("Element type is
 * invalid"). Anything animated gets wrapped by this provider instead.
 */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
