import prisma from "@/lib/prisma";

/** Maximum billable minutes attributed to a single device presence interval (4 hours). */
export const MAX_INTERVAL_MINUTES = 240;

/** Stream video pricing per 1,000 participant-minutes at 480p (1:1 sessions). */
export const RATE_PER_1000_PM_480P_USD = 0.75;

/** Stream video pricing per 1,000 participant-minutes at 720p (webinars & classes). */
export const RATE_PER_1000_PM_720P_USD = 1.5;

export interface StreamUsageEstimate {
  from: Date;
  to: Date;
  totalIntervals: number;
  oneOnOneParticipantMinutes: number;
  groupParticipantMinutes: number;
  totalParticipantMinutes: number;
  estimatedCostUsd: number;
}

export interface EstimateStreamUsageOptions {
  from: Date;
  to: Date;
  now?: Date;
}

/**
 * Estimates Stream Video participant-minutes and USD cost over `[from, to]`
 * from recorded `MeetingPresence` intervals.
 *
 * When a participant's `leftAt` webhook is missing, the effective end falls back
 * to `meeting.endedAt`, then `occurrence.endsAt`, then `now`, capped at
 * `MAX_INTERVAL_MINUTES` so unclosed intervals cannot inflate cost estimates.
 */
export async function estimateStreamVideoUsage(
  options: EstimateStreamUsageOptions,
): Promise<StreamUsageEstimate> {
  const { from, to, now = new Date() } = options;

  const rows = await prisma.meetingPresence.findMany({
    where: {
      joinedAt: {
        lte: to,
      },
    },
    include: {
      meeting: {
        select: {
          endedAt: true,
        },
      },
      occurrence: {
        select: {
          endsAt: true,
          appointment: {
            select: {
              consultationId: true,
              subscriptionId: true,
              webinarId: true,
              classId: true,
            },
          },
        },
      },
    },
  });

  let oneOnOneParticipantMinutes = 0;
  let groupParticipantMinutes = 0;
  let totalIntervals = 0;

  for (const row of rows) {
    const effectiveLeftAt =
      row.leftAt ?? row.meeting?.endedAt ?? row.occurrence?.endsAt ?? now;
    const intervalStart = row.joinedAt > from ? row.joinedAt : from;
    const intervalEnd = effectiveLeftAt < to ? effectiveLeftAt : to;
    if (intervalEnd <= intervalStart) {
      continue;
    }
    totalIntervals += 1;
    const rawMinutes =
      (intervalEnd.getTime() - intervalStart.getTime()) / 60_000;
    const durationMinutes = Math.min(
      MAX_INTERVAL_MINUTES,
      Math.max(0, rawMinutes),
    );

    const appointment = row.occurrence?.appointment;
    const isGroupEvent = Boolean(
      appointment?.webinarId || appointment?.classId,
    );

    if (isGroupEvent) {
      groupParticipantMinutes += durationMinutes;
    } else {
      oneOnOneParticipantMinutes += durationMinutes;
    }
  }

  const totalParticipantMinutes =
    oneOnOneParticipantMinutes + groupParticipantMinutes;
  const estimatedCostUsd =
    (oneOnOneParticipantMinutes / 1000) * RATE_PER_1000_PM_480P_USD +
    (groupParticipantMinutes / 1000) * RATE_PER_1000_PM_720P_USD;

  return {
    from,
    to,
    totalIntervals,
    oneOnOneParticipantMinutes:
      Math.round(oneOnOneParticipantMinutes * 100) / 100,
    groupParticipantMinutes: Math.round(groupParticipantMinutes * 100) / 100,
    totalParticipantMinutes: Math.round(totalParticipantMinutes * 100) / 100,
    estimatedCostUsd: Math.round(estimatedCostUsd * 10_000) / 10_000,
  };
}
