"use client";

import { useEffect, useState } from "react";

/**
 * Returns a `Date` that ticks every `intervalMs` (default 30s) so time-gated
 * UI affordances (Join buttons, proximity labels, live session states) update
 * automatically without requiring a page reload.
 */
export function useNowTick(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
