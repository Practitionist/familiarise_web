"use client";

import { createContext, useContext } from "react";

export interface WaitingCounts {
  /** Open waitlist rows across the plan; null while the count is loading or failed. */
  plan: number | null;
  /** Open waitlist rows on the instance being edited; 0 when unknown. */
  instance: number;
}

const WaitingCountContext = createContext<WaitingCounts>({
  plan: 0,
  instance: 0,
});

export const WaitingCountProvider = WaitingCountContext.Provider;

export function useWaitingCounts(): WaitingCounts {
  return useContext(WaitingCountContext);
}
