/**
 * Occurrence fixtures for the consultant no-show detector. Fixed UTC dates keep
 * the classifier's incident and occurrence-window checks deterministic.
 */

export const CONSULTANT_USER = "user-consultant";
export const CONSULTEE_USER = "user-consultee";

type Presence = { userId: string; joinedAt: Date; leftAt: Date };

type Meeting = {
  endedAt: Date;
  endedReason: string;
  streamCallId: string;
  attendances: { userId: string }[];
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
  presences: Presence[];
  meeting: Meeting;
};

type OccurrenceOverrides = Partial<Omit<NoShowOccurrence, "meeting">> & {
  meeting?: Partial<Meeting>;
};

function baseMeeting(): Meeting {
  return {
    endedAt: new Date("2026-09-01T11:00:00Z"),
    endedReason: "call_ended",
    streamCallId: "slot-cons-1",
    attendances: [{ userId: CONSULTEE_USER }],
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
    presences: [
      {
        userId: CONSULTEE_USER,
        joinedAt: new Date("2026-09-01T10:00:00Z"),
        leftAt: new Date("2026-09-01T11:00:00Z"),
      },
    ],
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
      presences: [
        {
          userId: CONSULTEE_USER,
          joinedAt: new Date("2026-09-08T10:00:00Z"),
          leftAt: new Date("2026-09-08T11:00:00Z"),
        },
      ],
      meeting: {
        endedAt: new Date("2026-09-08T11:00:00Z"),
        streamCallId: "slot-new",
      },
    }),
  ];
}
