"use client";

import { createContext, useContext } from "react";

/** Open appointment-waitlist rows on the plan being edited; 0 when none or not a group event. */
const WaitingCountContext = createContext(0);

export const WaitingCountProvider = WaitingCountContext.Provider;

export function useWaitingCount(): number {
  return useContext(WaitingCountContext);
}
