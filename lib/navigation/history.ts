/**
 * Writes the address bar without a Next.js navigation: no RSC refetch, no
 * history entry.
 *
 * Pass `null`, never `window.history.state`. Next's patched replaceState
 * skips its router sync for state carrying `__NA`, so `useSearchParams` never
 * sees the write and the UI stays put until a reload. Next
 * copies its own entry state across either way.
 */
export function replaceUrl(target: string): void {
  window.history.replaceState(null, "", target);
}

// Adds a history entry (Back returns here); same `null`-state rule as above.
export function pushUrl(target: string): void {
  window.history.pushState(null, "", target);
}
