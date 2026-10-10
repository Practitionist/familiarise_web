/**
 * The recordings a viewer may play from their own sessions, shared by the
 * consultee resources read and the org Library's Mine view (#1527) so the
 * #1819 late-join rule has one enforcement point.
 */

import {
  hiddenFromLateJoiner,
  type LateJoinAccess,
} from "@/lib/stream/late-join-recordings";

export interface LateJoinScope {
  access: LateJoinAccess;
  classId: string;
  classPlanId: string;
}

interface SessionWithRecordings<R> {
  occurrences: { startsAt: Date; meeting?: { recordings: R[] } | null }[];
}

/**
 * Every recording on the sessions' occurrences, minus the ones a late
 * joiner's seat hides (host toggle, #1819).
 */
export function visibleSessionRecordings<R>(
  appointments: SessionWithRecordings<R>[],
  lateJoinScope?: LateJoinScope,
): R[] {
  return appointments.flatMap((apt) =>
    apt.occurrences.flatMap((slot) => {
      if (
        lateJoinScope &&
        hiddenFromLateJoiner(
          {
            meeting: {
              occurrence: {
                startsAt: slot.startsAt,
                appointment: {
                  classId: lateJoinScope.classId,
                  class: { classPlanId: lateJoinScope.classPlanId },
                },
              },
            },
          },
          lateJoinScope.access,
        )
      ) {
        return [];
      }
      return slot.meeting?.recordings ?? [];
    }),
  );
}

/** The visible recordings as list rows; playback is fetched per play from GET /api/stream/recordings/[id]. */
export function extractRecordings<
  R extends {
    id: string;
    title: string;
    durationInMinutes: number;
    recordedAt: Date;
    thumbnailUrl: string | null;
    status: string;
  },
>(
  appointments: SessionWithRecordings<R>[],
  lateJoinScope?: LateJoinScope,
): Pick<
  R,
  | "id"
  | "title"
  | "durationInMinutes"
  | "recordedAt"
  | "thumbnailUrl"
  | "status"
>[] {
  return visibleSessionRecordings(appointments, lateJoinScope).map((rec) => ({
    id: rec.id,
    title: rec.title,
    durationInMinutes: rec.durationInMinutes,
    recordedAt: rec.recordedAt,
    thumbnailUrl: rec.thumbnailUrl,
    status: rec.status,
  }));
}
