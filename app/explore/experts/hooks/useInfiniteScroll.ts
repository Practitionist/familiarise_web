"use client";

import { useEffect, useRef } from "react";

interface UseInfiniteScrollOptions {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  /** IntersectionObserver root margin. Defaults to no preload. */
  rootMargin?: string;
}

/**
 * Attaches an IntersectionObserver to a sentinel element and triggers
 * `onLoadMore` whenever it scrolls into view.
 *
 * Uses `useEffect` (not a callback ref) so the observer is set up exactly
 * once per (`hasMore`, `isLoading`) transition. The previous implementation
 * tore down and rebuilt the observer on every render, which was both
 * over-eager and racy.
 *
 * Designed to be generic enough that the programs page (which currently
 * duplicates the same observer logic) can adopt it in a follow-up PR.
 */
export function useInfiniteScroll({
  hasMore,
  isLoading,
  onLoadMore,
  rootMargin = "0px",
}: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Stable callback reference inside the observer so we don't have to put
  // `onLoadMore` in the effect deps (which would force the observer to
  // tear down whenever the parent re-renders with a new callback identity).
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (!hasMore || isLoading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoading, rootMargin]);

  return sentinelRef;
}
