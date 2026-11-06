"use client";

import { useEffect, useRef } from "react";

/**
 * Scrolls the element `id` into view once `ready` is true, when the URL hash
 * names it. Runs once per mount; smooth unless the viewer prefers reduced motion.
 */
export function useScrollToHashOnReady(
  id: string | undefined,
  ready: boolean,
): void {
  const done = useRef(false);

  useEffect(() => {
    if (!id || !ready || done.current) return;
    if (window.location.hash !== `#${id}`) return;
    const el = document.getElementById(id);
    if (!el) return;
    done.current = true;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [id, ready]);
}
