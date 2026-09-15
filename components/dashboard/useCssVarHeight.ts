"use client";

import { useCallback, useRef } from "react";

/**
 * Mirrors an element's border-box height into a root CSS variable, 0px while
 * unmounted. Lets `.h-dashboard-fill` subtract a shell banner it cannot see.
 */
export function useCssVarHeight(name: string) {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      const root = document.documentElement.style;
      if (!el) {
        root.setProperty(name, "0px");
        return;
      }
      observer.current = new ResizeObserver(([entry]) => {
        const h =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        root.setProperty(name, `${h}px`);
      });
      observer.current.observe(el);
    },
    [name],
  );
}
