"use client";

import { useCallback, useRef, useState } from "react";

/**
 * A callback ref and how many of the ascending `steps` (px) that element's
 * content box reaches; 0 until measured, and always where ResizeObserver is absent (jsdom).
 */
export function useWidthStep<T extends HTMLElement>(steps: readonly number[]) {
  const observer = useRef<ResizeObserver | null>(null);
  const [step, setStep] = useState(0);
  const ref = useCallback(
    (el: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(([entry]) => {
        const width = entry.contentRect.width;
        setStep(steps.filter((min) => width >= min).length);
      });
      observer.current.observe(el);
    },
    [steps],
  );
  return [ref, step] as const;
}
