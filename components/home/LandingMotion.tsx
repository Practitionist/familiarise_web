"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Motion boundary for `/`. Under `reducedMotion="user"` framer-motion drops
 * transform animations and keeps opacity when the OS asks for reduced motion —
 * same as the enterprise and use-case layouts.
 */
export function LandingMotion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
