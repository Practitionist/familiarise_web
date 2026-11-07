// "Add to calendar" for a booking, built in the browser and by the signed .ics route. Times are
// UTC (`Z`), which every calendar converts to the reader's zone; `zone` rides as `X-WR-TIMEZONE`.

export interface IcsSession {
  id: string;
  startsAt: Date;
  endsAt: Date | null;
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
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Familiarise//Appointments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-TIMEZONE:${zone}`,
  ];
  for (const session of sessions) {
    const end = sessionEnd(session.startsAt, session.endsAt);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.id}@familiarise`,
      `DTSTAMP:${stamp(now)}`,
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
