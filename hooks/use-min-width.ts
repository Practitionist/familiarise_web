"use client";

import { useCallback, useRef, useState } from "react";

/**
 * A callback ref and whether that element's content box is at least `minPx`
 * wide; false until measured, and always where ResizeObserver is absent (jsdom).
 */
export function useMinWidth<T extends HTMLElement>(minPx: number) {
  const observer = useRef<ResizeObserver | null>(null);
  const [atLeast, setAtLeast] = useState(false);
  const ref = useCallback(
    (el: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(([entry]) => {
        setAtLeast(entry.contentRect.width >= minPx);
      });
      observer.current.observe(el);
    },
    [minPx],
  );
  return [ref, atLeast] as const;
}
