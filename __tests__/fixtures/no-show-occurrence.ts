/**
 * Occurrence fixtures for the consultant no-show detector. Fixed UTC dates keep
 * the classifier's incident and occurrence-window checks deterministic.
 */

export const CONSULTANT_USER = "user-consultant";
export const CONSULTEE_USER = "user-consultee";

type Presence = { userId: string; joinedAt: Date; leftAt: Date };

type Meeting = {
  id: string;
  endedAt: Date;
  endedReason: string;
  streamCallId: string;
  extendedSeconds: number;
  attendanceSettledAt: Date | null;
  /** What Stream's settled record of the call holds; the test's settle mock answers it. */
  stays: Presence[];
};

export type NoShowOccurrence = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  completionStatus: string;
  outcome: string | null;
  deletedAt: Date | null;
  isTentative: boolean;
  seatsSettledAt: Date | null;
  meeting: Meeting;
};

type OccurrenceOverrides = Partial<Omit<NoShowOccurrence, "meeting">> & {
  meeting?: Partial<Meeting>;
};

function baseMeeting(): Meeting {
  return {
    id: "meeting-1",
    endedAt: new Date("2026-09-01T11:00:00Z"),
    endedReason: "call_ended",
    streamCallId: "slot-cons-1",
    extendedSeconds: 0,
    attendanceSettledAt: null,
    stays: [
      {
        userId: CONSULTEE_USER,
        joinedAt: new Date("2026-09-01T10:00:00Z"),
        leftAt: new Date("2026-09-01T11:00:00Z"),
      },
    ],
  };
}

export function noShowOccurrence(
  overrides: OccurrenceOverrides = {},
): NoShowOccurrence {
  const { meeting, ...rest } = overrides;
  return {
    id: "occ-1",
    startsAt: new Date("2026-09-01T10:00:00Z"),
    endsAt: new Date("2026-09-01T11:00:00Z"),
    completionStatus: "SCHEDULED",
    outcome: null,
    deletedAt: null,
    isTentative: false,
    seatsSettledAt: null,
    ...rest,
    meeting: { ...baseMeeting(), ...meeting },
  };
}

/** The original voided slot plus the live rebooked slot an incident created. */
export function rebookedOccurrences(): NoShowOccurrence[] {
  return [
    noShowOccurrence({
      id: "occ-old",
      completionStatus: "VOIDED",
      outcome: "PLATFORM_OUTAGE",
      seatsSettledAt: new Date("2026-09-02T09:00:00Z"),
      meeting: { streamCallId: "slot-old" },
    }),
    noShowOccurrence({
      id: "occ-new",
      startsAt: new Date("2026-09-08T10:00:00Z"),
      endsAt: new Date("2026-09-08T11:00:00Z"),
      meeting: {
        endedAt: new Date("2026-09-08T11:00:00Z"),
        streamCallId: "slot-new",
        stays: [
          {
            userId: CONSULTEE_USER,
            joinedAt: new Date("2026-09-08T10:00:00Z"),
            leftAt: new Date("2026-09-08T11:00:00Z"),
          },
        ],
      },
    }),
  ];
}
