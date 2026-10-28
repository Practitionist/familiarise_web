/**
 * Server half of `lib/appointments/normalize.ts`: what a reader found wrong
 * with stored booking rows becomes one standing finding per kind and id per
 * day, never one per row or per page view.
 */
import { reportSentryError } from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { isDeadOccurrence } from "./occurrences";
import {
  anomalyCollector,
  normalizeOccurrences,
  sessionGapOf,
  type AppointmentAnomaly,
  type AppointmentAnomalyKind,
  type TimedRow,
} from "./normalize";

const KIND_TEXT: Record<AppointmentAnomalyKind, string> = {
  UNREADABLE_TIME: "session(s) with an unreadable start or end",
  ENDS_BEFORE_START: "session(s) ending at or before their start",
  OVERLONG_SESSION: "session(s) longer than any bookable window",
  NO_LIVE_SESSION: "approved booking(s) with no live session",
};

/**
 * Reports `anomalies` grouped by kind through `reportStandingFinding`. Never
 * throws, so a reader can fire it without awaiting; call it outside any
 * transaction.
 */
export async function reportAppointmentAnomalies(
  anomalies: readonly AppointmentAnomaly[],
  op: string,
): Promise<void> {
  const idsByKind = new Map<AppointmentAnomalyKind, string[]>();
  for (const { kind, id } of anomalies) {
    idsByKind.set(kind, [...(idsByKind.get(kind) ?? []), id]);
  }
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      const message = `${ids.length} ${KIND_TEXT[kind]} seen by ${op}`;
      try {
        await reportStandingFinding(
          { key: `appointment-data:${kind}`, ids, message },
          () =>
            reportSentryError(new Error(message), {
              subsystem: "bookings",
              op,
              level: "warning",
              extra: { kind, count: ids.length, ids: ids.slice(0, 20) },
            }),
        );
      } catch (err) {
        console.warn(`[appointment-data] ${kind} report failed:`, err);
      }
    }),
  );
}

/**
 * Runs the report after the response is sent; nothing found, nothing
 * scheduled. `after-safe` loads lazily so client-rendered readers that import
 * this module never pull `next/server` in.
 */
export function scheduleAnomalyReport(
  anomalies: readonly AppointmentAnomaly[],
  op: string,
): void {
  if (anomalies.length === 0) return;
  void import("@/lib/api/after-safe")
    .then(({ scheduleAfter }) =>
      scheduleAfter(
        () => reportAppointmentAnomalies(anomalies, op),
        `appointment-data:${op}`,
      ),
    )
    .catch((err: unknown) => {
      console.warn(`[appointment-data] ${op} report not scheduled:`, err);
    });
}

/** The stored shape a booking reader has in hand. */
export interface BookingRowForAnomalies {
  id: string;
  appointmentType: string;
  occurrences: Array<
    TimedRow & {
      completionStatus?: string | null;
      deletedAt?: Date | string | null;
    }
  >;
  consultation?: { status: string } | null;
  subscription?: { status: string } | null;
}

/**
 * Everything wrong with these rows that a reader should not absorb in silence:
 * impossible session times and, when the caller knows which rows have an open
 * reschedule proposal (`openRescheduleIds`), an approved consultation or
 * subscription with no live session and no proposal to re-time it. A plan
 * awaiting its first session is not a finding.
 */
export function bookingAnomalies(
  rows: readonly BookingRowForAnomalies[],
  opts: { openRescheduleIds?: ReadonlySet<string> } = {},
): AppointmentAnomaly[] {
  const { sink, anomalies } = anomalyCollector();
  const { openRescheduleIds } = opts;
  for (const row of rows) {
    const readable = normalizeOccurrences(row.occurrences, sink);
    const status = (row.consultation ?? row.subscription)?.status;
    if (!openRescheduleIds || openRescheduleIds.has(row.id)) continue;
    if (status !== "APPROVED") continue;
    const gap = sessionGapOf({
      kind: row.appointmentType,
      rows: readable.length,
      liveRows: readable.filter((o) => !isDeadOccurrence(o)).length,
    });
    if (gap === "NEEDS_RESCHEDULING")
      sink({ kind: "NO_LIVE_SESSION", id: row.id });
  }
  return anomalies();
}
