"use client";

import { useEffect, useState } from "react";

/** The longest delay `setTimeout` honours; a later instant would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Re-renders once just after `at`, so an action gated on that instant leaves on time. */
export function useRerenderAfter(at: Date | string | null) {
  const [, setTick] = useState(0);
  const target = at ? new Date(at).getTime() : null;
  useEffect(() => {
    if (target === null) return;
    const delay = target - Date.now() + 1;
    if (delay <= 0 || delay > MAX_TIMER_MS) return;
    const id = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(id);
  }, [target]);
}
