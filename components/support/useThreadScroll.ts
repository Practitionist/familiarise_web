"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Within this many pixels of the end counts as "reading the latest message". */
const BOTTOM_SLOP = 48;

export interface ScrollAnchor {
  scrollHeight: number;
  scrollTop: number;
}

/** After older rows are prepended, keep the same rows under the reader's eye. */
export function prependedScrollTop(
  before: ScrollAnchor,
  scrollHeight: number,
): number {
  return Math.max(0, scrollHeight - before.scrollHeight + before.scrollTop);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Scroll anchoring for a conversation log: scrolls the container itself (never the
 * page), follows new messages only when the reader is already at the bottom, and
 * keeps position when older messages are prepended.
 */
export function useThreadScroll<T extends HTMLElement>(
  resetKey: string,
  contentVersion: string | number,
) {
  const container = useRef<T | null>(null);
  const atBottom = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const settledKey = useRef<string | null>(null);

  const onScroll = useCallback(() => {
    const el = container.current;
    if (!el) return;
    atBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLOP;
  }, []);

  const beforePrepend = useCallback(() => {
    const el = container.current;
    if (el)
      anchor.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
  }, []);

  const cancelPrepend = useCallback(() => {
    anchor.current = null;
  }, []);

  /** Loads older rows with the reader's position preserved. */
  const loadOlderAnchored = useCallback(
    async (loadOlder: () => Promise<boolean>) => {
      beforePrepend();
      if (!(await loadOlder())) cancelPrepend();
    },
    [beforePrepend, cancelPrepend],
  );

  useIsomorphicLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = prependedScrollTop(anchor.current, el.scrollHeight);
      anchor.current = null;
      return;
    }
    const first = settledKey.current !== resetKey;
    settledKey.current = resetKey;
    if (!first && !atBottom.current) return;
    atBottom.current = true;
    if (first || prefersReducedMotion() || typeof el.scrollTo !== "function")
      el.scrollTop = el.scrollHeight;
    else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [resetKey, contentVersion]);

  return { container, onScroll, beforePrepend, loadOlderAnchored };
}
