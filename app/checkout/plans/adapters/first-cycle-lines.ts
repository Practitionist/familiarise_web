import {
  firstCycleWindow,
  lastInstantBefore,
  type EntitlementPlanShape,
} from "@/lib/booking/entitlement";
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";

const DATE_PATTERN = "d MMM yyyy";

/**
 * "Starts" and "First cycle" as checkout prints them: cut and printed in the
 * zone the server persists the first cycle in, labelled with that zone.
 */
export function firstCycleLines(
  startIso: string,
  plan: EntitlementPlanShape,
  zone: string,
): { starts: string; cycle: string; end: Date } {
  const window = firstCycleWindow(plan, new Date(startIso), zone);
  const day = (at: Date) => formatInViewerZone(at, zone, DATE_PATTERN);
  const label = zoneLabel(window.start, zone);
  return {
    starts: `${day(window.start)} ${label}`,
    cycle: `${day(window.start)} → ${day(lastInstantBefore(window.end))} ${label}`,
    end: window.end,
  };
}
