// "Add to calendar" for a booking, built in the browser and by the signed .ics route. Times are
// UTC (`Z`), which every calendar converts to the reader's zone; `zone` rides as `X-WR-TIMEZONE`.

export interface IcsSession {
  /** The entry's identity; {@link icsSessionId} keeps it the same across a move. */
  id: string;
  startsAt: Date;
  endsAt: Date | null;
  /** Rises with each change to the session, so a re-import replaces the entry. */
  sequence?: number;
  /** The session was cancelled: the entry is marked so, never dropped. */
  cancelled?: boolean;
}

/**
 * A session's calendar identity: its booking and its ordinal. A moved session
 * is a new row that inherits the ordinal, so the entry survives the move.
 */
export function icsSessionId(appointmentId: string, ordinal: number): string {
  return `${appointmentId}-${ordinal}`;
}

/** One occurrence row of a booking, as the calendar reads it. */
export interface IcsOccurrence {
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  updatedAt: Date;
  cancelled: boolean;
}

/** A booking's occurrence row, read from the database or from its JSON. */
export interface IcsRow {
  ordinal: number;
  startsAt: Date | string;
  endsAt: Date | string | null;
  updatedAt: Date | string;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | string | null;
}

/**
 * The rows every calendar file of a booking is built from: sessions still
 * ahead that are on, and cancelled ones so their entries are withdrawn.
 */
export function calendarOccurrences(
  rows: readonly IcsRow[],
  now: Date = new Date(),
): IcsOccurrence[] {
  return rows
    .filter(
      (row) =>
        !row.isTentative &&
        new Date(row.startsAt).getTime() > now.getTime() &&
        (row.completionStatus === "SCHEDULED" ||
          row.completionStatus === "CANCELLED"),
    )
    .map((row) => ({
      ordinal: row.ordinal,
      startsAt: new Date(row.startsAt),
      endsAt: row.endsAt ? new Date(row.endsAt) : null,
      updatedAt: new Date(row.updatedAt),
      cancelled: row.completionStatus === "CANCELLED" || !!row.deletedAt,
    }));
}

/**
 * One entry per session of the booking: the live row of each ordinal, else its
 * latest cancelled one. The sequence is the session's latest change in whole
 * seconds, across every row that carried the ordinal.
 */
export function icsSessions(
  appointmentId: string,
  rows: readonly IcsOccurrence[],
): IcsSession[] {
  const byOrdinal = new Map<number, IcsOccurrence[]>();
  for (const row of rows) {
    byOrdinal.set(row.ordinal, [...(byOrdinal.get(row.ordinal) ?? []), row]);
  }
  return [...byOrdinal.entries()]
    .map(([ordinal, sameSession]) => {
      const latestFirst = [...sameSession].sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
      );
      const shown = latestFirst.find((row) => !row.cancelled) ?? latestFirst[0];
      return {
        id: icsSessionId(appointmentId, ordinal),
        startsAt: shown.startsAt,
        endsAt: shown.endsAt,
        sequence: Math.floor(latestFirst[0].updatedAt.getTime() / 1000),
        cancelled: shown.cancelled,
      };
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export interface IcsInput {
  title: string;
  description?: string;
  /** Absolute URL of the booking, so the event links back to it. */
  url?: string;
  sessions: IcsSession[];
  /** IANA zone of the viewer, e.g. "Asia/Kolkata". */
  zone: string;
  now?: Date;
}

/** A session without an end is booked for this long. */
const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

/** The session's end, or its start plus the default length when it has none. */
export function sessionEnd(startsAt: Date, endsAt: Date | null): Date {
  return endsAt ?? new Date(startsAt.getTime() + DEFAULT_LENGTH_MS);
}

/** A UTC date-time in the basic format calendars read, e.g. `20261107T093000Z`. */
export function stamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** RFC 5545 §3.3.11 text escaping. */
function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", String.raw`\;`)
    .replaceAll(",", String.raw`\,`)
    .replaceAll(/\r?\n/g, String.raw`\n`);
}

const MAX_LINE_OCTETS = 75;

/** UTF-8 octets of one code point; computed so the browser and the server agree without an encoder. */
function utf8Octets(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

/** RFC 5545 §3.1: split a content line over 75 octets with CRLF + space, never inside a character. */
function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = utf8Octets(char);
    // A continuation line spends one octet on its leading space.
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildIcs({
  title,
  description,
  url,
  sessions,
  zone,
  now = new Date(),
}: IcsInput): string {
  // A file of nothing but cancelled sessions withdraws them (RFC 5546 CANCEL).
  const cancelsAll =
    sessions.length > 0 && sessions.every((session) => session.cancelled);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Familiarise//Appointments//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelsAll ? "CANCEL" : "PUBLISH"}`,
    `X-WR-TIMEZONE:${zone}`,
  ];
  for (const session of sessions) {
    const end = sessionEnd(session.startsAt, session.endsAt);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.id}@familiarise`,
      `DTSTAMP:${stamp(now)}`,
      `SEQUENCE:${session.sequence ?? 0}`,
      `STATUS:${session.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      `DTSTART:${stamp(session.startsAt)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${escapeText(title)}`,
      ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
      ...(url ? [`URL:${url}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 lines end in CRLF.
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
