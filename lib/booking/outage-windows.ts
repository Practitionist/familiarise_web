/**
 * Outage windows as the classifier and the evidence judgement read them: the
 * platform's maintenance windows and declared incidents, tagged by source.
 */
import type { Tx } from "@/lib/prisma";
import type { OutageWindow } from "./session-outcome";

export const OUTAGE_SELECTS = {
  maintenance: { startedAt: true, endedAt: true },
  incident: { startsAt: true, endsAt: true },
} as const;

/** Both sources' rows as tagged outage windows. */
export function toOutageWindows(
  rows: { startedAt: Date | null; endedAt: Date | null }[],
  incidents: { startsAt: Date; endsAt: Date }[],
): OutageWindow[] {
  return [
    ...rows
      .filter((r): r is { startedAt: Date; endedAt: Date | null } =>
        Boolean(r.startedAt),
      )
      .map((r) => ({
        startsAt: r.startedAt,
        endsAt: r.endedAt,
        source: "maintenance" as const,
      })),
    ...incidents.map((i) => ({
      startsAt: i.startsAt,
      endsAt: i.endsAt,
      source: "incident" as const,
    })),
  ];
}

/**
 * Every maintenance window and declared incident that overlaps one of the
 * booked windows, with no row cap: one read per source, an OR of the windows.
 * Safe on a transaction client.
 */
export async function readOverlappingOutages(
  db: Pick<Tx, "maintenanceWindow" | "platformIncident">,
  windows: readonly { startsAt: Date; endsAt: Date }[],
): Promise<OutageWindow[]> {
  const distinct = [
    ...new Map(
      windows.map((w) => [`${w.startsAt.getTime()}|${w.endsAt.getTime()}`, w]),
    ).values(),
  ];
  if (distinct.length === 0) return [];
  // Sequential: a caller's transaction runs one statement at a time.
  const rows = await db.maintenanceWindow.findMany({
    where: {
      organizationId: null,
      // An ended window flips to OFF, so only an open one is read by phase.
      OR: distinct.map((w) => ({
        startedAt: { lt: w.endsAt },
        OR: [
          { endedAt: null, phase: { not: "OFF" as const } },
          { endedAt: { gt: w.startsAt } },
        ],
      })),
    },
    select: OUTAGE_SELECTS.maintenance,
  });
  const incidents = await db.platformIncident.findMany({
    where: {
      OR: distinct.map((w) => ({
        startsAt: { lt: w.endsAt },
        endsAt: { gt: w.startsAt },
      })),
    },
    select: OUTAGE_SELECTS.incident,
  });
  return toOutageWindows(rows, incidents);
}
