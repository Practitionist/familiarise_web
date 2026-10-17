"use client";

import { useEffect, useRef, type RefObject } from "react";

export function useInitialFilterScroll(
  targetRef: RefObject<HTMLElement | null>,
  targetHash: string,
  filterKeys: readonly string[],
) {
  const hasInitialScrollRef = useRef(false);

  useEffect(() => {
    if (hasInitialScrollRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const hasFilterParam = filterKeys.some((key) => params.has(key));
    if (window.location.hash === targetHash || hasFilterParam) {
      hasInitialScrollRef.current = true;
      requestAnimationFrame(() => {
        targetRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  }, [targetRef, targetHash, filterKeys]);
}
