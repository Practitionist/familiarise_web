"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { format } from "date-fns";

import { formatInViewerZone } from "./viewer-zone";

const DisplayZoneContext = createContext<string | null>(null);

/**
 * #1527 QA — pins every nested `useZonedFormat` to the zone the RSC page read
 * (`getViewerZone`), so the server render and hydration print one wall clock
 * instead of Netlify's UTC vs the browser's zone (hydration error #418).
 */
export function DisplayZoneProvider({
  zone,
  children,
}: Readonly<{ zone: string; children: ReactNode }>) {
  return (
    <DisplayZoneContext.Provider value={zone}>
      {children}
    </DisplayZoneContext.Provider>
  );
}

/**
 * A date-fns style `format(date, pattern)` in the provided viewer zone.
 * Without a provider it keeps the runtime zone, the pre-#1527 behaviour of
 * the surfaces that have not been seeded with a zone yet.
 */
export function useZonedFormat(): (
  date: Date | string | number,
  pattern: string,
) => string {
  const zone = useContext(DisplayZoneContext);
  return useCallback(
    (date: Date | string | number, pattern: string) =>
      zone
        ? formatInViewerZone(date, zone, pattern)
        : format(new Date(date), pattern),
    [zone],
  );
}
