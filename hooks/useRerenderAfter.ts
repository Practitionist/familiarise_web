"use client";

import { useEffect, useReducer } from "react";

/** The longest delay `setTimeout` honours; a later instant would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Re-renders once just after `at`, so an action gated on that instant leaves on time. */
export function useRerenderAfter(at: Date | string | null) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const target = at ? new Date(at).getTime() : null;
  useEffect(() => {
    if (target === null) return;
    const delay = target - Date.now() + 1;
    if (delay <= 0 || delay > MAX_TIMER_MS) return;
    const id = setTimeout(rerender, delay);
    return () => clearTimeout(id);
  }, [target]);
}
